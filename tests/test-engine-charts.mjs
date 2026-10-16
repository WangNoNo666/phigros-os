// tests/test-engine-charts.mjs
// 曲目数据不变量自测（CONTRACT §7）+ 生成器确定性自测。
// 运行：node tests/test-engine-charts.mjs

import firstLight from '../data/charts/first-light.js';
import neonRunner from '../data/charts/neon-runner.js';
import voidCathedral from '../data/charts/void-cathedral.js';
import { generateChart, buildLines, sanitizeNotes, isOnGrid, xOfLane, laneOf } from '../js/engine/chartgen.js';

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) {
    passed++;
  } else {
    failed++;
    console.log('FAIL  ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
  }
}

const MIN_LANE_GAP = 0.09;
const GRID_DIV = 8;
const GRID_TOL = 0.001;   // ±1ms

const EXPECT = {
  'first-light': { laneCount: 4, difficulty: 4, difficultyName: 'Easy', min: 200, max: 300, bpm: 128, length: 96 },
  'neon-runner': { laneCount: 5, difficulty: 9, difficultyName: 'Hard', min: 550, max: 750, bpm: 150, length: 100 },
  'void-cathedral': { laneCount: 6, difficulty: 13, difficultyName: 'Extra', min: 900, max: 1200, bpm: 175, length: 105 },
};

const TRACKS = [
  ['first-light', firstLight],
  ['neon-runner', neonRunner],
  ['void-cathedral', voidCathedral],
];

const TYPE_SET = new Set(['tap', 'drag', 'hold']);

