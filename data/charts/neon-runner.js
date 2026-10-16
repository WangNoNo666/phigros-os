// data/charts/neon-runner.js
// 曲目二：Neon Runner（Hard / 定数 9 / 150 BPM / 约 100 秒 / 5 轨）
// 谱面 = 程序化生成（可复现 seed）+ 第 32~36 小节的纯手工高密度片段。

import { generateChart, sanitizeNotes, buildLines, chartStats, xOfLane } from '../../js/engine/chartgen.js';

const ID = 'neon-runner';
const BPM = 150;
const LENGTH = 100;
const LANE_COUNT = 5;
const SEED = 20240517;

const BEAT = 60 / BPM;
const BAR = BEAT * 4;                 // 1.6 秒
const GRID = BEAT / 8;                // 0.05 秒
const GAP = Math.ceil(0.12 / GRID) * GRID;

const SPLIT = 32 * BAR;               // 51.2 秒
const SPLIT_END = 36 * BAR;           // 57.6 秒

const lane = (l) => xOfLane(l, LANE_COUNT);
const tap = (bar, beat, l) => ({ time: SPLIT + (bar * 4 + beat) * BEAT, x: lane(l), type: 'tap' });
const drag = (bar, beat, l) => ({ time: SPLIT + (bar * 4 + beat) * BEAT, x: lane(l), type: 'drag' });
const hold = (bar, beat, l, beats) => ({ time: SPLIT + (bar * 4 + beat) * BEAT, x: lane(l), type: 'hold', hold: beats * BEAT });

// 手工片段：连续十六分跑动 + 双长按收尾，用来核对高密度下的判定与渲染可读性
const HAND = [
  // 第 1 小节：左右手交替跑动
  tap(0, 0, 0), tap(0, 0.5, 1), tap(0, 1, 2), tap(0, 1.5, 3), tap(0, 2, 4),
  drag(0, 2.5, 3), tap(0, 3, 2), tap(0, 3.5, 1),
  // 第 2 小节：折返 + 中段长按
  tap(1, 0, 0), tap(1, 0.5, 2), drag(1, 1, 4), tap(1, 1.5, 3), hold(1, 2, 1, 1.5),
  tap(1, 2.5, 4), tap(1, 3, 0), drag(1, 3.5, 2),
  // 第 3 小节：密集交替
  tap(2, 0, 4), tap(2, 0.25, 3), tap(2, 0.5, 4), tap(2, 0.75, 2), tap(2, 1, 1), tap(2, 1.25, 0),
  drag(2, 1.5, 2), tap(2, 2, 3), tap(2, 2.5, 4), tap(2, 3, 2), tap(2, 3.5, 1),
  // 第 4 小节：双长按 + 收尾
  hold(3, 0, 0, 2), drag(3, 0.5, 2), hold(3, 1, 4, 1.5), tap(3, 2, 3), tap(3, 2.5, 1),
  tap(3, 3, 2), drag(3, 3.5, 3),
];

const partA = generateChart({
  bpm: BPM, length: LENGTH, laneCount: LANE_COUNT, style: 'stream', seed: SEED,
  density: 1.3, startBar: 2, startAt: 2 * BAR, endAt: SPLIT - GAP,
});
const partB = generateChart({
  bpm: BPM, length: LENGTH, laneCount: LANE_COUNT, style: 'technical', seed: SEED ^ 0x85ebca6b,
  density: 1.3, startAt: SPLIT_END + GAP, endAt: LENGTH - 2 * BAR,
});

const merged = sanitizeNotes([...partA.notes, ...HAND, ...partB.notes], {
  bpm: BPM, laneCount: LANE_COUNT, gridDiv: 8, minGap: 0.09,
});

export default {
  id: ID,
  title: 'Neon Runner',
  artist: 'phigrOS Sound Team',
  bpm: BPM,
  length: LENGTH,
  difficulty: 9,
  difficultyName: 'Hard',
  color: '#f472b6',
  music: {
    key: 'D', scale: 'minor', mood: 'dark',
    sections: [
      { at: 0, bars: 8, drums: 'build', bass: 'none', pad: 'soft', lead: 'none', intensity: 0.5 },
      { at: 8 * BAR, bars: 8, drums: 'light', bass: 'root', pad: 'soft', lead: 'theme', intensity: 0.72 },
      { at: 16 * BAR, bars: 8, drums: 'full', bass: 'walk', pad: 'full', lead: 'theme', intensity: 1.0 },
      { at: 24 * BAR, bars: 8, drums: 'break', bass: 'root', pad: 'soft', lead: 'arp', intensity: 0.65 },
      { at: 32 * BAR, bars: 8, drums: 'full', bass: 'walk', pad: 'full', lead: 'solo', intensity: 1.1 },
      { at: 40 * BAR, bars: 8, drums: 'light', bass: 'root', pad: 'soft', lead: 'theme', intensity: 0.8 },
      { at: 48 * BAR, bars: 8, drums: 'full', bass: 'walk', pad: 'full', lead: 'solo', intensity: 1.15 },
      { at: 56 * BAR, bars: 8, drums: 'light', bass: 'root', pad: 'full', lead: 'theme', intensity: 0.75 },
    ],
  },
  chart: {
    offset: 0,
    laneCount: LANE_COUNT,
    lines: buildLines({ bpm: BPM, length: LENGTH, segBars: 8, ladder: 1 }),
    notes: merged.notes,
    stats: { ...chartStats(merged.notes, { length: LENGTH }), dropped: merged.dropped, seed: SEED, handNotes: HAND.length },
  },
};
