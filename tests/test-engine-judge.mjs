// tests/test-engine-judge.mjs
// 判定 / 计分 / 可见性纯函数自测 + 假时钟驱动的完整判定流程。
// 运行：node tests/test-engine-judge.mjs
// 不依赖 DOM / AudioContext。

import {
  judgeWindow,
  computeScore,
  visibleNotes,
  noteYAt,
  buildTimeline,
  lineXAt,
  laneOf,
  JudgeCore,
  JUDGE,
  DEFAULT_JUDGE_WINDOWS,
} from '../js/engine/phigros.js';

let passed = 0;
let failed = 0;

function ok(name, cond, extra) {
  if (cond) {
    passed++;
    console.log('PASS  ' + name);
  } else {
    failed++;
    console.log('FAIL  ' + name + (extra === undefined ? '' : '  -> ' + JSON.stringify(extra)));
  }
}

function eq(name, actual, expected) {
  const same = Object.is(actual, expected);
  ok(name, same, same ? undefined : { actual, expected });
}

function near(name, actual, expected, tol) {
  const t = tol === undefined ? 1e-9 : tol;
  const same = Math.abs(actual - expected) <= t;
  ok(name, same, same ? undefined : { actual, expected, tol: t });
}

function words(name, cond, extra) {
  ok(name, cond, extra);
}

// ---------------------------------------------------------------- judgeWindow

console.log('--- judgeWindow 边界 ---');
const j0 = judgeWindow(0);
eq('0ms -> perfect', j0.grade, 'perfect');
eq('perfect 单键系数 1', j0.score, 1);
eq('judgeWindow label', j0.label, 'PERFECT');

const j45 = judgeWindow(45);
eq('45ms -> perfect', j45.grade, 'perfect');
eq('45ms score', j45.score, 1);

const j451 = judgeWindow(45.1);
eq('45.1ms -> good', j451.grade, 'good');
eq('good 单键系数 0.65', j451.score, 0.65);
eq('good label', j451.label, 'GOOD');

const j90 = judgeWindow(90);
eq('90ms -> good', j90.grade, 'good');

const j901 = judgeWindow(90.1);
eq('90.1ms -> bad', j901.grade, 'bad');
eq('bad 单键系数 0.30', j901.score, 0.30);
eq('bad label', j901.label, 'BAD');

const j150 = judgeWindow(150);
eq('150ms -> bad', j150.grade, 'bad');

const j1501 = judgeWindow(150.1);
eq('150.1ms -> miss', j1501.grade, 'miss');
eq('miss 单键系数 0', j1501.score, 0);
eq('miss label', j1501.label, 'MISS');

const jneg45 = judgeWindow(-45);
eq('-45ms 取绝对值 -> perfect', jneg45.grade, 'perfect');
eq('-45ms abs 记录', jneg45.absDiffMs, 45);

const jneg150 = judgeWindow(-150.1);
eq('-150.1ms -> miss', jneg150.grade, 'miss');

const jnan = judgeWindow(NaN);
eq('NaN -> miss（不抛异常）', jnan.grade, 'miss');

eq('DEFAULT_JUDGE_WINDOWS.perfect', DEFAULT_JUDGE_WINDOWS.perfect, 45);
eq('DEFAULT_JUDGE_WINDOWS.good', DEFAULT_JUDGE_WINDOWS.good, 90);
eq('DEFAULT_JUDGE_WINDOWS.bad', DEFAULT_JUDGE_WINDOWS.bad, 150);
eq('JUDGE 常数', JUDGE.MISS, 4);

// ---------------------------------------------------------------- computeScore

console.log('--- computeScore ---');
const allPerfect = computeScore({ perfect: 100, good: 0, bad: 0, miss: 0 }, 100);
eq('全 perfect 分数 1000000', allPerfect.score, 1000000);
eq('全 perfect acc', allPerfect.acc, 1);
eq('全 perfect 评级 S', allPerfect.grade, 'S');
eq('全 perfect fc', allPerfect.fc, true);

const oneMiss = computeScore({ perfect: 99, good: 0, bad: 0, miss: 1 }, 100);
eq('1 miss -> fc=false', oneMiss.fc, false);
eq('1 miss 分数', oneMiss.score, 990000);
eq('1 miss 评级 A', oneMiss.grade, 'A');

const zero = computeScore({ perfect: 0, good: 0, bad: 0, miss: 0 }, 0);
eq('total=0 分数 0', zero.score, 0);
eq('total=0 acc 0', zero.acc, 0);
eq('total=0 评级 F', zero.grade, 'F');
eq('total=0 fc false', zero.fc, false);
eq('total=0 maxCombo 0', zero.maxCombo, 0);
const neg = computeScore({ perfect: 1, good: 0, bad: 0, miss: 0 }, -5);
eq('total<0 不崩且为 0', neg.score, 0);

