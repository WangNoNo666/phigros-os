// js/engine/phigros.js
// Phigros 风格下落式音游引擎。
//
// 分层：
//   1. 纯函数层：judgeWindow / computeScore / visibleNotes / buildTimeline / lineXAt
//      —— 不依赖 DOM，node 下可直接测试。
//   2. JudgeCore：判定状态机（计数、连击、hold、drag、miss），不依赖 DOM 与 AudioContext，
//      可用假时钟驱动，测试与主引擎共用同一份判定逻辑。
//   3. PhigrosGame：canvas 渲染 + 输入 + 音频时钟，挂到 canvas 上。
//
// 时钟红线：判定一律使用 AudioEngine.instance.currentTime(handle)。
// 仅当 AudioContext 完全不可用（例如 headless 静音环境拿不到有效时钟）时，
// 才降级到 performance.now 折算的兜底时钟，且会在 this.degraded 标记出来。

import AudioEngine from './audio.js';

// ---------------------------------------------------------------- 常量

/** 内部判定等级常数 */
export const JUDGE = { PERFECT: 1, GOOD: 2, BAD: 3, MISS: 4 };

/** 默认判定窗口（毫秒，绝对值） */
export const DEFAULT_JUDGE_WINDOWS = { perfect: 45, good: 90, bad: 150 };

/** 4 lane = d f j k；5 lane / 6 lane = s d f j k / s d f j k l */
export const LANE_KEYS = {
  2: ['f', 'j'],
  3: ['d', 'f', 'j'],
  4: ['d', 'f', 'j', 'k'],
  5: ['s', 'd', 'f', 'j', 'k'],
  6: ['s', 'd', 'f', 'j', 'k', 'l'],
  7: ['a', 's', 'd', 'f', 'j', 'k', 'l'],
  8: ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k'],
};

export const GRADE_LABEL = { perfect: 'PERFECT', good: 'GOOD', bad: 'BAD', miss: 'MISS' };

export const GRADE_COLOR = {
  perfect: '#ffe066',
  good: '#4ade80',
  bad: '#fb923c',
  miss: '#ef4444',
};

/** 判定线默认归一化 Y */
export const DEFAULT_HIT_LINE_Y = 0.86;

/** 基准下落速度（720 逻辑高，像素/秒） */
export const BASE_FALL_SPEED = 520;

// ---------------------------------------------------------------- 小工具

function nfin(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clampNum(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return n < lo ? lo : (n > hi ? hi : n);
}

function clamp01(v) {
  return clampNum(v, 0, 1);
}

/** speed 非法（NaN / <=0）时回落到 1.0 */
export function validSpeed(speed) {
  const s = Number(speed);
  if (!Number.isFinite(s) || s <= 0) return 1;
  return clampNum(s, 0.1, 8);
}

/** x -> lane（与 chartgen.laneOf 一致） */
export function laneOf(x, laneCount) {
  const n = Math.max(2, Math.min(8, Math.round(nfin(laneCount, 4))));
  const v = clamp01(x) * n;
  return Math.max(0, Math.min(n - 1, Math.floor(v)));
}

/** lane -> 轨道中心 x */
export function xOfLane(lane, laneCount) {
  const n = Math.max(2, Math.min(8, Math.round(nfin(laneCount, 4))));
  const l = Math.max(0, Math.min(n - 1, Math.round(nfin(lane, 0))));
  return (l + 0.5) / n;
}

/** 兼容 track 与 track.chart 两种入参 */
function asChart(input) {
  if (!input) return {};
  if (input.chart && typeof input.chart === 'object') return input.chart;
  return input;
}

// ---------------------------------------------------------------- 判定纯函数

/**
 * 依据毫秒偏差给出判定。
 * @param {number} diffMs 有符号毫秒偏差（内部取绝对值比较）
 * @returns {{grade:'perfect'|'good'|'bad'|'miss', score:number, label:string, diffMs:number, absDiffMs:number}}
 */
export function judgeWindow(diffMs, windows = DEFAULT_JUDGE_WINDOWS) {
  const w = windows || DEFAULT_JUDGE_WINDOWS;
  const perfect = nfin(w.perfect, 45);
  const good = nfin(w.good, 90);
  const bad = nfin(w.bad, 150);
  const raw = Number(diffMs);
  const abs = Math.abs(raw);
  const d = Number.isFinite(abs) ? abs : Infinity;
  const signed = Number.isFinite(raw) ? raw : Infinity;
  if (d <= perfect) return { grade: 'perfect', score: 1, label: 'PERFECT', diffMs: signed, absDiffMs: d };
  if (d <= good) return { grade: 'good', score: 0.65, label: 'GOOD', diffMs: signed, absDiffMs: d };
  if (d <= bad) return { grade: 'bad', score: 0.30, label: 'BAD', diffMs: signed, absDiffMs: d };
  return { grade: 'miss', score: 0, label: 'MISS', diffMs: signed, absDiffMs: d };
}

/**
 * 计分。
 * acc = (perfect + good*0.65 + bad*0.30) / total
 * score = round(1000000 * acc)
 * grade：全 perfect -> S；否则 acc>=0.93 A，>=0.85 B，>=0.70 C，其余 F
 */
export function computeScore(counts, total) {
  const c = counts || {};
  const p = nfin(c.perfect, 0);
  const g = nfin(c.good, 0);
  const b = nfin(c.bad, 0);
  const m = nfin(c.miss, 0);
  const t = nfin(total, 0);
  const maxCombo = nfin(c.maxCombo, 0);
  if (!(t > 0)) {
    return { score: 0, acc: 0, grade: 'F', fc: false, maxCombo: 0, counts: { perfect: p, good: g, bad: b, miss: m }, total: 0 };
  }
  const acc = (p * 1 + g * 0.65 + b * 0.30) / t;
  const score = Math.round(1000000 * acc);
  let grade;
  if (m === 0 && g === 0 && b === 0) grade = 'S';
  else if (acc >= 0.93) grade = 'A';
  else if (acc >= 0.85) grade = 'B';
  else if (acc >= 0.70) grade = 'C';
  else grade = 'F';
  return {
    score,
    acc,
    grade,
    fc: m === 0,
    maxCombo,
    counts: { perfect: p, good: g, bad: b, miss: m },
    total: t,
  };
}

/**
 * 音符在 t 时刻的归一化 y（0 顶部，1 底部）。
 * 音符到达判定线的瞬间 y = hitLineY。
 */
export function noteYAt(note, tSec, speed, hitLineY = DEFAULT_HIT_LINE_Y) {
  const sp = validSpeed(speed);
  const hly = clamp01(nfin(hitLineY, DEFAULT_HIT_LINE_Y));
  const vy = (BASE_FALL_SPEED * sp) / 720;   // 归一化高 / 秒
  const time = nfin(note && note.time, 0);
  return hly - (time - nfin(tSec, 0)) * vy;
}

/** 顶部淡入 alpha：y<0 时按距离淡出到 0（y <= -0.15 完全不可见） */
export function noteAlpha(y) {
  const v = nfin(y, 0);
  if (v >= 0) return 1;
  const a = 1 + v / 0.15;
  return a < 0 ? 0 : a;
}

/**
 * 参考实现：返回 t 时刻可见的未判定音符。
 * 主引擎每帧使用游标扫描（见 PhigrosGame._scanVisible），此函数供测试与外部调用。
 * @returns {Array<{note:Object, y:number, alpha:number}>}
 */
export function visibleNotes(notes, tSec, speed, hitLineY = DEFAULT_HIT_LINE_Y) {
  const list = Array.isArray(notes) ? notes : (notes && Array.isArray(notes.notes) ? notes.notes : []);
  const t = nfin(tSec, 0);
  const sp = validSpeed(speed);
  const hly = clamp01(nfin(hitLineY, DEFAULT_HIT_LINE_Y));
  const vy = (BASE_FALL_SPEED * sp) / 720;
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const n = list[i];
    if (!n) continue;
    if (n.judged === true || n.state === 'done') continue;
    const time = Number(n.time);
    if (!Number.isFinite(time)) continue;
    const y = hly - (time - t) * vy;
    if (y < -0.15) continue;
    out.push({ note: n, y, alpha: noteAlpha(y) });
  }
  return out;
}

/** 判定线时间轴归一化 */
function normalizeLines(lines) {
  const src = Array.isArray(lines) ? lines : [];
  const out = [];
  for (let i = 0; i < src.length; i++) {
    const l = src[i];
    if (!l) continue;
    const at = Number(l.at);
    if (!Number.isFinite(at)) continue;
    out.push({ at, x: clamp01(nfin(l.x, 0.5)), angle: nfin(l.angle, 0) });
  }
  out.sort((a, b) => a.at - b.at);
  return out;
}

/**
 * 判定线在 t 时刻的归一化 x（0..1）。段与段之间线性插值，保证平滑移动。
 * 入参可以是 track 或 track.chart。
 */
export function lineXAt(chart, tSec) {
  const c = asChart(chart);
  const lines = normalizeLines(c.lines);
  if (!lines.length) return 0.5;
  const t = nfin(tSec, 0);
  if (t <= lines[0].at) return lines[0].x;
  const last = lines[lines.length - 1];
  if (t >= last.at) return last.x;
  for (let i = 1; i < lines.length; i++) {
    if (t <= lines[i].at) {
      const a = lines[i - 1];
      const b = lines[i];
      const span = b.at - a.at;
      if (!(span > 0)) return b.x;
      const k = (t - a.at) / span;
      return clamp01(a.x + (b.x - a.x) * k);
    }
  }
  return last.x;
}

/**
 * 预处理谱面：按时间排序、过滤非法音符、计算每段判定线、预分组 lane。
 * @returns {{notes:Array, lines:Array, laneCount:number, offset:number, total:number,
 *            duration:number, laneGroups:Array<Array<number>>, maxHold:number}}
 */
