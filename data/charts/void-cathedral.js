// data/charts/void-cathedral.js
// 曲目三：Void Cathedral（Extra / 定数 13 / 175 BPM / 约 105 秒 / 6 轨）
// 谱面 = 程序化生成（可复现 seed）+ 第 48~52 小节的纯手工高难片段。

import { generateChart, sanitizeNotes, buildLines, chartStats, xOfLane } from '../../js/engine/chartgen.js';

const ID = 'void-cathedral';
const BPM = 175;
const LENGTH = 105;
const LANE_COUNT = 6;
const SEED = 20240613;

const BEAT = 60 / BPM;
const BAR = BEAT * 4;                  // 约 1.3714 秒
const GRID = BEAT / 8;                 // 约 0.0429 秒
const GAP = Math.ceil(0.12 / GRID) * GRID;

const SPLIT = 48 * BAR;                // 约 65.829 秒
const SPLIT_END = 52 * BAR;            // 约 71.314 秒

const lane = (l) => xOfLane(l, LANE_COUNT);
const tap = (bar, beat, l) => ({ time: SPLIT + (bar * 4 + beat) * BEAT, x: lane(l), type: 'tap' });
const drag = (bar, beat, l) => ({ time: SPLIT + (bar * 4 + beat) * BEAT, x: lane(l), type: 'drag' });
const hold = (bar, beat, l, beats) => ({ time: SPLIT + (bar * 4 + beat) * BEAT, x: lane(l), type: 'hold', hold: beats * BEAT });

// 手工片段：六轨十六分跑动、交错长按与拖拽串联（Extra 段的手感基准）
const HAND = [
  // 第 1 小节：六轨往返楼梯
  tap(0, 0, 0), tap(0, 0.25, 1), tap(0, 0.5, 2), tap(0, 0.75, 3), tap(0, 1, 4), tap(0, 1.25, 5),
  drag(0, 1.5, 3), tap(0, 2, 4), tap(0, 2.25, 2), tap(0, 2.5, 1), tap(0, 2.75, 0), drag(0, 3, 2), tap(0, 3.5, 5),
  // 第 2 小节：双押错位 + 中段长按
  tap(1, 0, 0), tap(1, 0.25, 3), tap(1, 0.5, 5), drag(1, 0.75, 1), hold(1, 1, 2, 1.5),
  tap(1, 1.25, 4), tap(1, 1.75, 0), tap(1, 2, 3), drag(1, 2.5, 5), tap(1, 3, 1), tap(1, 3.5, 4),
  // 第 3 小节：连续十六分 + 交错长按
  tap(2, 0, 5), tap(2, 0.25, 4), tap(2, 0.5, 3), tap(2, 0.75, 2), tap(2, 1, 1), tap(2, 1.25, 0),
  drag(2, 1.5, 3), hold(2, 2, 4, 2), tap(2, 2.25, 0), tap(2, 2.5, 1), tap(2, 3, 2), tap(2, 3.5, 5),
  // 第 4 小节：冲刺与收束
  tap(3, 0, 1), tap(3, 0.25, 2), tap(3, 0.5, 3), drag(3, 0.75, 5), tap(3, 1, 4), tap(3, 1.25, 3),
  hold(3, 1.5, 0, 1.5), tap(3, 2, 2), tap(3, 2.25, 4), tap(3, 2.5, 1), drag(3, 3, 5), tap(3, 3.5, 3),
];

const partA = generateChart({
  bpm: BPM, length: LENGTH, laneCount: LANE_COUNT, style: 'chaos', seed: SEED,
  density: 1.4, startBar: 2, startAt: 2 * BAR, endAt: SPLIT - GAP,
});
const partB = generateChart({
  bpm: BPM, length: LENGTH, laneCount: LANE_COUNT, style: 'chaos', seed: SEED ^ 0xc2b2ae35,
  density: 1.4, startAt: SPLIT_END + GAP, endAt: LENGTH - 2 * BAR,
});

const merged = sanitizeNotes([...partA.notes, ...HAND, ...partB.notes], {
  bpm: BPM, laneCount: LANE_COUNT, gridDiv: 8, minGap: 0.09,
});

export default {
  id: ID,
  title: 'Void Cathedral',
  artist: 'phigrOS Sound Team',
  bpm: BPM,
  length: LENGTH,
  difficulty: 13,
  difficultyName: 'Extra',
  color: '#a78bfa',
  music: {
    key: 'F#', scale: 'phrygian', mood: 'epic',
    sections: [
      { at: 0, bars: 8, drums: 'none', bass: 'none', pad: 'soft', lead: 'none', intensity: 0.42 },
      { at: 8 * BAR, bars: 8, drums: 'build', bass: 'root', pad: 'soft', lead: 'none', intensity: 0.6 },
      { at: 16 * BAR, bars: 8, drums: 'light', bass: 'root', pad: 'full', lead: 'theme', intensity: 0.8 },
      { at: 24 * BAR, bars: 8, drums: 'full', bass: 'walk', pad: 'full', lead: 'theme', intensity: 1.0 },
      { at: 32 * BAR, bars: 8, drums: 'break', bass: 'root', pad: 'soft', lead: 'arp', intensity: 0.7 },
      { at: 40 * BAR, bars: 8, drums: 'full', bass: 'walk', pad: 'full', lead: 'solo', intensity: 1.15 },
      { at: 48 * BAR, bars: 8, drums: 'full', bass: 'walk', pad: 'full', lead: 'solo', intensity: 1.2 },
      { at: 56 * BAR, bars: 8, drums: 'build', bass: 'walk', pad: 'full', lead: 'theme', intensity: 1.1 },
      { at: 64 * BAR, bars: 8, drums: 'light', bass: 'root', pad: 'full', lead: 'theme', intensity: 0.85 },
      { at: 72 * BAR, bars: 4, drums: 'break', bass: 'root', pad: 'full', lead: 'arp', intensity: 0.6 },
    ],
  },
  chart: {
    offset: 0,
    laneCount: LANE_COUNT,
    lines: buildLines({ bpm: BPM, length: LENGTH, segBars: 8, ladder: 2 }),
    notes: merged.notes,
    stats: { ...chartStats(merged.notes, { length: LENGTH }), dropped: merged.dropped, seed: SEED, handNotes: HAND.length },
  },
};