// acc 阈值边界：0.93 / 0.85 / 0.70
const acc93 = computeScore({ perfect: 93, good: 0, bad: 0, miss: 7 }, 100);
near('acc 0.93 精确', acc93.acc, 0.93, 1e-12);
eq('acc 0.93 -> A', acc93.grade, 'A');
const acc9299 = computeScore({ perfect: 92, good: 1, bad: 0, miss: 7 }, 100);
words('acc 略低于 0.93 -> B', acc9299.acc < 0.93 && acc9299.grade === 'B', { acc: acc9299.acc, grade: acc9299.grade });

const acc85 = computeScore({ perfect: 85, good: 0, bad: 0, miss: 15 }, 100);
near('acc 0.85 精确', acc85.acc, 0.85, 1e-12);
eq('acc 0.85 -> B', acc85.grade, 'B');
const acc8499 = computeScore({ perfect: 84, good: 1, bad: 0, miss: 15 }, 100);
words('acc 略低于 0.85 -> C', acc8499.acc < 0.85 && acc8499.grade === 'C', { acc: acc8499.acc, grade: acc8499.grade });

const acc70 = computeScore({ perfect: 70, good: 0, bad: 0, miss: 30 }, 100);
near('acc 0.70 精确', acc70.acc, 0.70, 1e-12);
eq('acc 0.70 -> C', acc70.grade, 'C');
const acc69 = computeScore({ perfect: 69, good: 0, bad: 0, miss: 31 }, 100);
words('acc 0.69 -> F', acc69.grade === 'F', { acc: acc69.acc, grade: acc69.grade });

// 有 good 时即使 acc 很高也不是 S
const withGood = computeScore({ perfect: 99, good: 1, bad: 0, miss: 0 }, 100);
eq('有 good 不给 S', withGood.grade, 'A');
eq('有 good acc', withGood.acc, 0.9965);
eq('有 good 仍 fc', withGood.fc, true);

// ---------------------------------------------------------------- visibleNotes

console.log('--- visibleNotes ---');
const HLY = 0.86;
const vy = 520 / 720;                      // speed=1 时归一化速度
const timeForY = (y) => (HLY - y) / vy;    // 由目标 y 反推音符时间（t=0）
const chartForVis = {
  laneCount: 4,
  notes: [
    { time: timeForY(0.5), x: 0.125, type: 'tap' },     // y = 0.5
    { time: timeForY(0.86), x: 0.375, type: 'tap' },    // 恰好 y = 0.86（判定线）
    { time: 100, x: 0.625, type: 'tap' },               // 远在未来（不可见）
    { time: timeForY(1.16), x: 0.875, type: 'tap' },    // y = 1.16（判定线下方）
  ],
};
const vis = visibleNotes(chartForVis.notes, 0, 1, HLY);
eq('可见音符数量（过滤越界）', vis.length, 3);
near('判定线位置换算：y=0.5', vis[0].y, 0.5, 1e-9);
near('判定线位置换算：y=0.86', vis[1].y, 0.86, 1e-9);
near('判定线下方 y=1.16', vis[2].y, 1.16, 1e-9);
words('远未来音符被过滤', vis.every((v) => v.note.time < 10));

// 速度换算：speed=2 时同样时间差下落的归一化距离翻倍
const y1 = noteYAt({ time: 1 }, 0, 1, HLY);
const y2 = noteYAt({ time: 1 }, 0, 2, HLY);
near('speed=1 归一化下落量', HLY - y1, vy, 1e-9);
near('speed=2 下落量翻倍', HLY - y2, vy * 2, 1e-9);
const yBad = noteYAt({ time: 1 }, 0, Number.NaN, HLY);
near('非法 speed 回落 1.0', yBad, y1, 1e-9);
const yZero = noteYAt({ time: 1 }, 0, 0, HLY);
near('speed=0 回落 1.0', yZero, y1, 1e-9);

// 越界过滤：y < -0.15 不返回
const above = [{ time: timeForY(-0.1501), x: 0.5, type: 'tap' }];
eq('y < -0.15 被过滤', visibleNotes(above, 0, 1, HLY).length, 0);
const exactly = [{ time: timeForY(-0.1499), x: 0.5, type: 'tap' }];
const exactVis = visibleNotes(exactly, 0, 1, HLY);
eq('y 略高于 -0.15 时保留', exactVis.length, 1);
words('接近顶部时 alpha 很小', exactVis.length === 1 && exactVis[0].alpha > 0 && exactVis[0].alpha < 0.02, exactVis[0] && exactVis[0].alpha);