for (const [fileId, track] of TRACKS) {
  const exp = EXPECT[fileId];
  console.log('--- ' + fileId + ' ---');
  const notes = track.chart.notes;
  const laneCount = track.chart.laneCount;

  ok(fileId + ' id 与文件名一致', track.id === fileId, track.id);
  ok(fileId + ' bpm 正确', track.bpm === exp.bpm, track.bpm);
  ok(fileId + ' length 正确', track.length === exp.length, track.length);
  ok(fileId + ' 难度定数正确', track.difficulty === exp.difficulty, track.difficulty);
  ok(fileId + ' 难度名正确', track.difficultyName === exp.difficultyName, track.difficultyName);
  ok(fileId + ' laneCount 正确', laneCount === exp.laneCount, laneCount);
  ok(fileId + ' 音符数在预期区间 [' + exp.min + ',' + exp.max + ']', notes.length >= exp.min && notes.length <= exp.max, notes.length);
  ok(fileId + ' 音符数组非空', Array.isArray(notes) && notes.length > 0);

  // time 严格递增
  let strict = true;
  let firstBad = -1;
  for (let i = 1; i < notes.length; i++) {
    if (!(notes[i].time > notes[i - 1].time)) { strict = false; firstBad = i; break; }
  }
  ok(fileId + ' time 严格递增', strict, firstBad >= 0 ? { index: firstBad, prev: notes[firstBad - 1].time, cur: notes[firstBad].time } : undefined);

  // x 范围 / 类型 / hold 时长 / grid / lane 对齐
  let xOk = true;
  let typeOk = true;
  let holdOk = true;
  let gridOk = true;
  let laneAligned = true;
  let laneAlignBad = null;
  let boundOk = true;
  for (const n of notes) {
    if (!(n.x >= 0 && n.x <= 1)) xOk = false;
    if (!TYPE_SET.has(n.type)) typeOk = false;
    if (n.type === 'hold') {
      if (!(n.hold >= 0.2 && n.hold <= 3)) holdOk = false;
    } else if (n.hold !== undefined && n.hold !== 0) {
      holdOk = false;
    }
    if (!isOnGrid(n.time, track.bpm, GRID_DIV, GRID_TOL)) gridOk = false;
    const lane = laneOf(n.x, laneCount);
    const want = xOfLane(lane, laneCount);
    if (Math.abs(n.x - want) > 1e-6) { laneAligned = false; laneAlignBad = n; }
    if (!(n.time >= 0 && n.time + (n.hold || 0) <= track.length)) boundOk = false;
  }
  ok(fileId + ' x 全部在 [0,1]', xOk);
  ok(fileId + ' type 仅 tap/drag/hold', typeOk);
  ok(fileId + ' hold 时长 0.2~3 秒，非 hold 不带时长', holdOk);
  ok(fileId + ' 所有 time 落在 BPM 1/8 拍网格 ±1ms', gridOk);
  ok(fileId + ' x 与 lane 中心对齐', laneAligned, laneAlignBad);
  ok(fileId + ' 音符不超出曲目时长', boundOk);

  // 同 lane 最小间隔
  const lastByLane = new Map();
  let minGap = Infinity;
  let gapBad = null;
  for (const n of notes) {
    const lane = laneOf(n.x, laneCount);
    if (lastByLane.has(lane)) {
      const gap = n.time - lastByLane.get(lane);
      if (gap < minGap) minGap = gap;
      if (gap < MIN_LANE_GAP - 1e-9) gapBad = { lane, prev: lastByLane.get(lane), time: n.time, gap };
    }
    lastByLane.set(lane, n.time + (n.type === 'hold' ? n.hold : 0));
  }
  ok(fileId + ' 同 lane 相邻间隔 >= 0.09s', gapBad === null, gapBad || { minGap });
  console.log('      音符数=' + notes.length + ' 最小同轨间隔=' + minGap.toFixed(4) + 's');

  // 判定线
  const lines = track.chart.lines;
  ok(fileId + ' 至少 4 段判定线', Array.isArray(lines) && lines.length >= 4, lines && lines.length);
  let lineOk = true;
  let lineAtOk = true;
  let prevAt = -Infinity;
  for (const l of lines) {
    if (!(l.x >= 0.3 && l.x <= 0.7)) lineOk = false;
    if (!(l.at >= prevAt)) lineAtOk = false;
    prevAt = l.at;
  }
  ok(fileId + ' 判定线 x 在 0.3~0.7', lineOk);
  ok(fileId + ' 判定线 at 递增', lineAtOk);
  ok(fileId + ' 判定线首段在 0 秒', lines[0].at === 0, lines[0]);
  let moveOk = false;
  for (let i = 1; i < lines.length; i++) if (Math.abs(lines[i].x - lines[i - 1].x) > 0.05) moveOk = true;
  ok(fileId + ' 判定线确实在移动', moveOk);

  // music 曲式
  const music = track.music;
  ok(fileId + ' music.sections 存在', !!(music && Array.isArray(music.sections) && music.sections.length >= 3));
  ok(fileId + ' music 段落首段 at=0', music.sections[0].at === 0, music.sections[0]);
  let secOk = true;
  let secAtOk = true;
  let prevSecAt = -Infinity;
  for (const s of music.sections) {
    if (!(s.bars > 0)) secOk = false;
    if (!(s.at >= prevSecAt)) secAtOk = false;
    prevSecAt = s.at;
    if (typeof s.drums !== 'string' && typeof s.bass !== 'string' && typeof s.pad !== 'string') secOk = false;
  }
  ok(fileId + ' music 段落字段合法', secOk);
  ok(fileId + ' music 段落 at 递增', secAtOk);

  // chart.stats 与实际一致
  const stats = track.chart.stats || {};
  ok(fileId + ' stats.noteCount 与实际一致', stats.noteCount === notes.length, { stats: stats.noteCount, real: notes.length });
  ok(fileId + ' stats 无丢弃音符', stats.dropped === 0, stats.dropped);

  // 同 lane 分布：不能只用一个 lane
  ok(fileId + ' 使用了全部 lane', lastByLane.size === laneCount, { used: lastByLane.size, laneCount });
}

// ---------------------------------------------------------------- 生成器确定性

console.log('--- generateChart 确定性 ---');
const opts = { bpm: 150, length: 100, laneCount: 5, density: 1.3, style: 'stream', seed: 12345 };
const a = generateChart(opts);
const b = generateChart(opts);

