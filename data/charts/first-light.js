// data/charts/first-light.js
// 曲目一：First Light（Easy / 定数 4 / 128 BPM / 约 96 秒）
// 谱面 = 程序化生成（可复现 seed）+ 中段 4 小节的纯手工片段（副歌高潮）。

import { generateChart, sanitizeNotes, buildLines, chartStats, xOfLane } from '../../js/engine/chartgen.js';

const ID = 'first-light';
const BPM = 128;
const LENGTH = 96;
const LANE_COUNT = 4;
const SEED = 20240501;

const BEAT = 60 / BPM;              // 一拍
const BAR = BEAT * 4;               // 一小节 = 1.875 秒
const GRID = BEAT / 8;              // 1/8 拍网格 = 0.0586 秒
const GAP = Math.ceil(0.12 / GRID) * GRID;   // 段落之间留出的安全间隔

// 手工片段：第 24~28 小节的副歌主线（纯手写，用来人工核对判定与手感）
const SPLIT = 24 * BAR;             // 45.0 秒
const SPLIT_END = 28 * BAR;         // 52.5 秒

const lane = (l) => xOfLane(l, LANE_COUNT);
const tap = (bar, beat, l) => ({ time: SPLIT + (bar * 4 + beat) * BEAT, x: lane(l), type: 'tap' });
const drag = (bar, beat, l) => ({ time: SPLIT + (bar * 4 + beat) * BEAT, x: lane(l), type: 'drag' });
const hold = (bar, beat, l, beats) => ({ time: SPLIT + (bar * 4 + beat) * BEAT, x: lane(l), type: 'hold', hold: beats * BEAT });

const HAND = [
  // 第 1 小节：由低到高的上行
  tap(0, 0, 1), tap(0, 1, 0), drag(0, 1.5, 2), tap(0, 2, 3), tap(0, 3, 2),
  // 第 2 小节：长按 + 反向
  hold(1, 0, 0, 1.5), tap(1, 2, 3), drag(1, 2.5, 1), tap(1, 3, 2),
  // 第 3 小节：十六分穿插
  tap(2, 0, 2), tap(2, 0.5, 3), tap(2, 1, 1), drag(2, 1.5, 0), hold(2, 2, 2, 1),
  // 第 4 小节：收束
  tap(3, 0, 3), drag(3, 0.5, 2), tap(3, 1, 1), tap(3, 1.5, 0), tap(3, 2, 1), tap(3, 2.5, 2), hold(3, 3, 3, 0.75),
];

// 前 24 小节：渐入 + 主歌
const partA = generateChart({
  bpm: BPM, length: LENGTH, laneCount: LANE_COUNT, style: 'easy', seed: SEED,
  density: 1.4, startBar: 2, startAt: 2 * BAR, endAt: SPLIT - GAP,
});
// 后 28 小节：副歌与尾奏
const partB = generateChart({
  bpm: BPM, length: LENGTH, laneCount: LANE_COUNT, style: 'easy', seed: SEED ^ 0x9e3779b9,
  density: 1.4, startAt: SPLIT_END + GAP, endAt: LENGTH - 2 * BAR,
});

const merged = sanitizeNotes([...partA.notes, ...HAND, ...partB.notes], {
  bpm: BPM, laneCount: LANE_COUNT, gridDiv: 8, minGap: 0.09,
});

export default {
  id: ID,
  title: 'First Light',
  artist: 'phigrOS Sound Team',
  bpm: BPM,
  length: LENGTH,
  difficulty: 4,
  difficultyName: 'Easy',
  color: '#22d3ee',
  // 程序化曲式：audio.js 依据 sections 合成鼓组 / 贝斯 / 和声垫 / 主旋律
  music: {
    key: 'A', scale: 'minor', mood: 'bright',
    sections: [
      { at: 0, bars: 8, drums: 'none', bass: 'none', pad: 'soft', lead: 'none', intensity: 0.4 },
      { at: 8 * BAR, bars: 8, drums: 'light', bass: 'root', pad: 'soft', lead: 'theme', intensity: 0.6 },
      { at: 16 * BAR, bars: 8, drums: 'light', bass: 'walk', pad: 'full', lead: 'arp', intensity: 0.75 },
      { at: 24 * BAR, bars: 8, drums: 'full', bass: 'walk', pad: 'full', lead: 'theme', intensity: 1.0 },
      { at: 32 * BAR, bars: 8, drums: 'break', bass: 'root', pad: 'soft', lead: 'arp', intensity: 0.62 },
      { at: 40 * BAR, bars: 8, drums: 'full', bass: 'walk', pad: 'full', lead: 'solo', intensity: 1.05 },
      { at: 48 * BAR, bars: 4, drums: 'light', bass: 'root', pad: 'full', lead: 'theme', intensity: 0.7 },
    ],
  },
  chart: {
    offset: 0,
    laneCount: LANE_COUNT,
    lines: buildLines({ bpm: BPM, length: LENGTH, segBars: 8, ladder: 0 }),
    notes: merged.notes,
    stats: { ...chartStats(merged.notes, { length: LENGTH }), dropped: merged.dropped, seed: SEED, handNotes: HAND.length },
  },
};