// alpha 单调性：y 越小 alpha 越小
function noteAlphaOf(y) {
  const notes = [{ time: timeForY(y), x: 0.5, type: 'tap' }];
  const r = visibleNotes(notes, 0, 1, HLY);
  return r.length ? r[0].alpha : -1;
}
const alphas = [];
for (let k = 0; k <= 15; k++) {
  const y = -0.14 + (k / 15) * 0.14;   // -0.14 .. 0
  alphas.push(noteAlphaOf(y));
}
let monotonic = true;
for (let i = 1; i < alphas.length; i++) if (alphas[i] + 1e-12 < alphas[i - 1]) monotonic = false;
words('alpha 随 y 单调不减', monotonic, alphas);
words('alpha 在 y=0 处为 1', Math.abs(alphas[alphas.length - 1] - 1) < 1e-9, alphas[alphas.length - 1]);

// 已判定音符不再返回
const judged = [{ time: 0, x: 0.5, type: 'tap', judged: true }];
eq('已判定音符被过滤', visibleNotes(judged, 0, 1, HLY).length, 0);
const doneState = [{ time: 0, x: 0.5, type: 'tap', state: 'done' }];
eq('state=done 被过滤', visibleNotes(doneState, 0, 1, HLY).length, 0);

// ---------------------------------------------------------------- buildTimeline / lineXAt

console.log('--- buildTimeline / lineXAt ---');
const rawChart = {
  laneCount: 4,
  offset: 0,
  lines: [
    { at: 0, x: 0.5, angle: 0 },
    { at: 10, x: 0.4, angle: 0 },
    { at: 20, x: 0.6, angle: 0 },
    { at: 30, x: 0.5, angle: 0 },
  ],
  notes: [
    { time: 3, x: 0.625, type: 'hold', hold: 9 },      // hold 会被夹到 3 秒
    { time: 1, x: 0.125, type: 'tap' },                // 顺序错乱，需要排序
    { time: 'x', x: 0.5, type: 'tap' },                // 非法时间，应被过滤
    { time: 2, x: 99, type: 'weird' },                 // x 越界 + 非法类型
    { time: 2.5, x: 0.375, type: 'drag' },
  ],
};
const tl = buildTimeline(rawChart);
eq('非法音符被过滤', tl.total, 4);
eq('时间已排序', tl.notes.map((n) => n.time).join(','), '1,2,2.5,3');
eq('类型非法回落 tap', tl.notes[1].type, 'tap');
near('x 越界被夹取', tl.notes[1].x, 1, 1e-12);
near('hold 时长夹取到 3', tl.notes[3].hold, 3, 1e-12);
eq('lane 由 x 换算', tl.notes[0].lane, 0);
eq('lane 由 x 换算(0.625 -> 2)', tl.notes[3].lane, 2);
near('duration 含 hold 尾端', tl.duration, 6, 1e-9);

near('lineXAt 段端点', lineXAt(rawChart, 10), 0.4, 1e-9);
near('lineXAt 段中点插值', lineXAt(rawChart, 15), 0.5, 1e-9);
near('lineXAt 起始值', lineXAt(rawChart, -5), 0.5, 1e-9);
near('lineXAt 末尾保持', lineXAt(rawChart, 999), 0.5, 1e-9);
near('lineXAt 兼容 track 入参', lineXAt({ chart: rawChart }, 15), 0.5, 1e-9);
eq('lineXAt 缺省 0.5', lineXAt({}, 3), 0.5);

// ---------------------------------------------------------------- 假时钟：完整流程

console.log('--- 假时钟驱动的完整判定流程（100 音符）---');

/** 构造 100 个音符：4 lane、tap/drag/hold 混合，均匀分布 */
function makeHundred() {
  const notes = [];
  const laneCount = 4;
  for (let i = 0; i < 100; i++) {
    const lane = i % laneCount;
    const x = (lane + 0.5) / laneCount;
    let type = 'tap';
    if (i % 11 === 5) type = 'drag';
    else if (i % 13 === 7) type = 'hold';
    const note = { time: 1 + i * 0.5, x, type };
    if (type === 'hold') note.hold = 0.6;
    notes.push(note);
  }
  return notes;
}

const HUNDRED = makeHundred();
const HUNDRED_LANES = HUNDRED.map((n) => laneOf(n.x, 4));