function deepEqual(x, y) {
  if (x === y) return true;
  if (typeof x !== typeof y) return false;
  if (x === null || y === null) return false;
  if (Array.isArray(x) || Array.isArray(y)) {
    if (!Array.isArray(x) || !Array.isArray(y) || x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!deepEqual(x[i], y[i])) return false;
    return true;
  }
  if (typeof x === 'object') {
    const kx = Object.keys(x).sort();
    const ky = Object.keys(y).sort();
    if (kx.length !== ky.length) return false;
    for (let i = 0; i < kx.length; i++) {
      if (kx[i] !== ky[i]) return false;
      if (!deepEqual(x[kx[i]], y[ky[i]])) return false;
    }
    return true;
  }
  return false;
}

ok('同 seed 两次调用深度相等（notes）', deepEqual(a.notes, b.notes));
ok('同 seed 两次调用深度相等（整个谱面）', deepEqual(a, b));
const c = generateChart({ ...opts, seed: 54321 });
ok('不同 seed 结果不同', !deepEqual(a.notes, c.notes));
ok('确定性结果非空', a.notes.length > 400, a.notes.length);

// 生成器产出的不变量
let genStrict = true;
let genGapBad = null;
let genGridOk = true;
const lastLane = new Map();
for (let i = 0; i < a.notes.length; i++) {
  const n = a.notes[i];
  if (i > 0 && !(n.time > a.notes[i - 1].time)) genStrict = false;
  if (!isOnGrid(n.time, opts.bpm, GRID_DIV, GRID_TOL)) genGridOk = false;
  const lane = laneOf(n.x, opts.laneCount);
  if (lastLane.has(lane) && n.time - lastLane.get(lane) < MIN_LANE_GAP - 1e-9) genGapBad = n;
  lastLane.set(lane, n.time + (n.type === 'hold' ? n.hold : 0));
}
ok('生成器：time 严格递增', genStrict);
ok('生成器：同 lane 间隔 >= 0.09s', genGapBad === null, genGapBad);
ok('生成器：时间落在网格上', genGridOk);
ok('生成器：laneCount 透传', a.laneCount === 5, a.laneCount);

// ---------------------------------------------------------------- 净化函数

console.log('--- sanitizeNotes ---');
const dirty = [
  { time: 2.0, x: 0.125, type: 'tap' },
  { time: 1.0, x: 0.375, type: 'tap' },
  { time: 1.0, x: 0.625, type: 'tap' },          // 同刻：应被去重
  { time: 1.05, x: 0.375, type: 'tap' },         // 同 lane 间隔 0.05 < 0.09：应被丢弃
  { time: 3.0, x: 0.375, type: 'hold', hold: 9 },// hold 超长：夹到 3
  { time: -1, x: 0.5, type: 'tap' },             // 负时间：丢弃
  { time: 4.0, x: 2, type: 'boom' },             // x 越界 + 类型非法
  { time: Number.NaN, x: 0.5, type: 'tap' },     // 非法时间：丢弃
];
const clean = sanitizeNotes(dirty, { bpm: 128, laneCount: 4, gridDiv: 8, minGap: 0.09 });
ok('净化后非空', clean.notes.length >= 3, clean.notes.length);
ok('净化丢弃了非法音符', clean.dropped >= 3, clean.dropped);
let sanitizeStrict = true;
for (let i = 1; i < clean.notes.length; i++) if (!(clean.notes[i].time > clean.notes[i - 1].time)) sanitizeStrict = false;
ok('净化后严格递增', sanitizeStrict, clean.notes);
let sanitizeX = true;
let sanitizeType = true;
let sanitizeHold = true;
for (const n of clean.notes) {
  if (!(n.x >= 0 && n.x <= 1)) sanitizeX = false;
  if (!TYPE_SET.has(n.type)) sanitizeType = false;
  if (n.type === 'hold' && !(n.hold >= 0.2 && n.hold <= 3)) sanitizeHold = false;
}
ok('净化后 x 合法', sanitizeX);
ok('净化后类型合法', sanitizeType);
ok('净化后 hold 合法', sanitizeHold);

const linesShort = buildLines({ bpm: 100, length: 3, segBars: 8 });
ok('极短曲目也至少 4 段判定线', linesShort.length >= 4, linesShort.length);

// ---------------------------------------------------------------- 汇总

console.log('');
console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