export function buildTimeline(chart) {
  const c = asChart(chart);
  const laneCount = Math.max(2, Math.min(8, Math.round(nfin(c.laneCount, nfin(c.lanes, 4)))));
  const offset = nfin(c.offset, 0);
  const raw = Array.isArray(c.notes) ? c.notes : [];
  const notes = [];
  for (let i = 0; i < raw.length; i++) {
    const n = raw[i];
    if (!n) continue;
    const rawTime = Number(n.time);
    const rawX = Number(n.x);
    if (!Number.isFinite(rawTime) || !Number.isFinite(rawX)) continue;   // 过滤非法音符
    let type = n.type;
    if (type !== 'tap' && type !== 'drag' && type !== 'hold') type = 'tap';
    let hold = 0;
    if (type === 'hold') hold = clampNum(nfin(n.hold, 0.5), 0.2, 3);
    const time = rawTime + offset;
    if (time < 0) continue;
    const x = clamp01(rawX);
    notes.push({
      index: -1,
      time,
      x,
      type,
      hold,
      end: time + hold,
      lane: laneOf(x, laneCount),
      state: 'idle',        // idle | holding | done
      judged: false,
      grade: null,
      score: 0,
      diffMs: 0,
      headGrade: null,
      headScore: 0,
      headDiffMs: 0,
      holdLane: -1,
    });
  }
  notes.sort((a, b) => (a.time - b.time) || (a.x - b.x));
  const laneGroups = [];
  for (let l = 0; l < laneCount; l++) laneGroups.push([]);
  let duration = 0;
  let maxHold = 0;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    n.index = i;
    laneGroups[n.lane].push(i);
    if (n.end > duration) duration = n.end;
    if (n.hold > maxHold) maxHold = n.hold;
  }
  return {
    notes,
    lines: normalizeLines(c.lines),
    laneCount,
    offset,
    total: notes.length,
    duration,
    laneGroups,
    maxHold,
  };
}

/** 判断传入的是不是 buildTimeline 的产物 */
function isTimeline(v) {
  return !!(v && Array.isArray(v.notes) && Array.isArray(v.laneGroups));
}

// ---------------------------------------------------------------- 判定状态机

/**
 * JudgeCore：纯判定逻辑，不依赖 DOM / AudioContext，可用假时钟驱动。
 * 时钟语义：judgeClock = 传入的秒 - offsetSec（正偏移 => 判定整体延后）。
 */
export class JudgeCore {
  constructor(chartOrTimeline, opts = {}) {
    this.timeline = isTimeline(chartOrTimeline) ? chartOrTimeline : buildTimeline(chartOrTimeline);
    this.notes = this.timeline.notes;
    this.total = this.notes.length;
    this.laneCount = Math.max(2, Math.min(8, Math.round(nfin(opts.laneCount, this.timeline.laneCount || 4))));
    this.laneGroups = this.timeline.laneGroups;
    this.windows = opts.windows || DEFAULT_JUDGE_WINDOWS;
    this.offsetSec = nfin(opts.offsetMs, 0) / 1000;
    this.graceSec = nfin(opts.holdGraceMs, 80) / 1000;   // hold 尾端容差
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this.reset();
  }

  reset() {
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      n.state = 'idle';
      n.judged = false;
      n.grade = null;
      n.score = 0;
      n.diffMs = 0;
      n.headGrade = null;
      n.headScore = 0;
      n.headDiffMs = 0;
      n.holdLane = -1;
    }
    this.counts = { perfect: 0, good: 0, bad: 0, miss: 0 };
    this.combo = 0;
    this.maxCombo = 0;
    this.resolved = 0;
    this.missCursor = 0;
    this.laneCursor = new Int32Array(this.laneCount);
    this.activeHolds = [];
    this.lastJudge = null;
    this.scoreSum = 0;
    this.endTime = this.timeline.duration;
    return this;
  }

  /** 判定窗口（秒） */
  get winSec() {
    const w = this.windows || DEFAULT_JUDGE_WINDOWS;
    return {
      perfect: nfin(w.perfect, 45) / 1000,
      good: nfin(w.good, 90) / 1000,
      bad: nfin(w.bad, 150) / 1000,
    };
  }

  /** 音频秒 -> 判定秒 */
  clock(tSec) {
    return nfin(tSec, 0) - this.offsetSec;
  }

  _emit(name, payload) {
    if (this.onEvent) {
      try { this.onEvent(name, payload); } catch (err) { /* 回调异常不打断判定 */ }
    }
  }

  _judge(note, result, t) {
    note.state = 'done';
    note.judged = true;
    note.grade = result.grade;
    note.score = result.score;
    note.diffMs = result.diffMs;
    const c = this.counts;
    if (c[result.grade] === undefined) c[result.grade] = 0;
    c[result.grade]++;
    this.scoreSum += result.score;
    this.resolved++;
    if (result.grade === 'miss') {
      this.combo = 0;
    } else {
      this.combo++;
      if (this.combo > this.maxCombo) this.maxCombo = this.combo;
    }
    this.lastJudge = { grade: result.grade, label: result.label, combo: this.combo, diffMs: result.diffMs, at: t, index: note.index };
    this._emit('judge', {
      index: note.index,
      grade: result.grade,
      label: result.label,
      combo: this.combo,
      diffMs: result.diffMs,
      counts: { ...this.counts },
      time: t,
    });
    if (result.grade !== 'miss') {
      this._emit('combo', { combo: this.combo, maxCombo: this.maxCombo, index: note.index });
    }
    return this.lastJudge;
  }

  /**
   * 在指定 lane 内寻找可判定的音符。
   * 优先 time <= current 中最晚的一个（避免吃到后面的音符）。
   */
  pick(lane, t, filter) {
    const l = Math.max(0, Math.min(this.laneCount - 1, Math.round(nfin(lane, 0))));
    const idxs = this.laneGroups[l];
    if (!idxs || !idxs.length) return null;
    const win = this.winSec.bad;
    let cur = this.laneCursor[l];
    while (cur < idxs.length) {
      const n = this.notes[idxs[cur]];
      if (n.state === 'done' || (n.state === 'idle' && n.time + win < t)) cur++;
      else break;
    }
    this.laneCursor[l] = cur;
    let bestPast = null;
    let bestFuture = null;
    for (let i = cur; i < idxs.length; i++) {
      const n = this.notes[idxs[i]];
      const d = n.time - t;
      if (d > win) break;
      if (n.state !== 'idle') continue;
      if (filter && !filter(n)) continue;
      if (d <= 0) {
        if (!bestPast || n.time > bestPast.time) bestPast = n;
      } else if (!bestFuture || n.time < bestFuture.time) {
        bestFuture = n;
      }
    }
    return bestPast || bestFuture;
  }

  /** 按键 / 点击：判定一个 live 输入 */
  press(lane, tSec) {
    const t = this.clock(tSec);
    const n = this.pick(lane, t, null);
    if (!n) return null;
    const result = judgeWindow((t - n.time) * 1000, this.windows);
    if (result.grade === 'miss') return null;
    if (n.type === 'hold') {
      // 头部按下：先记住头判定的等级，尾端到点或松手时才计入
      n.state = 'holding';
      n.headGrade = result.grade;
      n.headScore = result.score;
      n.headDiffMs = result.diffMs;
      n.holdLane = Math.max(0, Math.min(this.laneCount - 1, Math.round(nfin(lane, n.lane))));
      if (this.activeHolds.indexOf(n) < 0) this.activeHolds.push(n);
      return { grade: result.grade, label: result.label, combo: this.combo, diffMs: result.diffMs, index: n.index, holdHead: true };
    }
    return this._judge(n, result, t);
  }

  /** 松手：hold 尾端容差内视为完成，否则记 bad */
  release(lane, tSec) {
    const t = this.clock(tSec);
    const l = Math.max(0, Math.min(this.laneCount - 1, Math.round(nfin(lane, 0))));
    let released = null;
    for (let i = this.activeHolds.length - 1; i >= 0; i--) {
      const n = this.activeHolds[i];
      if (n.holdLane !== l) continue;
      this.activeHolds.splice(i, 1);
      if (t + this.graceSec >= n.end) {
        released = this._judge(n, {
          grade: n.headGrade || 'perfect',
          score: n.headScore || 1,
          label: GRADE_LABEL[n.headGrade || 'perfect'],
          diffMs: n.headDiffMs || 0,
        }, t);
      } else {
        released = this._judge(n, { grade: 'bad', score: 0.30, label: 'BAD', diffMs: (t - n.time) * 1000 }, t);
      }
    }
    return released;
  }

  /** 划动经过：drag 音符固定 perfect（Phigros 的 drag 特性） */
  swipe(lane, tSec) {
    const t = this.clock(tSec);
    const n = this.pick(lane, t, (note) => note.type === 'drag');
    if (!n) return null;
    return this._judge(n, { grade: 'perfect', score: 1, label: 'PERFECT', diffMs: (t - n.time) * 1000 }, t);
  }

  /** 按 x 位置划动 */
  swipeAtX(x, tSec) {
    return this.swipe(laneOf(x, this.laneCount), tSec);
  }

  /** 按 x 位置按下 */
  pressAtX(x, tSec) {
    return this.press(laneOf(x, this.laneCount), tSec);
  }

  /** 每帧推进：处理 hold 尾端与 miss */
  tick(tSec) {
    const t = this.clock(tSec);
    const events = [];
    // 1) hold 尾端
    for (let i = this.activeHolds.length - 1; i >= 0; i--) {
      const n = this.activeHolds[i];
      if (t >= n.end) {
        this.activeHolds.splice(i, 1);
        const r = this._judge(n, {
          grade: n.headGrade || 'perfect',
          score: n.headScore || 1,
          label: GRADE_LABEL[n.headGrade || 'perfect'],
          diffMs: n.headDiffMs || 0,
        }, t);
        events.push(r);
      }
    }
    // 2) miss（time + 150ms < current）
    const win = this.winSec.bad;
    while (this.missCursor < this.notes.length) {
      const n = this.notes[this.missCursor];
      if (n.state === 'done') { this.missCursor++; continue; }
      if (n.time + win < t) {
        if (n.state === 'idle') {
          const r = this._judge(n, { grade: 'miss', score: 0, label: 'MISS', diffMs: (t - n.time) * 1000 }, t);
          events.push(r);
        }
        this.missCursor++;
        continue;
      }
      break;
    }
    return events;
  }

  /** 把剩余未判定音符全部记为 miss（调试 / 冒烟测试的 finish 使用） */
  missRemaining(tSec) {
    const t = this.clock(tSec);
    for (let i = 0; i < this.notes.length; i++) {
      const n = this.notes[i];
      if (n.state === 'done') continue;
      if (n.state === 'holding') {
        n.state = 'idle';
        const k = this.activeHolds.indexOf(n);
        if (k >= 0) this.activeHolds.splice(k, 1);
      }
      this._judge(n, { grade: 'miss', score: 0, label: 'MISS', diffMs: (t - n.time) * 1000 }, t);
    }
    this.missCursor = this.notes.length;
    return this.counts;
  }

  /** 结算数据 */
  results() {
    const counts = { ...this.counts };
    const r = computeScore(counts, this.total);
    return {
      score: r.score,
      acc: r.acc,
      grade: r.grade,
      fc: r.fc,
      maxCombo: this.maxCombo,
      counts,
      total: this.total,
      resolved: this.resolved,
      combo: this.combo,
    };
  }

  /** 进度 0..1 */
  progress() {
    if (!this.total) return 1;
    return Math.min(1, this.resolved / this.total);
  }
}