/** 用固定步长的假时钟推进，press 回调决定每个音符怎么打 */
function runFlow(notes, lanes, pressPlan, dt) {
  const core = new JudgeCore({ laneCount: 4, notes: notes.map((n) => ({ ...n })) }, { laneCount: 4 });
  const step = dt || 1 / 120;
  let t = 0;
  let i = 0;
  const releases = [];
  const log = [];
  let guard = 0;
  while (core.resolved < core.total && guard++ < 400000) {
    t += step;
    core.tick(t);
    while (i < notes.length && notes[i].time <= t + 1e-9) {
      const idx = i;
      const n = notes[i];
      const lane = lanes[i];
      i++;
      const plan = pressPlan(idx, n, lane, t);
      if (plan === 'skip') continue;
      const at = plan === 'late' ? n.time + 0.060 : (plan === 'early' ? n.time - 0.120 : n.time);
      if (plan === 'wrong-lane') { core.press((lane + 1) % 4, at); continue; }
      core.press(lane, at);
      log.push({ idx, lane, at });
      if (n.type === 'hold' && plan !== 'hold-release-early') {
        releases.push({ lane, at: n.time + n.hold + 1e-6 });
      } else if (n.type === 'hold') {
        releases.push({ lane, at: n.time + Math.min(0.05, n.hold / 2) });
      }
    }
    for (let k = releases.length - 1; k >= 0; k--) {
      if (t >= releases[k].at) {
        core.release(releases[k].lane, releases[k].at);
        releases.splice(k, 1);
      }
    }
  }
  core.tick(notes[notes.length - 1].time + 5);
  return core;
}

// (1) 全 perfect
const perfectRun = runFlow(HUNDRED, HUNDRED_LANES, () => 'perfect');
const pr = perfectRun.results();
eq('100 音符 resolved 全部结算', perfectRun.resolved, 100);
eq('全 perfect 计数', pr.counts.perfect, 100);
eq('计数之和 = 音符总数', pr.counts.perfect + pr.counts.good + pr.counts.bad + pr.counts.miss, 100);
eq('全 perfect 分数', pr.score, 1000000);
eq('全 perfect 评级', pr.grade, 'S');
eq('全 perfect fc', pr.fc, true);
eq('全 perfect maxCombo', pr.maxCombo, 100);

// (2) 每 7 个音漏掉一个（漏掉 14 个），其余按下
const skipSet = new Set();
for (let i = 0; i < 100; i += 7) skipSet.add(i);
const skipRun = runFlow(HUNDRED, HUNDRED_LANES, (idx) => (skipSet.has(idx) ? 'skip' : 'perfect'));
const sr = skipRun.results();
eq('漏音符数量正确', sr.counts.miss, skipSet.size);
eq('漏音符后计数之和仍然 = 100', sr.counts.perfect + sr.counts.good + sr.counts.bad + sr.counts.miss, 100);
eq('漏音符 resolved = 100', skipRun.resolved, 100);
eq('有 miss 则 fc=false', sr.fc, false);
words('有 miss 时 maxCombo < 100', sr.maxCombo < 100, sr.maxCombo);
words('分数低于满分', sr.score < 1000000, sr.score);

// (3) combo 归零逻辑：连续判定后漏一个，combo 必须归零
{
  const core = new JudgeCore({ laneCount: 4, notes: [{ time: 1, x: 0.125, type: 'tap' }, { time: 2, x: 0.375, type: 'tap' }, { time: 3, x: 0.625, type: 'tap' }] });
  core.press(0, 1);
  eq('第一次判定后 combo=1', core.combo, 1);
  core.press(1, 2);
  eq('第二次判定后 combo=2', core.combo, 2);
  core.tick(3 + 0.151);              // 第三个音符超时 -> miss
  eq('miss 后 combo 归零', core.combo, 0);
  eq('miss 计数', core.counts.miss, 1);
  eq('保留 maxCombo', core.maxCombo, 2);
  eq('结算计数之和', core.results().counts.perfect + core.results().counts.miss, 3);
}

// (4) miss 边界：time + 150ms 不判 miss，time + 150ms 之后才判
{
  const core = new JudgeCore({ laneCount: 4, notes: [{ time: 1, x: 0.125, type: 'tap' }] });
  core.tick(1.15);
  eq('恰好 150ms 不判 miss', core.counts.miss, 0);
  core.tick(1.1501);
  eq('超过 150ms 判 miss', core.counts.miss, 1);
  eq('miss 后 resolved=1', core.resolved, 1);
}

