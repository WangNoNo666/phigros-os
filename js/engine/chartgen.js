// js/engine/chartgen.js
// 程序化谱面生成器（纯函数，零依赖，node 下可直接测试）。
// 设计要点：
//   1. 使用自实现的 mulberry32 确定性 PRNG，绝不使用 Math.random；
//      同一 seed 必定产出逐字节相同的结果，方便测试与人工核对。
//   2. 所有音符时间都落在 BPM 网格上（1/8 拍为最小网格），
//      放置步长永远是网格的整数倍，保证听感与节奏对齐。
//   3. 谱面不变量（时间严格递增、x 在 [0,1]、同 lane 间隔 >= 0.09 秒、
//      hold 时长 0.2~3 秒）由 sanitizeNotes 统一收口，生成器内部也尽量不违规。

// ---------------------------------------------------------------- 基础工具

/** 数值夹取 */
export function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : (n > hi ? hi : n);
}

function num(v, fallback, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (lo === undefined) return n;
  return clamp(n, lo, hi);
}

function int(v, fallback, lo, hi) {
  const n = Math.round(Number(v));
  if (!Number.isFinite(n)) return fallback;
  return Math.round(clamp(n, lo, hi));
}

/** 保留 6 位小数，避免浮点尾巴污染网格断言 */
export function round6(v) {
  return Math.round(Number(v) * 1e6) / 1e6;
}

/** 保留 3 位小数（hold 时长用） */
export function round3(v) {
  return Math.round(Number(v) * 1e3) / 1e3;
}

/**
 * mulberry32：32 位确定性伪随机数发生器。
 * @param {number} seed 任意整数
 * @returns {() => number} 返回 [0,1) 的随机数函数
 */