// ---------------------------------------------------------------- 主引擎（canvas）

export class PhigrosGame {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {Object} opts { track, settings, onEvent, raf, audio, windows }
   */
  constructor(canvas, opts = {}) {
    // 第二个参数允许是承载容器（DOM 渲染后端需要它来挂音符元素）
    this.hostEl = canvas && typeof canvas.getContext !== 'function' ? canvas : null;
    this.canvas = this.hostEl ? (opts.canvas || null) : canvas || null;
    this.c2d = null;
    this.track = opts.track || {};
    this.settings = opts.settings || {};
    this.onEvent = typeof opts.onEvent === 'function' ? opts.onEvent : null;
    this.audio = opts.audio || AudioEngine;
    this.raf = typeof opts.raf === 'function' ? opts.raf : null;
    this.chart = this.track.chart || {};
    this.timeline = buildTimeline(this.track);
    this.laneCount = Math.max(2, Math.min(8, Math.round(nfin(
      this.chart.laneCount !== undefined ? this.chart.laneCount : this.track.laneCount, 4,
    ))));
    this.windows = opts.windows || DEFAULT_JUDGE_WINDOWS;
    this.core = new JudgeCore(this.timeline, {
      laneCount: this.laneCount,
      offsetMs: nfin(this.settings.offsetMs, 0),
      windows: this.windows,
      onEvent: (name, payload) => this._emit(name, payload),
    });
    this.state = 'idle';          // idle | preparing | ready | playing | paused | ended
    this.handle = null;
    this.buffer = null;
    this.paused = false;
    this.ended = false;
    this.destroyed = false;
    this.degraded = false;
    this.time = 0;
    this.result = null;
    this.fps = 60;
    this.hitLineY = DEFAULT_HIT_LINE_Y;
    this.w = 900;
    this.h = 640;
    this.dpr = 1;
    this._renderCursor = 0;
    this._effects = [];
    this._floaters = [];
    this._cancelRaf = null;
    this._rafId = 0;
    this._timerId = 0;
    this._timerActive = false;
    this._scheduled = false; // 单链闸门
    // 性能降载相关
    this.lowQuality = Boolean(opts.lowQuality);
    this.onPerfDegrade = typeof opts.onPerfDegrade === 'function' ? opts.onPerfDegrade : null;
    this._downgraded = false;
    this._slowFrames = 0;
    this._slowMs = 0;
    this._probeFrames = 0;
    // 渲染后端：'dom'（默认，CSS transform + 合成器线程，弱 GPU 也流畅，
    // 与 Sparebeat 同思路）或 'canvas'（2D 画布，逐像素光栅化，软件渲染时会掉帧）
    this.renderMode = opts.renderMode === 'canvas' ? 'canvas' : 'dom';
    // 诊断开关：?norender=1 只跑判定逻辑（用于隔离「逻辑/循环」与「绘制」问题）
    this.noRender = Boolean(opts.noRender);
    this._dom = null;      // DOM 后端元素缓存
    this._noteEls = new Map(); // noteIndex -> 元素
    // 遥测
    this._tmFrames = 0;
    this._tmSum = 0;
    this._tmMax = 0;
    this._tmStalls = 0;
    this._tmRenderSum = 0;
    this._loopMode = 'raf';
    this._starved = 0;
    this._lastFrameMs = 0;
    this._fpsAvg = 60;
    this._heldKeys = new Map();
    this._pointers = new Map();
    this._audioZeroFrames = 0;
    this._audioAdvanced = false;
    this._fbStart = null;
    this._fbOffset = 0;
    this._bg = null;
    this._lastKeyDedupe = { code: '', stamp: -1 };
    this._combo = 0;
    this._autoPaused = false;
    this._bindInput();
    this._bindVisibility();
  }

  /** 页面被切到后台时自动暂停：回来时从原处继续，而不是「跳一大段」 */
  _bindVisibility() {
    if (this._visibilityBound) return;
    if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
    this._onVisibility = () => {
      if (this.destroyed || this.ended) return;
      try {
        if (document.visibilityState === 'hidden') {
          if (this.state === 'playing' && !this.paused) {
            this._autoPaused = true;
            this.pause();
          }
        } else if (this._autoPaused && this.paused) {
          this._autoPaused = false;
          this.resume();
        }
      } catch (err) { /* 忽略 */ }
    };
    document.addEventListener('visibilitychange', this._onVisibility);
    this._visibilityBound = true;
  }

  _unbindVisibility() {
    if (!this._visibilityBound) return;
    try {
      if (typeof document !== 'undefined' && document.removeEventListener) {
        document.removeEventListener('visibilitychange', this._onVisibility);
      }
    } catch (err) { /* 忽略 */ }
    this._visibilityBound = false;
    this._onVisibility = null;
  }

  // ---------- 时钟 ----------