// (5) 判定窗口边界：|diff| <= 150 才能被按下吸收
{
  const core = new JudgeCore({ laneCount: 4, notes: [{ time: 1, x: 0.125, type: 'tap' }] });
  const r = core.press(0, 1 + 0.1501);
  eq('超出窗口按键不吸收', r, null);
  eq('超窗未判 miss（等待 tick）', core.counts.miss, 0);
}
{
  const core = new JudgeCore({ laneCount: 4, notes: [{ time: 1, x: 0.125, type: 'tap' }] });
  const r2 = core.press(0, 1 + 0.12);
  words('窗口内按键记为 bad', r2 && r2.grade === 'bad', r2);
}

// (6) 优先吃 time <= current 中最晚的一个
{
  const core = new JudgeCore({
    laneCount: 4,
    notes: [
      { time: 1.0, x: 0.125, type: 'tap' },
      { time: 1.1, x: 0.125, type: 'tap' },
    ],
  });
  const r = core.press(0, 1.12);
  eq('优先判定最晚的过去音符（index=1）', r.index, 1);
  eq('偏差 20ms 记 perfect', r.grade, 'perfect');
}
{
  const core = new JudgeCore({
    laneCount: 4,
    notes: [
      { time: 1.0, x: 0.125, type: 'tap' },
      { time: 1.1, x: 0.125, type: 'tap' },
    ],
  });
  const r = core.press(0, 1.2);
  eq('偏差 100ms 时仍然优先最晚的过去音符', r.index, 1);
  eq('偏差 100ms 记 bad', r.grade, 'bad');
}

// (7) hold：到点仍按住 -> 按头判定计分；中途松手 -> bad
{
  const core = new JudgeCore({ laneCount: 4, notes: [{ time: 1, x: 0.125, type: 'hold', hold: 1 }] });
  core.press(0, 1.01);
  eq('hold 头部按下不立即计数', core.counts.perfect + core.counts.bad + core.counts.miss, 0);
  core.tick(2.0);
  eq('hold 到点计头判定等级', core.counts.perfect, 1);
  eq('hold 结算 resolved=1', core.resolved, 1);
  eq('hold 计 combo', core.maxCombo, 1);
}
{
  const core = new JudgeCore({ laneCount: 4, notes: [{ time: 1, x: 0.125, type: 'hold', hold: 1 }] });
  core.press(0, 1.0);
  core.release(0, 1.3);
  eq('hold 中途松手记 bad', core.counts.bad, 1);
  eq('hold 中途松手分数系数 0.3', core.results().acc, 0.3);
}

// (8) drag：划到固定 perfect
{
  const core = new JudgeCore({
    laneCount: 4,
    notes: [
      { time: 1, x: 0.125, type: 'drag' },
      { time: 1.2, x: 0.375, type: 'tap' },
    ],
  });
  const r = core.swipe(0, 1.05);
  eq('划动 drag 判定 perfect', r.grade, 'perfect');
  eq('划动不误伤相邻 tap', core.notes[1].state, 'idle');
  core.press(1, 1.2);
  eq('tap 正常判定', core.counts.perfect, 2);
}

// (9) missRemaining（结算 / 冒烟测试 finish 路径）
{
  const core = new JudgeCore({ laneCount: 4, notes: HUNDRED.map((n) => ({ ...n })) });
  core.press(0, 1);
  core.missRemaining(1.2);
  const r = core.results();
  eq('missRemaining 后全部结算', core.resolved, 100);
  eq('missRemaining 计数之和 = 100', r.counts.perfect + r.counts.good + r.counts.bad + r.counts.miss, 100);
  eq('剩余全部 miss', r.counts.miss, 99);
}

// (10) 假时钟完整流程：counts 之和恒等于音符总数（多种打法混合）
{
  const mixRun = runFlow(HUNDRED, HUNDRED_LANES, (idx, n) => {
    if (idx % 17 === 3) return 'skip';
    if (idx % 19 === 4) return 'late';
    if (idx % 23 === 9) return 'early';
    if (idx % 29 === 11) return 'wrong-lane';
    if (n.type === 'hold' && idx % 31 === 13) return 'hold-release-early';
    return 'perfect';
  });
  const mr = mixRun.results();
  eq('混合打法：counts 之和 = 100', mr.counts.perfect + mr.counts.good + mr.counts.bad + mr.counts.miss, 100);
  eq('混合打法：resolved = 100', mixRun.resolved, 100);
  words('混合打法：产生了多种判定', Object.keys(mr.counts).filter((k) => mr.counts[k] > 0).length >= 3, mr.counts);
  words('混合打法：分数在合法范围', mr.score >= 0 && mr.score <= 1000000, mr.score);
  eq('混合打法：acc 与分数一致', mr.score, Math.round(1000000 * mr.acc));
}

// ---------------------------------------------------------------- 汇总

console.log('');
console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