export function mulberry32(seed) {
  let a = (Math.floor(Number(seed)) >>> 0) || 0x9e3779b9;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** lane 中心 x：x = (lane + 0.5) / laneCount */
export function xOfLane(lane, laneCount) {
  const n = Math.max(2, int(laneCount, 4, 2, 8));
  const l = int(lane, 0, 0, n - 1);
  return round6((l + 0.5) / n);
}

/** 由 x 反推 lane：与引擎 laneOf 完全一致 */
export function laneOf(x, laneCount) {
  const n = Math.max(2, int(laneCount, 4, 2, 8));
  const v = clamp(x, 0, 0.999999);
  return Math.min(n - 1, Math.max(0, Math.floor(v * n)));
}

/** 把时间量化到 BPM 网格（div 表示每拍切几份，8 = 1/8 拍） */
export function quantize(t, bpm, div = 8) {
  const beat = 60 / clamp(bpm, 40, 320);
  const step = beat / div;
  return round6(Math.round(Number(t) / step) * step);
}

/** 判断时间是否落在 BPM 网格上（容差默认 1ms） */
export function isOnGrid(t, bpm, div = 8, tol = 0.001) {
  const beat = 60 / clamp(bpm, 40, 320);
  const step = beat / div;
  const k = Number(t) / step;
  return Math.abs(k - Math.round(k)) * step <= tol;
}

// ---------------------------------------------------------------- 风格预设

// div：每拍放置槽位数（2 = 八分音符，4 = 十六分音符，8 = 三十二分音符）
// 注意 div 必须是 8 的约数，这样槽位永远落在 1/8 拍网格上。
const STYLE_PRESETS = {
  easy: { div: 2, fill: 0.50, hold: 0.16, drag: 0.10, jump: 0.04, runMax: 3 },
  melodic: { div: 2, fill: 0.58, hold: 0.14, drag: 0.16, jump: 0.10, runMax: 4 },
  stream: { div: 4, fill: 0.62, hold: 0.06, drag: 0.20, jump: 0.12, runMax: 8 },
  technical: { div: 4, fill: 0.56, hold: 0.12, drag: 0.26, jump: 0.22, runMax: 6 },
  chaos: { div: 8, fill: 0.40, hold: 0.08, drag: 0.28, jump: 0.32, runMax: 12 },
};

export function styleNames() {
  return Object.keys(STYLE_PRESETS);
}

// ---------------------------------------------------------------- 曲式强度

/** 段落强度曲线：前奏渐入 -> 主歌 -> 副歌 -> 尾奏，返回 0.3~1.25 */
function shapeIntensity(p) {
  const x = clamp(p, 0, 1);
  if (x < 0.10) return 0.40 + x * 3.0;            // 渐入
  if (x < 0.30) return 0.72 + (x - 0.10) * 1.1;   // 主歌
  if (x < 0.66) return 0.94 + Math.sin((x - 0.30) * 5.2) * 0.10;
  if (x < 0.80) return 0.78;                      // 桥段降密度
  return 1.12;                                    // 尾段高密度
}

// ---------------------------------------------------------------- 小节图案

/** 生成一小节的节奏图案（返回槽位下标数组），图案会被复用形成乐句感 */
function makePattern(slots, fill, rng) {
  const out = [];
  for (let s = 0; s < slots; s++) {
    const onBeat = s % 4 === 0;
    const onHalf = s % 2 === 0;
    const p = fill * (onBeat ? 1.35 : (onHalf ? 0.95 : 0.62));
    if (rng() < p) out.push(s);
  }
  if (!out.length) out.push(0);
  return out;
}

/** 轻微变异图案：随机增删一个槽位，保持乐句变化但不散架 */
function mutatePattern(pattern, slots, rng) {
  const arr = pattern.slice();
  if (rng() < 0.5 && arr.length > 2) {
    arr.splice(Math.floor(rng() * arr.length), 1);
  } else {
    const s = Math.floor(rng() * slots);
    if (!arr.includes(s)) arr.push(s);
  }
  arr.sort((a, b) => a - b);
  return arr;
}

// ---------------------------------------------------------------- 音符净化

/**
 * 谱面净化与不变量收口：
 *   过滤非法音符 -> x 夹取 -> 按时间排序 -> 同刻去重（保证严格递增）
 *   -> 同 lane 最小间隔 -> hold 时长夹取 -> 量化到网格。
 * @returns {{notes: Array, dropped: number}}
 */
export function sanitizeNotes(notes, opts = {}) {
  const bpm = num(opts.bpm, 128, 40, 320);
  const laneCount = int(opts.laneCount, 4, 2, 8);
  const minGap = num(opts.minGap, 0.09, 0, 5);
  const gridDiv = int(opts.gridDiv, 8, 1, 8);
  const list = Array.isArray(notes) ? notes : [];
  const kept = [];
  let dropped = 0;
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (!n) { dropped++; continue; }
    const time = Number(n.time);
    const x = Number(n.x);
    if (!Number.isFinite(time) || !Number.isFinite(x) || time < 0) { dropped++; continue; }
    let type = n.type;
    if (type !== 'tap' && type !== 'drag' && type !== 'hold') type = 'tap';
    let hold = 0;
    if (type === 'hold') {
      hold = round3(clamp(num(n.hold, 0.5, 0.2, 3), 0.2, 3));
    }
    kept.push({
      time: quantize(time, bpm, gridDiv),
      x: round6(clamp(x, 0, 1)),
      type,
      hold,
    });
  }
  // 排序：先时间，再 x（同刻确定性）
  kept.sort((a, b) => (a.time - b.time) || (a.x - b.x));
  const out = [];
  const lastTime = new Array(laneCount).fill(-Infinity);
  let lastStamp = -Infinity;
  for (let i = 0; i < kept.length; i++) {
    const n = kept[i];
    if (n.time <= lastStamp + 1e-9) { dropped++; continue; }         // 严格递增
    const lane = laneOf(n.x, laneCount);
    if (n.time - lastTime[lane] < minGap - 1e-9) { dropped++; continue; } // 同 lane 最小间隔
    const note = { time: n.time, x: n.x, type: n.type };
    if (n.type === 'hold') note.hold = round3(n.hold);
    out.push(note);
    lastTime[lane] = n.time + (n.type === 'hold' ? note.hold : 0) + (n.type === 'hold' ? 0 : 0);
    lastStamp = n.time;
  }
  return { notes: out, dropped };
}

/**
 * 统计一份谱面的基本信息（供曲目文件与测试使用）。
 */
export function chartStats(notes, opts = {}) {
  const list = Array.isArray(notes) ? notes : [];
  const byType = { tap: 0, drag: 0, hold: 0 };
  let maxDensity = 0;
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (n && byType[n.type] !== undefined) byType[n.type]++;
    if (i > 0) {
      const dt = n.time - list[i - 1].time;
      if (dt > 0) maxDensity = Math.max(maxDensity, 1 / dt);
    }
  }
  const last = list.length ? list[list.length - 1] : null;
  return {
    noteCount: list.length,
    taps: byType.tap,
    drags: byType.drag,
    holds: byType.hold,
    firstTime: list.length ? list[0].time : 0,
    lastTime: last ? round6(last.time + (last.hold || 0)) : 0,
    peakNps: Math.round(maxDensity * 100) / 100,
    duration: num(opts.length, last ? last.time + 2 : 0, 0, 100000),
  };
}

// ---------------------------------------------------------------- 判定线
/**
 * 生成判定线时间轴：至少 4 段，x 在 0.3~0.7 之间平滑移动，at 对齐小节。
 */