  _fbNow() {
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && g.performance && typeof g.performance.now === 'function') return g.performance.now();
    if (typeof Date !== 'undefined' && Date.now) return Date.now();
    return 0;
  }

  _fallbackTime() {
    if (this._fbStart === null) this._fbStart = this._fbNow();
    return Math.max(0, (this._fbNow() - this._fbStart) / 1000 + this._fbOffset);
  }

  /**
   * 主时钟：优先 AudioEngine.currentTime(handle)；
   * 仅当音频不可用或时钟连续多帧停在 0 时启用兜底时钟（this.degraded = true）。
   */
  clock() {
    const h = this.handle;
    let t = null;
    if (h && !h.unsupported && this.audio && typeof this.audio.currentTime === 'function') {
      const v = this.audio.currentTime(h);
      if (Number.isFinite(v)) t = v;
    }
    if (t !== null && t > 0) {
      this._audioAdvanced = true;
      this.degraded = false;
      return t;
    }
    if (!this._audioAdvanced) {
      this._audioZeroFrames++;
      if (this._audioZeroFrames < 15) return t === null ? this._fallbackTime() : t;
      this.degraded = true;
    }
    return this._fallbackTime();
  }

  _emit(name, payload) {
    if (name === 'judge' && payload && payload.grade) {
      this._pushJudgeText(payload.grade, payload.combo);
    }
    if (!this.onEvent) return;
    try { this.onEvent(name, payload); } catch (err) { /* 忽略回调异常 */ }
  }

  get speed() {
    return validSpeed(this.settings ? this.settings.speed : 1);
  }

  // ---------- 尺寸 / 画布 ----------

  resize(w, h) {
    const canvas = this.canvas;
    let cw = nfin(w, NaN);
    let ch = nfin(h, NaN);
    if (!Number.isFinite(cw)) cw = nfin(canvas && canvas.clientWidth, 0) || this.w || 900;
    if (!Number.isFinite(ch)) ch = nfin(canvas && canvas.clientHeight, 0) || this.h || 640;
    if (cw < 2) cw = 900;
    if (ch < 2) ch = 640;
    // 幂等短路：尺寸未变就什么都不做。
    // 关键——ResizeObserver 观察到尺寸变化会回调 resize，若 resize 又改画布尺寸
    // 就可能形成无限循环，把主线程彻底卡死（表现为「页面没有响应」）。
    if (this._resizedOnce && Math.abs(cw - this.w) < 0.5 && Math.abs(ch - this.h) < 0.5) {
      return { w: this.w, h: this.h };
    }
    this._resizedOnce = true;
    const dpr = Math.max(1, Math.min(
      1, // 判定游戏不需要高 DPI：1× 填充率最省，画面依然清晰（音游对延迟敏感度远高于像素密度）
      nfin((typeof globalThis !== 'undefined' && globalThis.devicePixelRatio) || 1, 1)
    ));
    this.w = cw;
    this.h = ch;
    this.dpr = dpr;
    if (canvas) {
      try {
        canvas.width = Math.round(cw * dpr);
        canvas.height = Math.round(ch * dpr);
      } catch (err) { /* 忽略 */ }
    }
    const c2d = this._ensureCtx();
    if (c2d) {
      try { c2d.setTransform(dpr, 0, 0, dpr, 0, 0); } catch (err) { /* 忽略 */ }
    }
    this._bg = null;
    return { w: cw, h: ch };
  }

  _ensureCtx() {
    if (this.c2d) return this.c2d;
    const canvas = this.canvas;
    if (!canvas || typeof canvas.getContext !== 'function') return null;
    try { this.c2d = canvas.getContext('2d'); } catch (err) { this.c2d = null; }
    return this.c2d;
  }

  // ---------- 生命周期 ----------

  /** 渲染整曲音频缓冲 */
  async prepare() {
    this.state = 'preparing';
    const ae = this.audio;
    if (!ae || typeof ae.renderChartToBuffer !== 'function') {
      this._emit('ready', { ok: false, reason: 'no-audio-engine' });
      return null;
    }
    let buf = null;
    try {
      buf = await ae.renderChartToBuffer(this.chart, this.track);
    } catch (err) {
      buf = null;
    }
    this.buffer = buf || null;
    this.state = 'ready';
    // 渲染诊断（供验收脚本与调试读取）
    if (typeof window !== 'undefined') {
      window.__PHIGROS_RENDER_STATS__ = ae.lastRenderStats || null;
    }
    this._emit('ready', { ok: !!buf, duration: buf ? buf.duration : 0, notes: this.timeline.total });
    return this.buffer;
  }

  /**
   * 非阻塞准备：立刻返回（有缓存/已知音频不可用时直接给结果，
   * 否则返回 null 并让音频在后台渲染）。
   * 这样音游绝不会因为音频子系统卡住而无法开始——判定走兜底时钟，
   * 下一次游玩就能用上缓存好的音频。
   */
  prepareAsync() {
    this.state = 'preparing';
    const ae = this.audio;
    if (!ae || typeof ae.renderChartToBuffer !== 'function') {
      this.state = 'ready';
      this._emit('ready', { ok: false, reason: 'no-audio-engine' });
      return this.buffer;
    }
    const key = this.track && this.track.id;
    const cached = key && ae.bufferCache && typeof ae.bufferCache.get === 'function' ? ae.bufferCache.get(key) : null;
    if (cached) {
      this.buffer = cached;
      this.state = 'ready';
      if (typeof window !== 'undefined') window.__PHIGROS_RENDER_STATS__ = ae.lastRenderStats || null;
      this._emit('ready', { ok: true, duration: cached.duration, notes: this.timeline.total, cached: true });
      return this.buffer;
    }
    const can = typeof ae.canRenderAudio === 'function' ? ae.canRenderAudio() : undefined;
    if (can === false) {
      this.buffer = null;
      this.state = 'ready';
      if (typeof window !== 'undefined') window.__PHIGROS_RENDER_STATS__ = ae.lastRenderStats || null;
      this._emit('ready', { ok: false, reason: 'audio-synthesis-unavailable', notes: this.timeline.total });
      return null;
    }
    // 后台渲染：不等待，先让游戏跑起来
    this.state = 'ready';
    Promise.resolve()
      .then(() => ae.renderChartToBuffer(this.chart, this.track))
      .then((buf) => {
        this.buffer = buf || null;
        if (typeof window !== 'undefined') window.__PHIGROS_RENDER_STATS__ = ae.lastRenderStats || null;
        this._emit('ready', { ok: !!buf, duration: buf ? buf.duration : 0, notes: this.timeline.total, background: true });
      })
      .catch((err) => {
        this.buffer = null;
        this._emit('ready', { ok: false, reason: (err && err.message) || 'render-failed' });
      });
    return null;
  }

  async start() {
    if (this.destroyed) return false;
    this._startLongTaskProbe();
    this.core.reset();
    if (this.settings && this.settings.offsetMs !== undefined) {
      this.core.offsetSec = nfin(this.settings.offsetMs, 0) / 1000;
    }
    this._effects = [];
    this._floaters = [];
    this._renderCursor = 0;
    this._audioZeroFrames = 0;
    this._audioAdvanced = false;
    this.degraded = false;
    this._loopMode = 'raf';
    this._starved = 0;
    this._tmFrames = 0;
    this._tmSum = 0;
    this._tmMax = 0;
    this._tmStalls = 0;
    this._tmRenderSum = 0;
    this._fbOffset = 0;
    this._fbStart = null;
    this.paused = false;
    this.ended = false;
    this.result = null;
    this.time = 0;
    this.state = 'playing';
    // 让应用层给窗口打开「高性能画布」模式（关掉 backdrop-filter 等昂贵合成）
    this._emit('start', { notes: this.timeline.total });
    // 播放音频（离线渲染好的整曲 buffer，一个 BufferSourceNode 即可）
    if (this.buffer && this.audio && typeof this.audio.play === 'function') {
      try { this.handle = this.audio.play(this.buffer, { at: 0, gain: 1 }); } catch (err) { this.handle = null; }
    }
    this.resize();
    this._emit('tick', { t: 0, fps: this.fps, counts: { ...this.core.counts }, combo: 0 });
    // 整局只建立「一条」帧循环（见 _startLoop 的说明）
    this._startLoop();
    return true;
  }

  /**
   * 建立唯一的帧循环。
   *
   * 这是本项目最关键的一处不变量：Host.raf 建立的循环会自我续期，
   * 因此**绝不能每帧新建一条**——旧循环不会自己停止，会变成每秒几十条的
   * 僵尸循环，同时推进同一个判定核（时钟加速到数倍、音符跳格），
   * 最终把整个页面拖死。
   * 现在：开始/恢复时建一条，暂停/结算/销毁时取消，全程恒为 1 条。
   */
  _startLoop() {
    if (this.destroyed || this.ended) return;
    if (this._loopStarted) return;
    this._loopStarted = true;
    this._loopMode = 'raf';
    this._starved = 0;
    this._scheduled = false;
    if (this.raf) {
      this._cancelRaf = this.raf((dtMs, nowMs) => this._frame(dtMs, nowMs));
      return;
    }
    this._scheduleFallback();
  }

  /** 无 Host.raf 时的退化驱动（自带 rAF / setTimeout 链，同样保证单链） */
  _scheduleFallback() {
    if (this.destroyed || this.ended || this.paused) return;
    if (this._scheduled) return;
    this._scheduled = true;
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (g && typeof g.requestAnimationFrame === 'function') {
      this._rafId = g.requestAnimationFrame((ms) => {
        this._scheduled = false;
        this._frame(undefined, ms);
      });
      return;
    }
    this._timerId = setTimeout(() => {
      this._scheduled = false;
      this._frame(16, this._fbNow());
    }, 16);
  }

  pause() {
    if (this.destroyed || this.ended || this.paused || this.state !== 'playing') return false;
    this.paused = true;
    this.state = 'paused';
    if (this.degraded) { this._fbOffset = this._fallbackTime(); this._fbStart = null; }
    if (this.handle && this.audio && typeof this.audio.pause === 'function') {
      try { this.audio.pause(this.handle); } catch (err) { /* 忽略 */ }
    }
    this._cancelRafLoop();
    this._emit('pause', { t: this.time, counts: { ...this.core.counts } });
    this._render(this.time, true);
    return true;
  }

  resume() {
    if (this.destroyed || this.ended || !this.paused) return false;
    this.paused = false;
    this.state = 'playing';
    if (this.degraded) this._fbStart = null;
    if (this.handle && this.audio && typeof this.audio.resume === 'function') {
      try { this.audio.resume(this.handle); } catch (err) { /* 忽略 */ }
    }
    this._emit('resume', { t: this.time, counts: { ...this.core.counts } });
    this._startLoop();
    return true;
  }

  async restart() {
    this._cancelRafLoop();
    if (this.handle && this.audio && typeof this.audio.stop === 'function') {
      try { this.audio.stop(this.handle); } catch (err) { /* 忽略 */ }
    }
    this.handle = null;
    this.paused = false;
    this.ended = false;
    return this.start();
  }

  /** 调试 / 冒烟测试：剩余音符全部 miss 并立刻结算 */
  finish() {
    if (this.destroyed) return this.result;
    if (!this.ended) {
      this.core.missRemaining(this.time);
      this._finish();
    }
    return this.result;
  }

  /** 调试：把时间直接推到曲末（等价于立刻结算） */
  seekToEnd() {
    this.time = Math.max(this.time, this.timeline.duration + 0.5);
    return this.finish();
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ended = true;
    this._cancelRafLoop();
    if (this.handle && this.audio && typeof this.audio.stop === 'function') {
      try { this.audio.stop(this.handle); } catch (err) { /* 忽略 */ }
    }
    this.handle = null;
    this._unbindInput();
    this._unbindVisibility();
    this._stopLongTaskProbe();
    this._destroyDom();
    this._heldKeys.clear();
    this._pointers.clear();
    this.c2d = null;
    this.buffer = null;
    this.state = 'idle';
  }

  // ---------- 主循环 ----------

  _cancelRafLoop() {
    this._stopLoop();
    this._timerActive = false;
    this._scheduled = false;
    this._loopMode = 'raf'; // 复位驱动方式，必要时可重新升级
    this._starved = 0;
  }

  _schedule() {
    if (this.destroyed || this.paused || this.ended) return;
    // Host.raf 路径：循环由 _startLoop 建立并自我续期，这里什么都不做。
    // （早期版本在这里每帧新建一条循环 —— 那就是页面卡死的根因）
    if (this.raf) return;
    if (this._loopMode === 'timeout' && this._timerActive) return;
    this._scheduleFallback();
  }

  _frame(dtMs, nowMs) {
    if (this.destroyed) return;
    const frameEnter = this._fbNow();
    if (this._prevExit) {
      // 帧间空档：上一帧结束到这一帧开始之间的时间（被别的主线程任务占用）
      const gap = frameEnter - this._prevExit;
      this._tmGapSum = (this._tmGapSum || 0) + gap;
      if (gap > (this._tmGapMax || 0)) this._tmGapMax = gap;
    }
    const now = nfin(nowMs, this._fbNow());
    let dtRaw = Number.isFinite(dtMs) && dtMs > 0 ? dtMs : now - this._lastFrameMs;
    let dt = nfin(dtRaw, 16.7);
    if (!Number.isFinite(dt) || dt <= 0 || dt > 500) dt = 16.7;
    this._lastFrameMs = now;
    this._lastDtMs = dt;
    const inst = 1000 / dt;
    this._fpsAvg = this._fpsAvg * 0.9 + inst * 0.1;
    this.fps = Math.round(this._fpsAvg);

    // ---------- 遥测：区分「渲染慢」与「rAF 被浏览器节流」 ----------
    this._tmFrames = (this._tmFrames || 0) + 1;
    if (Number.isFinite(dtRaw)) {
      this._tmSum += dtRaw;
      if (dtRaw > this._tmMax) this._tmMax = dtRaw;
      if (dtRaw > 200) this._tmStalls += 1;
    }
    const frameStart = this._fbNow();
    // rAF 被节流时（页面被判定为不可见/后台）：只要文档可见就改用 setTimeout 自驱，
    // 否则音游会「一屏一屏跳」而不是连续下落。
    this._maybeEscalateLoop(dtRaw);

    // 帧时间探针：连续掉帧时降载（关掉判定线辉光；由应用层决定是否停用音频合成）
    this._probeFrames = (this._probeFrames || 0) + 1;
    if (dt > 26) {
      this._slowFrames = (this._slowFrames || 0) + 1;
      this._slowMs = (this._slowMs || 0) + dt;
    }
    if (!this._downgraded && dt > 26 && this._slowFrames >= 15 && this._slowMs >= 900) {
      this._downgraded = true;
      if (this._slowFrames / this._probeFrames > 0.3) this.lowQuality = true;
      if (typeof window !== 'undefined') {
        window.__PHIGROS_PERF__ = { downgradedAt: Date.now(), slowFrames: this._slowFrames, slowMs: Math.round(this._slowMs), avgFps: this.fps };
      }
      if (typeof this.onPerfDegrade === 'function') {
        try { this.onPerfDegrade({ fps: this.fps, slowFrames: this._slowFrames, slowMs: this._slowMs }); } catch (err) { /* 忽略 */ }
      }
    }

    const t = this.clock();
    this.time = t;
    if (this.settings && this.settings.offsetMs !== undefined) {
      this.core.offsetSec = nfin(this.settings.offsetMs, 0) / 1000;
    }
    if (!this.paused && !this.ended) {
      this.core.tick(t);
      const total = this.core.total;
      const doneAt = this.timeline.duration + 0.6;
      const allJudged = this.core.resolved >= total;
      if (total === 0 ? t > 1.2 : (allJudged && t >= doneAt)) {
        this._finish();
      }
    }
    this._updateEffects(dt);
    this._render(t, false);

    // 遥测汇总
    this._tmRenderSum += this._fbNow() - frameStart;
    this._tmTotalSum = (this._tmTotalSum || 0) + (this._fbNow() - frameEnter);
    this._prevExit = this._fbNow();
    if (this._tmFrames % 30 === 0 && typeof window !== 'undefined') {
      window.__PHIGROS_TELEMETRY__ = {
        frames: this._tmFrames,
        avgFrameMs: Number((this._tmSum / this._tmFrames).toFixed(2)),
        maxFrameMs: Number(this._tmMax.toFixed(2)),
        stallsOver200ms: this._tmStalls,
        avgWorkMs: Number((this._tmRenderSum / this._tmFrames).toFixed(3)),
        avgFrameTotalMs: Number(((this._tmTotalSum || 0) / this._tmFrames).toFixed(3)),
        avgIdleGapMs: Number(((this._tmGapSum || 0) / Math.max(1, this._tmFrames - 1)).toFixed(2)),
        maxIdleGapMs: Number((this._tmGapMax || 0).toFixed(1)),
        longTasks: this._longTasks || [],
        loop: this._loopMode,
        visible: typeof document !== 'undefined' ? document.visibilityState : 'n/a',
        renderMode: this.renderMode,
        fps: this.fps,
        degraded: this.degraded,
        t: Number(t.toFixed(2)),
      };
    }

    this._emit('tick', {
      t,
      fps: this.fps,
      combo: this.core.combo,
      maxCombo: this.core.maxCombo,
      counts: { ...this.core.counts },
      degraded: this.degraded,
      progress: this.core.progress(),
    });
    this._schedule();
  }

  /**
   * rAF 被节流时改用 setTimeout 驱动。
   * 浏览器会把不可见页面/iframe 的 requestAnimationFrame 降到 ~1Hz，
   * 那会让音符「一屏一屏跳」。只要 document 可见，就用定时器自驱保住连续性。
   */
  _maybeEscalateLoop(dtRaw) {
    if (this._loopMode !== 'raf') return;
    if (this.destroyed) return;
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    if (!(dtRaw > 250)) return;
    this._starved = (this._starved || 0) + 1;
    if (this._starved < 3) return;
    if (this._timerActive) return;
    // 先彻底停掉 rAF 循环（它是自我续期的，不停就会变成僵尸循环）
    this._stopLoop();
    this._loopMode = 'timeout';
    this._timerActive = true;
    this._loopStarted = true;
    if (typeof window !== 'undefined') {
      window.__PHIGROS_LOOP_ESCALATED__ = { at: Date.now(), lastDt: Math.round(dtRaw) };
    }
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('[phigrOS/engine] requestAnimationFrame 被节流（间隔 ' + Math.round(dtRaw) + 'ms），已切换为定时器驱动');
    }
    const tickLoop = () => {
      if (this.destroyed || this.paused || this.ended) {
        this._timerId = 0;
        this._timerActive = false;
        this._loopStarted = false;
        this._loopMode = 'raf';
        return;
      }
      const n = this._fbNow();
      const d = n - this._lastFrameMs;
      this._frame(d > 0 ? d : 16.7, n);
      if (this._loopMode === 'timeout' && !this.destroyed && !this.paused && !this.ended) {
        this._timerId = setTimeout(tickLoop, 8);
      } else {
        this._timerId = 0;
      }
    };
    this._timerId = setTimeout(tickLoop, 8);
  }

  /** 只取消帧循环，不重置驱动方式等状态 */
  _stopLoop() {
    if (typeof this._cancelRaf === 'function') {
      try { this._cancelRaf(); } catch (err) { /* 忽略 */ }
    }
    this._cancelRaf = null;
    if (this._rafId && typeof globalThis !== 'undefined' && globalThis.cancelAnimationFrame) {
      try { globalThis.cancelAnimationFrame(this._rafId); } catch (err) { /* 忽略 */ }
    }
    this._rafId = 0;
    if (this._timerId) {
      try { clearTimeout(this._timerId); } catch (err) { /* 忽略 */ }
    }
    this._timerId = 0;
    this._loopStarted = false;
  }

  _finish() {
    if (this.ended) return;
    this.ended = true;
    this.paused = false;
    this.state = 'ended';
    this._cancelRafLoop();
    if (this.handle && this.audio && typeof this.audio.stop === 'function') {
      try { this.audio.stop(this.handle); } catch (err) { /* 忽略 */ }
    }
    this.result = this.core.results();
    this._render(this.time, true);
    this._emit('end', this.result);
  }

  // ---------- 输入 ----------

  _laneFromX(clientX) {
    const canvas = this.canvas;
    if (canvas && typeof canvas.getBoundingClientRect === 'function') {
      try {
        const r = canvas.getBoundingClientRect();
        if (r && r.width > 0) {
          const nx = (clientX - r.left) / r.width;
          return laneOf(nx, this.laneCount);
        }
      } catch (err) { /* 忽略 */ }
    }
    if (this.w > 0) return laneOf(clamp01(clientX / this.w), this.laneCount);
    return Math.floor(this.laneCount / 2);
  }

  _bindInput() {
    this._onKeyDown = (ev) => this._handleKeyDown(ev);
    this._onKeyUp = (ev) => this._handleKeyUp(ev);
    const keyTarget = (typeof document !== 'undefined' && document && typeof document.addEventListener === 'function')
      ? document
      : (typeof globalThis !== 'undefined' && globalThis && typeof globalThis.addEventListener === 'function' ? globalThis : null);
    if (keyTarget) {
      try {
        keyTarget.addEventListener('keydown', this._onKeyDown, true);
        keyTarget.addEventListener('keyup', this._onKeyUp, true);
      } catch (err) { /* 忽略 */ }
      this._keyTarget = keyTarget;
    }
    const canvas = this.canvas;
    if (canvas && typeof canvas.addEventListener === 'function') {
      this._onPointerDown = (ev) => this._handlePointerDown(ev);
      this._onPointerMove = (ev) => this._handlePointerMove(ev);
      this._onPointerUp = (ev) => this._handlePointerUp(ev);
      try {
        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointermove', this._onPointerMove);
        canvas.addEventListener('pointerup', this._onPointerUp);
        canvas.addEventListener('pointercancel', this._onPointerUp);
        canvas.addEventListener('touchstart', (ev) => ev.preventDefault(), { passive: false });
      } catch (err) { /* 忽略 */ }
    }
  }

  _unbindInput() {
    const keyTarget = this._keyTarget;
    if (keyTarget && typeof keyTarget.removeEventListener === 'function') {
      try {
        keyTarget.removeEventListener('keydown', this._onKeyDown, true);
        keyTarget.removeEventListener('keyup', this._onKeyUp, true);
      } catch (err) { /* 忽略 */ }
    }
    this._keyTarget = null;
    const canvas = this.canvas;
    if (canvas && typeof canvas.removeEventListener === 'function') {
      try {
        canvas.removeEventListener('pointerdown', this._onPointerDown);
        canvas.removeEventListener('pointermove', this._onPointerMove);
        canvas.removeEventListener('pointerup', this._onPointerUp);
        canvas.removeEventListener('pointercancel', this._onPointerUp);
      } catch (err) { /* 忽略 */ }
    }
  }

  _codeToLane(code) {
    const keys = LANE_KEYS[this.laneCount] || LANE_KEYS[4];
    const c = String(code || '').replace(/^Key/, '').toLowerCase();
    return keys.indexOf(c);
  }

  _handleKeyDown(ev) {
    if (!ev || this.destroyed || this.ended || this.paused || this.state !== 'playing') return;
    if (ev.repeat) return;
    const lane = this._codeToLane(ev.code);
    if (lane < 0) return;
    if (this._heldKeys.has(lane)) return;      // 已按住：忽略重复派发
    this._heldKeys.set(lane, true);
    if (ev.preventDefault) ev.preventDefault();
    this.core.press(lane, this.clock());
    this._addHeadEffect(lane);
  }

  _handleKeyUp(ev) {
    if (!ev || this.destroyed) return;
    const lane = this._codeToLane(ev.code);
    if (lane < 0) return;
    if (!this._heldKeys.has(lane)) return;
    this._heldKeys.delete(lane);
    if (this.ended) return;
    this.core.release(lane, this.clock());
  }

  _handlePointerDown(ev) {
    if (!ev || this.destroyed || this.ended || this.paused || this.state !== 'playing') return;
    const lane = this._laneFromX(nfin(ev.clientX, 0));
    if (ev.pointerId !== undefined) {
      if (this._pointers.has(ev.pointerId)) return;
      this._pointers.set(ev.pointerId, lane);
    }
    if (ev.preventDefault) ev.preventDefault();
    this.core.press(lane, this.clock());
    this._addHeadEffect(lane);
  }

  _handlePointerMove(ev) {
    if (!ev || this.destroyed || this.ended || this.paused || this.state !== 'playing') return;
    const id = ev.pointerId;
    const tracked = id !== undefined && this._pointers.has(id);
    const buttons = ev.buttons === undefined ? 0 : ev.buttons;
    if (!tracked && buttons === 0) return;   // 仅悬停不判定，必须是按住 / 触摸中的划动
    this.core.swipe(this._laneFromX(nfin(ev.clientX, 0)), this.clock());
  }

  _handlePointerUp(ev) {
    if (!ev) return;
    const id = ev.pointerId;
    if (id !== undefined && this._pointers.has(id)) {
      const lane = this._pointers.get(id);
      this._pointers.delete(id);
      if (!this.ended) this.core.release(lane, this.clock());
    }
  }

  // ---------- 特效 ----------

  _addHeadEffect(lane) {
    if (this._effects.length > 48) this._effects.shift();
    this._effects.push({ lane, t: this.time, life: 0.32, kind: 'ring' });
    if (this.renderMode === 'dom') this._domPunch(lane);
  }

  _pushJudgeText(grade, combo) {
    this._floaters.push({ grade, combo, t: this.time, life: 0.55 });
    if (this._floaters.length > 6) this._floaters.shift();
    if (this.renderMode === 'dom') this._domJudge(grade);
  }

  _updateEffects(dtMs) {
    const dt = dtMs / 1000;
    for (let i = this._effects.length - 1; i >= 0; i--) {
      this._effects[i].life -= dt;
      if (this._effects[i].life <= 0) this._effects.splice(i, 1);
    }
    for (let i = this._floaters.length - 1; i >= 0; i--) {
      this._floaters[i].life -= dt;
      if (this._floaters[i].life <= 0) this._floaters.splice(i, 1);
    }
  }

  // ---------- 渲染 ----------

  _scanVisible(t) {
    const notes = this.timeline.notes;
    const vy = (BASE_FALL_SPEED * this.speed) / 720;
    const hly = this.hitLineY;
    let i = this._renderCursor;
    while (i < notes.length) {
      const n = notes[i];
      const bottom = hly - (n.time + n.hold - t) * vy;
      if (bottom > 1.35) { i++; continue; }
      break;
    }
    this._renderCursor = i;
    const out = [];
    for (let k = i; k < notes.length; k++) {
      const n = notes[k];
      const y = hly - (n.time - t) * vy;
      if (y < -0.15) break;
      if (y > 1.35) continue;
      if (n.state === 'done') continue;
      out.push({ note: n, y, alpha: noteAlpha(y) });
    }
    return out;
  }

  // ---------- DOM 渲染后端 ----------
  //
  // 思路与 Sparebeat 一致：音符是 DOM 元素，每帧只改 `transform: translate3d()`，
  // 由浏览器合成器在独立线程完成动画，不需要逐像素光栅化。
  // 这在软件渲染 / 关闭 GPU 合成的环境里依然能保持连续下落（Canvas 则会退化成
  // 一帧一屏）。元素全部复用，不在每帧分配对象。

  _ensureDom() {
    if (this._dom) return this._dom;
    const host = this.hostEl || (this.canvas && this.canvas.parentElement ? this.canvas.parentElement : null);
    if (!host || typeof document === 'undefined') return null;
    if (host.style && (!host.style.position || host.style.position === 'static')) host.style.position = 'relative';
    // 元素池：音符
    const pool = [];
    const mkNote = () => {
      const n = document.createElement('div');
      n.className = 'phn-tap';
      n.setAttribute('aria-hidden', 'true');
      n.style.cssText =
        'position:absolute;top:0;left:0;will-change:transform;pointer-events:none;' +
        'border-radius:5px;transform:translate3d(0,-9999px,0);contain:layout style;';
      host.appendChild(n);
      return n;
    };
    const dom = {
      host,
      pool,
      mkNote,
      line: null,
      lanes: [],
      fx: [],
      hud: null,
      hudCombo: null,
      hudJudge: null,
      hudScore: null,
      hudAcc: null,
      hudTitle: null,
      hudBar: null,
      judgeTextT: 0,
      judgeTextGrade: '',
      lastSpeed: -1,
      lastLaneCount: -1
    };
    // 判定线（一个横贯的细条 + 中心点）
    const line = document.createElement('div');
    line.style.cssText =
      'position:absolute;left:0;right:0;height:4px;border-radius:3px;' +
      'will-change:transform;pointer-events:none;background:currentColor;' +
      'box-shadow:0 0 14px currentColor;transform:translate3d(0,0,0);';
    host.appendChild(line);
    dom.line = line;
    // HUD
    const hud = document.createElement('div');
    hud.style.cssText =
      'position:absolute;inset:0;pointer-events:none;font-family:"Segoe UI","PingFang SC",sans-serif;';
    const mkHud = (css) => {
      const el = document.createElement('div');
      el.style.cssText = css;
      hud.appendChild(el);
      return el;
    };
    dom.hud = hud;
    dom.hudCombo = mkHud(
      'position:absolute;left:0;right:0;top:26%;text-align:center;font-size:44px;font-weight:800;' +
        'color:#fff;text-shadow:0 0 18px rgba(255,255,255,0.35);will-change:transform;transform:translateZ(0);'
    );
    dom.hudJudge = mkHud(
      'position:absolute;left:0;right:0;top:36%;text-align:center;font-size:19px;font-weight:700;letter-spacing:0.14em;'
    );
    dom.hudScore = mkHud('position:absolute;right:14px;top:10px;text-align:right;font-size:22px;font-weight:700;color:#fff;');
    dom.hudAcc = mkHud('position:absolute;right:14px;top:38px;text-align:right;font-size:12px;color:rgba(233,240,255,0.75);');
    dom.hudTitle = mkHud('position:absolute;left:14px;top:10px;font-size:13px;color:rgba(233,240,255,0.9);');
    const barWrap = mkHud('position:absolute;left:14px;right:14px;top:0;height:3px;background:rgba(255,255,255,0.12);');
    dom.hudBar = document.createElement('i');
    dom.hudBar.style.cssText = 'display:block;height:100%;width:0;background:currentColor;';
    barWrap.appendChild(dom.hudBar);
    host.appendChild(hud);
    // 保留 canvas 作为输入目标（DOM 音符层 pointer-events:none，事件会穿透到 canvas），
    // 但让它透明且无滤镜——DOM 模式下画面完全由 DOM 元素呈现。
    if (this.canvas && this.canvas.style) {
      this.canvas.style.background = 'transparent';
      this.canvas.style.filter = 'none';
    }
    this._dom = dom;
    return dom;
  }

  _syncDomGeometry(dom) {
    const color = this.track.color || '#22d3ee';
    if (dom.lastLaneCount !== this.laneCount) {
      dom.lastLaneCount = this.laneCount;
      for (const l of dom.lanes) l.remove();
      dom.lanes = [];
      for (let i = 1; i < this.laneCount; i++) {
        const d = document.createElement('div');
        d.style.cssText =
          `position:absolute;top:0;bottom:0;width:1px;background:rgba(142,162,200,0.14);left:${((i / this.laneCount) * 100).toFixed(4)}%;`;
        dom.host.appendChild(d);
        dom.lanes.push(d);
      }
    }
    if (dom.lastSpeed !== this.speed) {
      dom.lastSpeed = this.speed;
    }
    dom.line.style.color = color;
    dom.hud.style.color = color;
    dom.hudBar.style.background = color;
    const laneW = this.w / this.laneCount;
    dom.noteW = laneW * (this.laneCount > 4 ? 0.62 : 0.72);
    dom.noteH = Math.max(9, Math.min(18, this.h * 0.022));
  }

  _renderDom(t, pausedFrame) {
    const dom = this._ensureDom();
    if (!dom) return false;
    this._syncDomGeometry(dom);
    const w = this.w;
    const h = this.h;
    const hitY = this.hitLineY * h;
    const color = this.track.color || '#22d3ee';
    const pulse = this.lowQuality ? 1 : 1 + 0.06 * Math.sin(t * 5.2);

    // 判定线：只在 y 上平移 + 高度脉动，全部交给合成器
    const lineH = this.lowQuality ? 3 : 4 * pulse;
    dom.line.style.height = `${lineH.toFixed(1)}px`;
    dom.line.style.transform = `translate3d(0,${(hitY - lineH / 2).toFixed(1)}px,0)`;
    dom.line.style.left = '0';
    dom.line.style.right = 'auto';
    dom.line.style.width = `${w}px`;

    // 音符
    const visible = this._scanVisible(t);
    const seen = new Set();
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const n = item.note;
      if (!n) continue;
      const key = n.__idx !== undefined ? n.__idx : (n.__idx = this._nextNoteIdx = (this._nextNoteIdx || 0) + 1);
      seen.add(key);
      const rec = this._noteEls.get(key);
      let el = rec ? rec.el : null;
      if (!el) {
        el = dom.pool.pop() || dom.mkNote();
        this._noteEls.set(key, { el, note: n });
        el.style.borderRadius = n.type === 'drag' ? '2px' : '5px';
        el.style.border = n.type === 'drag' ? '2px solid #fff' : 'none';
        el.style.background = n.type === 'drag' ? 'rgba(255,255,255,0.18)' : color;
        el.style.boxShadow = this.lowQuality ? 'none' : '0 0 10px rgba(0,0,0,0.35)';
      } else if (rec) {
        rec.note = n;
      }
      const cx = n.x * w;
      const y = item.y * h;
      const bw = dom.noteW;
      const bh = dom.noteH;
      const vy = (BASE_FALL_SPEED * this.speed) / 720; // 归一化高度/秒
      if (n.type === 'hold') {
        // hold 的柱体长度逐帧变化，由主循环绘制（数量少）
        const tailY = (this.hitLineY - (n.time + n.hold - t) * vy) * h;
        const topY = Math.max(0, Math.min(y, tailY));
        const botY = Math.max(y, tailY);
        const hh = Math.max(6, botY - topY);
        el.style.width = `${bw}px`;
        el.style.height = `${hh}px`;
        el.style.opacity = String(Math.max(0, Math.min(1, item.alpha)) * 0.55);
        el.style.transform = `translate3d(${(cx - bw / 2).toFixed(1)}px,${topY.toFixed(1)}px,0)`;
      } else {
        el.style.width = `${bw}px`;
        el.style.height = `${bh}px`;
        el.style.opacity = String(Math.max(0, Math.min(1, item.alpha)));
        // 逐帧写 transform：实测每帧仅 0.025ms，交给合成器线程合成
        el.style.transform = `translate3d(${(cx - bw / 2).toFixed(1)}px,${(y - bh / 2).toFixed(1)}px,0) rotate(${n.type === 'drag' ? '45deg' : '0deg'})`;
      }
    }
    // 回收：已判定完成的音符、以及离开可视区的音符，元素放回池子复用
    for (const [key, rec] of this._noteEls) {
      const el = rec && rec.el ? rec.el : null;
      if (!el) {
        this._noteEls.delete(key);
        continue;
      }
      const done = rec.note && rec.note.state === 'done';
      if (!seen.has(key) || done) {
        el.style.transform = 'translate3d(0,-9999px,0)';
        el.style.animationName = 'none';
        el._fall = false;
        dom.pool.push(el);
        this._noteEls.delete(key);
      }
    }

    // 打击特效：固定池，由本帧统一推进（无独立 rAF、无元素新建/删除）
    const fxList = dom.fx || [];
    const fxRate = 1 - Math.exp(-Math.max(1, Math.min(120, this._lastDtMs || 16.7)) / 420);
    for (let i = 0; i < fxList.length; i++) {
      const fx = fxList[i];
      if (!fx.active) continue;
      fx.k += fxRate;
      if (fx.k >= 1) {
        fx.k = 1;
        fx.active = false;
        fx.el.style.opacity = '0';
        fx.el.style.transform = 'translate3d(0,-9999px,0)';
        continue;
      }
      fx.el.style.transform = `translate3d(${(xOfLane(fx.lane, this.laneCount) * w - 18).toFixed(1)}px,${(hitY - 18).toFixed(1)}px,0) scale(${(1 + fx.k * 2.4).toFixed(3)})`;
      fx.el.style.opacity = String(Math.max(0, 0.85 * (1 - fx.k)));
    }

    // HUD
    const counts = this.core.counts;
    const combo = this.core.combo;
    dom.hudCombo.textContent = combo >= 3 ? String(combo) : '';
    dom.hudCombo.style.transform = `scale(${(1 + Math.min(0.25, combo / 400)).toFixed(3)})`;
    if (this._judgeFlash && this._judgeFlash.until > t) {
      dom.hudJudge.textContent = this._judgeFlash.label;
      dom.hudJudge.style.color = this._judgeFlash.color;
      dom.hudJudge.style.opacity = '1';
    } else {
      dom.hudJudge.style.opacity = '0';
    }
    const res = computeScore(counts, this.core.total);
    dom.hudScore.textContent = String(res.score);
    dom.hudAcc.textContent = `ACC ${(res.acc * 100).toFixed(2)}%  ${res.grade}`;
    dom.hudTitle.textContent = `${this.track.title || ''} · ${this.track.difficultyName || ''} ${this.track.difficulty || ''}`;
    const prog = this.timeline.duration > 0 ? Math.max(0, Math.min(1, t / this.timeline.duration)) : 0;
    dom.hudBar.style.width = `${(prog * 100).toFixed(2)}%`;
    return true;
  }

  /** 在 DOM 后端里生成一次打击环形特效（固定池 + 主循环统一驱动，绝不新建 rAF 链） */
  _domPunch(lane) {
    const dom = this._dom;
    if (!dom || typeof document === 'undefined') return;
    const POOL = 12;
    if (!dom.fx || dom.fx.length === 0) {
      dom.fx = [];
      for (let i = 0; i < POOL; i++) {
        const el = document.createElement('div');
        el.style.cssText =
          'position:absolute;left:0;top:0;width:36px;height:36px;border-radius:50%;' +
          'border:2px solid #fff;pointer-events:none;opacity:0;will-change:transform,opacity;transform:translate3d(0,-9999px,0);';
        dom.host.appendChild(el);
        dom.fx.push({ el, lane: 0, k: 1, active: false });
      }
    }
    // 取一个空闲槽位，全忙则覆盖最旧的
    let slot = dom.fx.find((f) => !f.active);
    if (!slot) {
      let oldest = dom.fx[0];
      for (const f of dom.fx) if (f.k > oldest.k) oldest = f;
      slot = oldest;
    }
    slot.lane = lane;
    slot.k = 0;
    slot.active = true;
    return slot;
  }

  /** 命中时更新中央判定文字 */
  _domJudge(grade) {
    const map = { perfect: '#ffe066', good: '#4ade80', bad: '#fb923c', miss: '#ef4444' };
    const label = { perfect: 'PERFECT', good: 'GOOD', bad: 'BAD', miss: 'MISS' };
    this._judgeFlash = { until: this.time + 0.42, label: label[grade] || '', color: map[grade] || '#fff' };
  }

  /** 长任务探针：抓出主线程上 >50ms 的同步任务，定位「整个页面卡」的真凶 */
  _startLongTaskProbe() {
    if (this._longTaskObserver) return;
    const g = typeof globalThis !== 'undefined' ? globalThis : null;
    if (!g || typeof g.PerformanceObserver !== 'function') return;
    this._longTasks = [];
    try {
      this._longTaskObserver = new g.PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          this._longTasks.push({ start: Math.round(entry.startTime), dur: Math.round(entry.duration) });
        }
        if (this._longTasks.length > 40) this._longTasks.splice(0, this._longTasks.length - 40);
      });
      this._longTaskObserver.observe({ entryTypes: ['longtask'] });
    } catch (err) {
      this._longTaskObserver = null;
    }
  }

  _stopLongTaskProbe() {
    if (!this._longTaskObserver) return;
    try { this._longTaskObserver.disconnect(); } catch (err) { /* 忽略 */ }
    this._longTaskObserver = null;
  }

  _destroyDom() {
    const dom = this._dom;
    if (!dom) return;
    for (const el of this._noteEls.values()) {
      const node = el && el.el ? el.el : el;
      if (node && node.remove) node.remove();
    }
    this._noteEls.clear();
    for (const slot of dom.fx || []) {
      const node = slot && slot.el ? slot.el : slot;
      if (node && node.remove) node.remove();
    }
    dom.fx = [];
    if (dom.line) dom.line.remove();
    if (dom.hud) dom.hud.remove();
    for (const l of dom.lanes) l.remove();
    for (const p of dom.pool) p.remove();
    dom.pool.length = 0;
    this._dom = null;
    if (this.canvas && this.canvas.style) {
      this.canvas.style.background = '';
      this.canvas.style.filter = '';
    }
  }

  _roundRect(c2d, x, y, w, h, r) {
    const rr = Math.max(0, Math.min(r, Math.min(w, h) / 2));
    c2d.beginPath();
    c2d.moveTo(x + rr, y);
    c2d.lineTo(x + w - rr, y);
    c2d.quadraticCurveTo(x + w, y, x + w, y + rr);
    c2d.lineTo(x + w, y + h - rr);
    c2d.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    c2d.lineTo(x + rr, y + h);
    c2d.quadraticCurveTo(x, y + h, x, y + h - rr);
    c2d.lineTo(x, y + rr);
    c2d.quadraticCurveTo(x, y, x + rr, y);
    c2d.closePath();
  }

  _render(t, pausedFrame) {
    // 隔离诊断模式：只跑判定与逻辑，不绘制任何东西
    if (this.noRender) return;
    // DOM 后端优先：CSS transform 交给合成器，弱 GPU 环境也能连续下落
    if (this.renderMode === 'dom') {
      try {
        if (this._renderDom(t, pausedFrame)) return;
      } catch (err) {
        // DOM 后端异常时退回 canvas，至少保证画面不空白
        this.renderMode = 'canvas';
        if (typeof console !== 'undefined' && console.warn) console.warn('[phigrOS/engine] DOM 渲染后端异常，已回退 canvas', err);
      }
    }
    const c2d = this._ensureCtx();
    if (!c2d) return;
    const w = this.w;
    const h = this.h;
    const laneCount = this.laneCount;
    const color = this.track.color || '#22d3ee';
    const lineX = lineXAt(this.chart, t) * w;
    const lineY = this.hitLineY * h;

    // 背景
    if (!this._bg) {
      const g = c2d.createLinearGradient(0, 0, 0, h);
      g.addColorStop(0, '#04060d');
      g.addColorStop(0.55, '#070b16');
      g.addColorStop(1, '#0b1020');
      this._bg = g;
    }
    c2d.fillStyle = this._bg;
    c2d.fillRect(0, 0, w, h);

    // 轨道分隔
    const laneW = w / laneCount;
    c2d.save();
    c2d.globalAlpha = 0.14;
    c2d.strokeStyle = '#8ea2c8';
    c2d.lineWidth = 1;
    for (let l = 1; l < laneCount; l++) {
      const x = Math.round(l * laneW) + 0.5;
      c2d.beginPath();
      c2d.moveTo(x, 0);
      c2d.lineTo(x, lineY + 24);
      c2d.stroke();
    }
    c2d.restore();

    // 判定线（辉光 + 脉动 + 按 lineXAt 移动）
    // shadowBlur 在真实 GPU 上非常昂贵（整条线宽度的离屏模糊），
    // 因此只有在非降载模式且窗口宽度不大时才使用辉光。
    const pulse = 1 + 0.12 * Math.sin(t * 5.2);
    const useGlow = !this.lowQuality && this.w <= 1400;
    // 命中判定线
    c2d.save();
    if (useGlow) c2d.globalCompositeOperation = 'lighter';
    c2d.strokeStyle = color;
    if (useGlow) {
      c2d.shadowColor = color;
      c2d.shadowBlur = 14 * pulse;
    }
    c2d.lineWidth = useGlow ? 4 : 3;
    c2d.beginPath();
    c2d.moveTo(0, lineY);
    c2d.lineTo(w, lineY);
    c2d.stroke();
    c2d.shadowBlur = 0;
    if (useGlow) {
      c2d.globalAlpha = 0.7;
      c2d.lineWidth = 1.5;
      c2d.beginPath();
      c2d.arc(lineX, lineY, 14 * pulse, 0, Math.PI * 2);
      c2d.stroke();
    }
    c2d.restore();

    // 音符
    const visible = this._scanVisible(t);
    const noteH = Math.max(10, Math.min(20, h * 0.022));
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i];
      const n = item.note;
      const cx = n.x * w;
      const y = item.y * h;
      const a = item.alpha;
      c2d.save();
      c2d.globalAlpha = a;
      if (n.type === 'hold') {
        const tailY = (this.hitLineY - (n.time + n.hold - t) * ((BASE_FALL_SPEED * this.speed) / 720)) * h;
        const bodyW = laneW * 0.62;
        const topY = Math.max(0, Math.min(y, tailY));
        const botY = Math.max(y, tailY);
        c2d.fillStyle = color;
        c2d.globalAlpha = a * 0.32;
        this._roundRect(c2d, cx - bodyW / 2, topY, bodyW, Math.max(6, botY - topY), bodyW * 0.3);
        c2d.fill();
        c2d.globalAlpha = a * 0.85;
        c2d.strokeStyle = color;
        c2d.lineWidth = 2;
        this._roundRect(c2d, cx - bodyW / 2, topY, bodyW, Math.max(6, botY - topY), bodyW * 0.3);
        c2d.stroke();
        // 尾端帽
        c2d.fillStyle = '#ffffff';
        c2d.globalAlpha = a * 0.9;
        this._roundRect(c2d, cx - bodyW / 2, topY - 3, bodyW, 6, 3);
        c2d.fill();
        // 头端块
        c2d.fillStyle = color;
        c2d.globalAlpha = a;
        this._roundRect(c2d, cx - bodyW / 2, y - noteH / 2, bodyW, noteH, noteH * 0.35);
        c2d.fill();
      } else if (n.type === 'drag') {
        const s = laneW * 0.34;
        c2d.translate(cx, y);
        c2d.rotate(Math.PI / 4);
        c2d.fillStyle = 'rgba(255,255,255,0.18)';
        c2d.fillRect(-s / 2, -s / 2, s, s);
        c2d.strokeStyle = '#ffffff';
        c2d.lineWidth = 2.5;
        c2d.strokeRect(-s / 2, -s / 2, s, s);
        c2d.restore();
        continue;
      } else {
        const bw = laneW * 0.72;
        c2d.fillStyle = color;
        this._roundRect(c2d, cx - bw / 2, y - noteH / 2, bw, noteH, noteH * 0.4);
        c2d.fill();
        c2d.globalAlpha = a * 0.55;
        c2d.fillStyle = '#ffffff';
        this._roundRect(c2d, cx - bw / 2 + 3, y - noteH / 2 + 2.5, bw - 6, noteH * 0.32, noteH * 0.2);
        c2d.fill();
      }
      c2d.restore();
    }

    // 打击特效
    for (let i = 0; i < this._effects.length; i++) {
      const e = this._effects[i];
      const k = 1 - Math.max(0, Math.min(1, e.life / 0.32));
      const cx = xOfLane(e.lane, laneCount) * w;
      c2d.save();
      c2d.globalAlpha = (1 - k) * 0.8;
      c2d.strokeStyle = '#ffffff';
      c2d.lineWidth = 2;
      c2d.beginPath();
      c2d.arc(cx, lineY, 8 + k * 34, 0, Math.PI * 2);
      c2d.stroke();
      c2d.restore();
    }

    // 中央 combo 与判定文字
    const combo = this.core.combo;
    c2d.save();
    c2d.textAlign = 'center';
    const comboSize = Math.max(28, Math.min(72, h * 0.1));
    c2d.font = '700 ' + comboSize + 'px "Segoe UI", system-ui, sans-serif';
    c2d.fillStyle = 'rgba(255,255,255,0.92)';
    c2d.globalAlpha = 0.9;
    c2d.fillText(String(combo), w / 2, lineY - h * 0.16);
    c2d.font = '600 ' + Math.round(comboSize * 0.28) + 'px "Segoe UI", system-ui, sans-serif';
    c2d.globalAlpha = 0.5;
    c2d.fillText('COMBO', w / 2, lineY - h * 0.16 + comboSize * 0.42);
    c2d.restore();

    for (let i = 0; i < this._floaters.length; i++) {
      const f = this._floaters[i];
      const k = Math.max(0, Math.min(1, f.life / 0.55));
      c2d.save();
      c2d.globalAlpha = k;
      c2d.textAlign = 'center';
      const size = Math.max(18, Math.min(40, h * 0.05)) * (1 + (1 - k) * 0.25);
      c2d.font = '700 ' + Math.round(size) + 'px "Segoe UI", system-ui, sans-serif';
      c2d.fillStyle = GRADE_COLOR[f.grade] || '#ffffff';
      c2d.fillText(GRADE_LABEL[f.grade] || String(f.grade).toUpperCase(), w / 2, lineY - h * 0.24 - (1 - k) * 26);
      c2d.restore();
    }

    // HUD：曲名 / 难度 / 进度（左上），分数与准确率（右上）
    const st = this.track;
    c2d.save();
    c2d.textAlign = 'left';
    c2d.font = '600 16px "Segoe UI", system-ui, sans-serif';
    c2d.fillStyle = 'rgba(255,255,255,0.94)';
    c2d.fillText(String(st.title || 'Untitled'), 16, 28);
    c2d.font = '500 12px "Segoe UI", system-ui, sans-serif';
    c2d.fillStyle = 'rgba(255,255,255,0.6)';
    c2d.fillText(String(st.artist || 'phigrOS Sound Team') + '   ·   ' + String(st.difficultyName || 'Easy') + ' ' + String(st.difficulty || 1), 16, 46);
    // 进度条
    const pw = Math.max(120, w * 0.34);
    const prog = this.timeline.duration > 0 ? Math.max(0, Math.min(1, t / this.timeline.duration)) : 0;
    c2d.fillStyle = 'rgba(255,255,255,0.14)';
    c2d.fillRect(16, 56, pw, 5);
    c2d.fillStyle = color;
    c2d.fillRect(16, 56, pw * prog, 5);

    const res = this.core.results();
    c2d.textAlign = 'right';
    c2d.font = '700 26px "Segoe UI", system-ui, sans-serif';
    c2d.fillStyle = 'rgba(255,255,255,0.96)';
    c2d.fillText(String(res.score).padStart(7, '0'), w - 16, 32);
    c2d.font = '500 13px "Segoe UI", system-ui, sans-serif';
    c2d.fillStyle = 'rgba(255,255,255,0.68)';
    c2d.fillText('准确率 ' + (res.acc * 100).toFixed(2) + '%   ·   ' + this.fps + ' FPS', w - 16, 52);
    c2d.restore();

    // 轨道键位提示
    const keys = LANE_KEYS[laneCount] || LANE_KEYS[4];
    c2d.save();
    c2d.textAlign = 'center';
    c2d.font = '600 13px "Segoe UI", system-ui, sans-serif';
    for (let l = 0; l < laneCount; l++) {
      const down = this._heldKeys.has(l) || this._pointersHasLane(l);
      c2d.globalAlpha = down ? 0.95 : 0.32;
      c2d.fillStyle = down ? color : '#ffffff';
      c2d.fillText(String(keys[l] || '').toUpperCase(), (l + 0.5) * laneW, h - 14);
    }
    c2d.restore();

    if (pausedFrame && this.paused) {
      c2d.save();
      c2d.fillStyle = 'rgba(0,0,0,0.45)';
      c2d.fillRect(0, 0, w, h);
      c2d.restore();
    }
  }

  _pointersHasLane(lane) {
    if (!this._pointers || !this._pointers.size) return false;
    for (const v of this._pointers.values()) if (v === lane) return true;
    return false;
  }
}

export default {
  JUDGE,
  DEFAULT_JUDGE_WINDOWS,
  judgeWindow,
  computeScore,
  visibleNotes,
  noteYAt,
  buildTimeline,
  lineXAt,
  JudgeCore,
  PhigrosGame,
};