export function buildLines(opts = {}) {
  const bpm = num(opts.bpm, 128, 40, 320);
  const length = num(opts.length, 90, 8, 600);
  const barLen = (60 / bpm) * 4;
  const segBars = int(opts.segBars, 8, 2, 32);
  const ladders = [
    [0.5, 0.42, 0.58, 0.36, 0.64, 0.5, 0.44, 0.56, 0.4, 0.6],
    [0.5, 0.44, 0.56, 0.4, 0.6, 0.5, 0.42, 0.58, 0.38, 0.62],
    [0.5, 0.4, 0.6, 0.44, 0.56, 0.5, 0.36, 0.64, 0.42, 0.58],
  ];
  const pick = int(opts.ladder, 0, 0, ladders.length - 1);
  const ladder = ladders[pick];
  const angles = [0, 0, -5, 4, 0, 0, 6, -4, 0, 0];
  const lines = [];
  const totalBars = Math.max(1, Math.ceil(length / barLen));
  for (let bar = 0; bar < totalBars; bar += segBars) {
    const at = round6(bar * barLen);
    if (at > length + 1e-6) break;
    const step = lines.length;
    lines.push({
      at,
      x: round3(ladder[step % ladder.length]),
      angle: angles[step % angles.length],
    });
  }
  if (lines.length < 4) {
    // 曲目太短时补足 4 段（0 / 1/3 / 2/3 / 结尾）
    const xs = [0.5, 0.42, 0.58, 0.5];
    const need = 4 - lines.length;
    for (let i = 0; i < need; i++) {
      const idx = lines.length;
      lines.push({ at: round6((length * idx) / 4), x: xs[idx % xs.length], angle: 0 });
    }
    lines.sort((a, b) => a.at - b.at);
  }
  if (lines[0].at !== 0) lines.unshift({ at: 0, x: 0.5, angle: 0 });
  return lines;
}

// ---------------------------------------------------------------- 生成主函数

/**
 * 生成本 span 内的音符序列（内部函数，generateChart 使用）。
 * @returns {{notes: Array, stats: Object}}
 */
function generateNotes(cfg, rng) {
  const { bpm, laneCount, preset, step, barLen, playStart, playEnd, density, fillScale } = cfg;
  const slots = Math.max(4, Math.round(barLen / step));   // 每小节槽位数
  const beat = 60 / bpm;
  const notes = [];
  const lastTime = new Array(laneCount).fill(-Infinity);
  const startBar = Math.floor(playStart / barLen);
  const endBar = Math.floor(playEnd / barLen);
  const totalBars = Math.max(1, endBar - startBar);
  const fill = clamp(preset.fill * density * (fillScale === undefined ? 1 : fillScale), 0.02, 2.5);
  let lastLane = Math.floor(laneCount / 2);
  let run = 0;
  const stats = { holds: 0, drags: 0, taps: 0, skipped: 0 };

  for (let b = startBar; b <= endBar; b++) {
    const barStart = b * barLen;
    const progress = (b - startBar) / totalBars;
    const intensity = shapeIntensity(progress) * (b % 4 === 3 ? 1.06 : 1); // 每 4 小节尾稍密
    const phrase = Math.floor((b - startBar) / 4);
    // 每个乐句确定一组图案（最多 3 个），乐句内复用 + 轻微变异
    const rngPhrase = mulberry32((cfg.seed ^ (phrase * 2654435761)) >>> 0);
    const pool = [];
    for (let k = 0; k < 3; k++) pool.push(makePattern(slots, clamp(fill * intensity, 0.02, 0.96), rngPhrase));
    const base = pool[(b - startBar) % pool.length];
    const pattern = (rng() < 0.35) ? mutatePattern(base, slots, rng) : base;

    for (let pi = 0; pi < pattern.length; pi++) {
      const s = pattern[pi];
      const t = round6(barStart + s * step);
      if (t < playStart - 1e-9 || t > playEnd + 1e-9) continue;
      // 类型选择：强拍更可能成为 hold，弱拍更可能成为 drag
      const strong = s % Math.max(1, Math.round(slots / 4)) === 0;
      let type = 'tap';
      if (strong && rng() < preset.hold) type = 'hold';
      else if (rng() < preset.drag) type = 'drag';

      // 选 lane：必须在同 lane 间隔约束下可用
      const viable = [];
      const weights = [];
      let totalW = 0;
      for (let l = 0; l < laneCount; l++) {
        if (t - lastTime[l] < 0.09 - 1e-9) continue;
        let w = 1;
        const d = Math.abs(l - lastLane);
        if (d === 0) w = 0.16;
        else if (d === 1) w = 1.0;
        else if (d === 2) w = 0.62;
        else w = 0.34;
        if (run >= preset.runMax && d === 0) w = 0.02;
        w *= 1 - 0.25 * Math.min(1, preset.jump * d);
        viable.push(l);
        weights.push(w);
        totalW += w;
      }
      if (!viable.length) { stats.skipped++; continue; }
      let lane = viable[viable.length - 1];
      let acc = 0;
      const r = rng() * totalW;
      for (let i = 0; i < viable.length; i++) {
        acc += weights[i];
        if (r <= acc) { lane = viable[i]; break; }
      }

      let hold = 0;
      if (type === 'hold') {
        const beats = 1 + Math.floor(rng() * 3);          // 1~3 拍
        hold = round3(clamp(beats * beat, 0.2, 3));
        if (t + hold > playEnd + 1e-9) { type = 'tap'; hold = 0; }
      }
      const note = { time: t, x: xOfLane(lane, laneCount), type };
      if (type === 'hold') note.hold = hold;
      notes.push(note);
      stats[type === 'hold' ? 'holds' : (type === 'drag' ? 'drags' : 'taps')]++;
      lastTime[lane] = t + hold;                          // hold 期间该 lane 被占用
      if (lane === lastLane) run++; else run = 0;
      lastLane = lane;
    }
  }
  return { notes, stats };
}

/**
 * 生成一份完整谱面（确定性）。
 * @param {Object} opts
 *   bpm        每分钟拍数，默认 128
 *   length     曲目总时长（秒），默认 90
 *   laneCount  轨道数 2..8，默认 4
 *   density    密度系数，默认 0.55（越大越密）
 *   style      easy|melodic|stream|technical|chaos
 *   seed       随机种子（整数），默认 1
 *   startAt    首个音符所在区域起点（秒），默认 2 小节
 *   endAt      最后一个音符的区域终点（秒），默认 length - 2 小节
 *   gridDiv    网格细分（默认 8，即 1/8 拍）
 *   ladder     判定线 x 阶梯编号
 * @returns {{laneCount:number, bpm:number, offset:number, lines:Array, notes:Array, stats:Object}}
 */
export function generateChart(opts = {}) {
  const bpm = num(opts.bpm, 128, 40, 320);
  const length = num(opts.length, 90, 8, 600);
  const laneCount = int(opts.laneCount, 4, 2, 8);
  const density = num(opts.density, 0.55, 0.05, 2.5);
  const style = STYLE_PRESETS[opts.style] ? opts.style : 'melodic';
  const preset = STYLE_PRESETS[style];
  const seed = (opts.seed === undefined ? 1 : Math.floor(Number(opts.seed))) >>> 0;
  const gridDiv = int(opts.gridDiv, 8, 1, 8);
  const fillScale = opts.fillScale === undefined ? 1 : num(opts.fillScale, 1, 0.05, 2.5);
  const beat = 60 / bpm;
  const barLen = beat * 4;
  const step = beat / preset.div;
  const rng = mulberry32(seed);

  const startBar = opts.startBar === undefined ? 2 : num(opts.startBar, 2, 0, 4096);
  const tailBars = opts.tailBars === undefined ? 2 : num(opts.tailBars, 2, 0, 4096);
  const rawStart = opts.startAt === undefined ? startBar * barLen : num(opts.startAt, startBar * barLen, 0, length);
  const rawEnd = opts.endAt === undefined ? length - tailBars * barLen : num(opts.endAt, length, 0, length);
  const grid = beat / gridDiv;
  const playStart = round6(Math.ceil((rawStart - 1e-9) / grid) * grid);
  const playEnd = round6(Math.min(length, Math.floor((rawEnd + 1e-9) / grid) * grid));

  const cfg = { bpm, laneCount, preset, step, barLen, playStart, playEnd, density, fillScale, seed };
  const gen = generateNotes(cfg, rng);
  const clean = sanitizeNotes(gen.notes, { bpm, laneCount, gridDiv, minGap: 0.09 });

  const byType = { tap: 0, drag: 0, hold: 0 };
  for (const n of clean.notes) byType[n.type]++;
  const last = clean.notes.length ? clean.notes[clean.notes.length - 1] : null;
  const stats = {
    style,
    noteCount: clean.notes.length,
    taps: byType.tap,
    drags: byType.drag,
    holds: byType.hold,
    dropped: clean.dropped + gen.stats.skipped,
    firstTime: clean.notes.length ? clean.notes[0].time : 0,
    lastTime: last ? round6(last.time + (last.hold || 0)) : 0,
    duration: length,
    bars: Math.round((clean.notes.length ? last.time : playStart) / barLen),
  };

  return {
    laneCount,
    bpm,
    offset: 0,
    lines: buildLines({ bpm, length, segBars: opts.segBars, ladder: opts.ladder }),
    notes: clean.notes,
    stats,
  };
}

export default { generateChart, buildLines, sanitizeNotes, mulberry32, xOfLane, laneOf, quantize, isOnGrid };
