// js/engine/audio.js
// phigrOS 程序化音频引擎：零外部音频资源，全部用 Web Audio 手写合成。
//
// 设计要点（务必保持）：
//   1. 曲目音频由 renderChartToBuffer 在 OfflineAudioContext 里一次性离线渲染成 AudioBuffer，
//      播放时只用一个 BufferSourceNode。这样音频时钟与谱面时间天然同步，不需要实时调度。
//   2. 模块顶层绝不触碰 window / document / AudioContext，node 下 import 不抛异常。
//   3. 未 unlock（无用户手势）前所有播放请求安全降级，绝不抛异常。
//   4. 所有音量最终乘以 settings.volume（masterGain）。

import { mulberry32 } from './chartgen.js';

// ---------------------------------------------------------------- 环境探测

/** 是否具备实时 AudioContext 能力 */
export function hasAudioContext() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  if (!g) return false;
  return typeof g.AudioContext === 'function' || typeof g.webkitAudioContext === 'function';
}

/** 是否具备离线渲染能力 */
export function hasOfflineAudioContext() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  if (!g) return false;
  return typeof g.OfflineAudioContext === 'function' || typeof g.webkitOfflineAudioContext === 'function';
}

function getAudioCtor() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  if (!g) return null;
  return g.AudioContext || g.webkitAudioContext || null;
}

function getOfflineCtor() {
  const g = typeof globalThis !== 'undefined' ? globalThis : null;
  if (!g) return null;
  return g.OfflineAudioContext || g.webkitOfflineAudioContext || null;
}

function nfin(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : (n > 1 ? 1 : n);
}

// ---------------------------------------------------------------- 乐理工具

const NOTE_BASE = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** 把 'A' / 'F#' / 'Bb' 解析成以 C4 = 60 为基准的 MIDI 音高 */
function parseRoot(key) {
  const s = String(key || 'A').trim();
  const letter = s.charAt(0).toUpperCase();
  const base = NOTE_BASE[letter];
  if (base === undefined) return 57; // 默认 A3
  let semi = base;
  const rest = s.slice(1);
  if (rest.indexOf('#') === 0) semi += 1;
  else if (rest.indexOf('b') === 0) semi -= 1;
  return 48 + semi; // C3 基准，低音更稳
}

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
};

const PROGRESSIONS = {
  bright: [0, 4, 5, 3],
  dark: [0, 5, 3, 4],
  sad: [0, 3, 4, 0],
  epic: [0, 5, 6, 4],
  calm: [0, 3, 5, 4],
};

/** MIDI 音高 -> 频率 */
function mtof(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** 音阶级数（可越八度）-> 半音偏移 */
function degreeToSemi(scale, degree) {
  const n = scale.length;
  const oct = Math.floor(degree / n);
  const idx = ((degree % n) + n) % n;
  return scale[idx] + 12 * oct;
}

// ---------------------------------------------------------------- 合成基元

let nodeCounter = null;
/** 合成进度回调（合成过程中每小节调用一次，用于界面反馈） */
let audioSynthHook = null;

/** 单调时钟（毫秒），用于渲染耗时诊断 */
function wallClock() {
  const g = typeof globalThis !== 'undefined' ? globalThis : {};
  if (g.performance && typeof g.performance.now === 'function') return g.performance.now();
  return Date.now();
}

/** 给 Promise 加超时：超时 reject，用于离线渲染熔断 */
function promiseWithTimeout(promise, ms, message) {
  if (!(ms > 0)) return promise;
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message || `超时 ${ms}ms`));
    }, ms);
    promise.then(
      (v) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

/** 生成白噪声缓冲（鼓组共用，避免每次都新建） */
function makeNoiseBuffer(ctx, seconds) {
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  let s = 0x1234567;
  for (let i = 0; i < len; i++) {
    // 确定性噪声（xorshift），保证同一首歌每次渲染完全一致
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    data[i] = (s / 4294967296) * 2 - 1;
  }
  return buf;
}

function gainNode(ctx, dest) {
  const g = ctx.createGain();
  if (nodeCounter) nodeCounter.gain += 1;
  g.gain.value = 1;
  if (dest) g.connect(dest);
  return g;
}

/**
 * 通用振荡器音色。
 * @param {BaseAudioContext} ctx
 * @param {AudioNode} dest 目标节点
 * @param {Object} o {type, freq, to, t, dur, peak, attack, curve, detune}
 */
function tone(ctx, dest, o) {
  const t = o.t;
  const dur = Math.max(0.01, o.dur);
  const peak = Math.max(0.0002, nfin(o.peak, 0.2));
  const osc = ctx.createOscillator();
  if (nodeCounter) nodeCounter.osc += 1;
  osc.type = o.type || 'sine';
  osc.frequency.setValueAtTime(Math.max(20, o.freq), t);
  if (o.to && o.to !== o.freq) {
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.to), t + dur * (o.sweep === undefined ? 1 : o.sweep));
  }
  if (o.detune) osc.detune.setValueAtTime(o.detune, t);
  const g = gainNode(ctx, dest);
  const atk = Math.max(0.001, nfin(o.attack, 0.005));
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + atk);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  osc.connect(g);
  osc.start(t);
  osc.stop(t + dur + 0.03);
  return osc;
}

/** 噪声打击（军鼓 / 踩镲通用） */
function noiseHit(ctx, dest, noise, o) {
  const src = ctx.createBufferSource();
  if (nodeCounter) nodeCounter.src += 1;
  src.buffer = noise;
  const filt = ctx.createBiquadFilter();
  if (nodeCounter) nodeCounter.filt += 1;
  filt.type = o.filter || 'highpass';
  filt.frequency.setValueAtTime(o.cut, o.t);
  if (o.cutTo) filt.frequency.exponentialRampToValueAtTime(Math.max(60, o.cutTo), o.t + o.dur);
  filt.Q.value = nfin(o.q, 0.8);
  const g = gainNode(ctx, null);   // 注意：不能连到 filt，否则 filt->g->filt 形成反馈环
  g.gain.setValueAtTime(0.0001, o.t);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, nfin(o.peak, 0.2)), o.t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, o.t + Math.max(0.02, o.dur));
  src.connect(filt);
  filt.connect(g);
  g.connect(dest);
  src.start(o.t);
  src.stop(o.t + Math.max(0.03, o.dur) + 0.02);
  return src;
}

function kick(ctx, dest, noise, t, peak) {
  tone(ctx, dest, { type: 'sine', freq: 150, to: 46, t, dur: 0.24, peak, attack: 0.003, sweep: 0.55 });
  noiseHit(ctx, dest, noise, { t, dur: 0.03, peak: peak * 0.35, filter: 'lowpass', cut: 2400, q: 0.6 });
}

function snare(ctx, dest, noise, t, peak) {
  noiseHit(ctx, dest, noise, { t, dur: 0.16, peak: peak * 0.9, filter: 'bandpass', cut: 1900, q: 0.9 });
  tone(ctx, dest, { type: 'triangle', freq: 210, to: 150, t, dur: 0.1, peak: peak * 0.5, attack: 0.002 });
}

function hihat(ctx, dest, noise, t, peak, open) {
  noiseHit(ctx, dest, noise, {
    t,
    dur: open ? 0.14 : 0.045,
    peak,
    filter: 'highpass',
    cut: 7600,
    q: 0.7,
  });
}

function bassNote(ctx, dest, t, dur, freq, peak) {
  const filt = ctx.createBiquadFilter();
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(520, t);
  filt.frequency.exponentialRampToValueAtTime(180, t + dur * 0.8);
  filt.Q.value = 5;
  filt.connect(dest);
  tone(ctx, filt, { type: 'sawtooth', freq, t, dur, peak, attack: 0.008 });
  tone(ctx, filt, { type: 'sine', freq: freq / 2, t, dur, peak: peak * 0.5, attack: 0.008 });
}

function padChord(ctx, dest, t, dur, freqs, peak, bright) {
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i];
    tone(ctx, dest, {
      type: bright ? 'triangle' : 'sine',
      freq: f,
      t,
      dur,
      peak: peak * (i === 0 ? 1 : 0.8),
      attack: Math.min(0.35, dur * 0.25),
      detune: (i % 2 === 0 ? -4 : 5),
    });
  }
}

function leadNote(ctx, dest, t, dur, freq, peak, type) {
  const filt = ctx.createBiquadFilter();
  if (nodeCounter) nodeCounter.filt += 1;
  filt.type = 'lowpass';
  filt.frequency.setValueAtTime(Math.min(7000, freq * 6), t);
  filt.frequency.exponentialRampToValueAtTime(Math.max(600, freq * 2.4), t + dur);
  filt.Q.value = 1.4;
  filt.connect(dest);
  tone(ctx, filt, { type: type || 'square', freq, t, dur, peak, attack: 0.006 });
  if (dur > 0.2) {
    tone(ctx, filt, { type: 'triangle', freq: freq * 2, t, dur: dur * 0.5, peak: peak * 0.25, attack: 0.006 });
  }
  return filt;   // 返回尾部节点，便于外部再接到延迟线上
}

// ---------------------------------------------------------------- 曲目合成

function normalizeSections(track, barLen, length) {
  const music = (track && track.music) || {};
  const raw = Array.isArray(music.sections) ? music.sections : [];
  const sections = [];
  for (let i = 0; i < raw.length; i++) {
    const s = raw[i] || {};
    const at = Math.max(0, nfin(s.at, 0));
    let end = i + 1 < raw.length ? Math.max(at, nfin(raw[i + 1].at, at + 4 * barLen)) : at + nfin(s.bars, 8) * barLen;
    if (end <= at) end = at + 4 * barLen;
    sections.push({
      start: at,
      end,
      bars: Math.max(1, Math.round(nfin(s.bars, (end - at) / barLen))),
      drums: s.drums || 'light',
      bass: s.bass || 'root',
      pad: s.pad || 'soft',
      lead: s.lead || 'none',
      intensity: Math.max(0.2, Math.min(1.4, nfin(s.intensity, 0.8))),
    });
  }
  if (!sections.length) {
    // 缺省曲式：前奏 / 主歌 / 副歌 / 尾奏
    const parts = [
      { from: 0, to: 0.12, drums: 'none', bass: 'none', pad: 'soft', lead: 'none', intensity: 0.5 },
      { from: 0.12, to: 0.38, drums: 'light', bass: 'root', pad: 'soft', lead: 'theme', intensity: 0.75 },
      { from: 0.38, to: 0.78, drums: 'full', bass: 'walk', pad: 'full', lead: 'theme', intensity: 1.0 },
      { from: 0.78, to: 1.0, drums: 'light', bass: 'root', pad: 'full', lead: 'arp', intensity: 0.85 },
    ];
    for (const p of parts) {
      sections.push({
        start: p.from * length, end: p.to * length, bars: 4,
        drums: p.drums, bass: p.bass, pad: p.pad, lead: p.lead, intensity: p.intensity,
      });
    }
  }
  return sections;
}

function sectionAt(sections, t) {
  for (let i = sections.length - 1; i >= 0; i--) {
    if (t >= sections[i].start - 1e-9) return sections[i];
  }
  return sections[0];
}

/** 段落内拍数位置 -> 鼓组事件 */
function drumPattern(kind, beatsPerBar, rng, barIndex, sectionBars) {
  const kicks = [];
  const snares = [];
  const hats = [];
  const push = (arr, b) => arr.push(b);
  const isLast = barIndex >= sectionBars - 1;
  switch (kind) {
    case 'none':
      break;
    case 'light':
      push(kicks, 0); push(kicks, 2);
      push(snares, 2);
      for (let b = 0; b < beatsPerBar; b += 0.5) push(hats, b);
      break;
    case 'full':
      push(kicks, 0); push(kicks, 1.5); push(kicks, 2);
      push(snares, 1); push(snares, 3);
      for (let b = 0; b < beatsPerBar; b += 0.5) push(hats, b);
      break;
    case 'build':
      for (let b = 0; b < beatsPerBar; b += 1) push(kicks, b);
      push(snares, 2);
      for (let b = 0; b < beatsPerBar; b += 0.25) push(hats, b);
      if (isLast) {
        for (let b = 2; b < beatsPerBar; b += 0.25) push(snares, b);
      }
      break;
    case 'break':
      push(snares, 1); push(snares, 3);
      for (let b = 0; b < beatsPerBar; b += 1) push(hats, b);
      break;
    default:
      push(kicks, 0);
      push(snares, 2);
      for (let b = 0; b < beatsPerBar; b += 1) push(hats, b);
      break;
  }
  return { kicks, snares, hats };
}

/** 依据曲式把整首歌合成到 dest（OfflineAudioContext 内一次性调度完成） */
function synthTrack(ctx, dest, track, length, opts = {}) {
  const lite = Boolean(opts.lite); // 精简模式：去掉踩镲噪声源，节点数约减少一半
  const synthProgress = typeof audioSynthHook === 'function' ? audioSynthHook : null;
  const bpm = Math.max(40, nfin(track && track.bpm, 128));
  const beat = 60 / bpm;
  const barLen = beat * 4;
  const music = (track && track.music) || {};
  const scaleName = SCALES[music.scale] ? music.scale : 'minor';
  const scale = SCALES[scaleName];
  const root = parseRoot(music.key || 'A');
  const progName = PROGRESSIONS[music.mood] ? music.mood : 'bright';
  const prog = PROGRESSIONS[progName];
  const sections = normalizeSections(track, barLen, length);
  const noise = makeNoiseBuffer(ctx, 0.5);
  const rng = mulberry32(0x51ed270b ^ Math.floor(bpm * 1000));

  // 主输出 + 轻微峰值压制，避免削波
  const out = gainNode(ctx, dest);
  out.gain.value = 0.9;

  // 简易延迟（主旋律用），不使用卷积混响
  const delay = ctx.createDelay(1.2);
  delay.delayTime.value = beat * 0.75;
  const fb = gainNode(ctx, delay);
  fb.gain.value = 0.26;
  const wet = gainNode(ctx, out);
  wet.gain.value = 0.18;
  delay.connect(fb);
  delay.connect(wet);

  const bars = Math.ceil(length / barLen);
  for (let bar = 0; bar < bars; bar++) {
    if (synthProgress) synthProgress();
    const barT = bar * barLen;
    if (barT >= length) break;
    const sec = sectionAt(sections, barT);
    const secBars = Math.max(1, Math.round((sec.end - sec.start) / barLen));
    const barInSec = Math.max(0, Math.round((barT - sec.start) / barLen));
    const chordIdx = Math.floor(bar / 2) % prog.length;
    const degree = prog[chordIdx];
    const chordSemis = [0, 2, 4].map((k) => degreeToSemi(scale, degree + k));
    const intensity = sec.intensity;
    const drumGain = 0.55 * intensity;

    // —— 鼓组
    if (barT + barLen <= length + 0.5) {
      const pat = drumPattern(sec.drums, 4, rng, barInSec % 4, Math.min(secBars, 4));
      for (const b of pat.kicks) {
        const t = barT + b * beat;
        if (t < length) kick(ctx, out, noise, t, 0.85 * intensity);
      }
      for (const b of pat.snares) {
        const t = barT + b * beat;
        if (t < length) snare(ctx, out, noise, t, 0.5 * drumGain + 0.18);
      }
      for (let i = 0; i < pat.hats.length; i++) {
        if (lite) break;
        const t = barT + pat.hats[i] * beat;
        if (t >= length) continue;
        const accent = (i % 2 === 0) ? 1 : 0.62;
        hihat(ctx, out, noise, t, 0.16 * accent * intensity, false);
      }
    }

    // —— 和声垫（每 2 小节换一次和弦）
    if (sec.pad !== 'none' && bar % 2 === 0) {
      const padDur = Math.min(barLen * 2 - 0.05, length - barT);
      if (padDur > 0.2) {
        const freqs = chordSemis.map((s) => mtof(root + 12 + s));
        padChord(ctx, out, barT, padDur, freqs, 0.055 * intensity, sec.pad === 'full');
      }
    }

    // —— 贝斯
    if (sec.bass !== 'none') {
      const rootFreq = mtof(root - 12 + chordSemis[0]);
      const fifthFreq = mtof(root - 12 + chordSemis[2]);
      if (sec.bass === 'walk') {
        const pattern = [rootFreq, rootFreq, fifthFreq, rootFreq, rootFreq, mtof(root - 12 + chordSemis[1]), fifthFreq, rootFreq];
        for (let i = 0; i < 8; i++) {
          const t = barT + i * beat * 0.5;
          if (t >= length) break;
          bassNote(ctx, out, t, beat * 0.44, pattern[i], 0.3 * intensity);
        }
      } else {
        for (let b = 0; b < 4; b += 1) {
          const t = barT + b * beat;
          if (t >= length) break;
          bassNote(ctx, out, t, beat * 0.85, b === 3 ? fifthFreq : rootFreq, 0.28 * intensity);
        }
      }
    }

    // —— 主旋律
    if (sec.lead !== 'none') {
      const type = sec.lead === 'solo' ? 'sawtooth' : 'square';
      const stepsPerBeat = sec.lead === 'arp' ? 4 : 2;
      for (let s = 0; s < 4 * stepsPerBeat; s++) {
        const t = barT + (s / stepsPerBeat) * beat;
        if (t >= length - 0.05) break;
        if (sec.lead === 'theme') {
          // 主旋律：八分音符，带休止，走向以和弦音为骨架
          if (rng() < 0.24) continue;
          const pick = Math.floor(rng() * chordSemis.length);
          const oct = rng() < 0.3 ? 12 : 0;
          const freq = mtof(root + 24 + chordSemis[pick] + oct);
          leadNote(ctx, out, t, beat * 0.55, freq, 0.11 * intensity, type);
          if (rng() < 0.3) {
            const d = leadNote(ctx, out, t, beat * 0.4, freq, 0.05, type);
            d.connect(delay);
          }
        } else {
          // 琶音 / solo：十六分音符流
          if (sec.lead === 'solo' && rng() < 0.12) continue;
          const pick = s % chordSemis.length;
          const oct = (Math.floor(s / (stepsPerBeat * 2)) % 2) ? 12 : 0;
          const freq = mtof(root + 24 + chordSemis[pick] + oct);
          leadNote(ctx, out, t, beat * 0.3, freq, 0.075 * intensity, type);
        }
      }
    }
  }
  // 尾部留一点余韵
  const tail = Math.max(0, length - 0.5);
  tone(ctx, out, { type: 'sine', freq: mtof(root + 12), t: tail, dur: Math.min(1.2, length - tail), peak: 0.05 * 0.4, attack: 0.2 });
}

/** 归一化到目标峰值（留 10% headroom -> peak 0.9）
 *  性能注意：几十秒的立体声缓冲有上千万个采样点，
 *  用 JS 逐点循环会造成数百毫秒~数秒的主线程卡顿（页面像假死），
 *  因此这里用分块 Math.max 走引擎原生实现。 */
function normalizeBuffer(buffer, targetPeak) {
  const target = nfin(targetPeak, 0.9);
  const chans = Math.max(1, buffer.numberOfChannels | 0);
  const len = buffer.length | 0;
  const CHUNK = 1 << 16;
  let peak = 0;
  const datas = [];
  for (let c = 0; c < chans; c++) datas.push(buffer.getChannelData(c));
  for (let c = 0; c < chans; c++) {
    const data = datas[c];
    for (let i = 0; i < len; i += CHUNK) {
      const end = Math.min(len, i + CHUNK);
      let local = 0;
      try {
        local = Math.max.apply(null, data.subarray(i, end));
      } catch (err) {
        for (let k = i; k < end; k++) if (data[k] > local) local = data[k];
      }
      if (local > peak) peak = local;
    }
  }
  if (!Number.isFinite(peak) || peak <= 1e-6) return 0;
  const g = target / peak;
  if (g >= 0.9999 && g <= 1.0001) return peak;
  for (let c = 0; c < chans; c++) {
    const data = datas[c];
    for (let i = 0; i < len; i += CHUNK) {
      const end = Math.min(len, i + CHUNK);
      for (let k = i; k < end; k++) data[k] *= g;
    }
  }
  return peak;
}

/** 从 chart / track 推断曲目时长 */
export function trackDuration(chart, track) {
  const tr = normalizeTrackArgs(chart, track);
  const c = tr.chart || {};
  const notes = Array.isArray(c.notes) ? c.notes : [];
  let last = 0;
  for (const n of notes) {
    const t = nfin(n && n.time, 0) + (n && n.type === 'hold' ? nfin(n.hold, 0) : 0);
    if (t > last) last = t;
  }
  return Math.max(nfin(tr.length, 0), last + 1.2);
}

/** 兼容 renderChartToBuffer(chart, track) 与 renderChartToBuffer(track) 两种调用 */
function normalizeTrackArgs(chart, track) {
  if (track && typeof track === 'object') {
    const c = (chart && Array.isArray(chart.notes))
      ? chart
      : (track.chart || (chart && typeof chart === 'object' ? chart : {}));
    return { ...track, chart: c };
  }
  if (chart && chart.chart) {
    return { ...chart, chart: chart.chart };
  }
  if (chart && Array.isArray(chart.notes)) {
    return { chart, music: chart.music || {}, bpm: chart.bpm || 128, length: chart.length || 0 };
  }
  return { chart: (chart && chart.chart) || {}, ...(chart || {}) };
}

// ---------------------------------------------------------------- 引擎主体

export class AudioEngine {
  static instance = null;

  constructor() {
    this.ctx = null;
    this.master = null;
    this.volume = 0.8;
    this.sfxEnabled = true;
    this.bgmEnabled = true;
    this.bufferCache = new Map();
    this.bgmBuffer = null;
    this.bgmHandle = null;
    this.bgmKind = null;
    this._bgmFailed = false;
    this._bgmDeferred = false;
    this.pendingBgm = null;
    this.lastHandle = null;
    this.unlocked = false;
    this._store = null;
    this._unsubs = [];
    this._anonSeq = 0;
    this._pendingRender = new Map();
    this.sampleRate = 44100;
    /** 单次离线渲染的预算（毫秒）；超时则熔断并降级，避免音游卡在「正在准备音频」 */
    this.renderBudgetMs = 4000;
    /**
     * 自动静音兜底：一旦发现本环境的离线渲染不可用（超时/抛错/耗时过长），
     * 就永久跳过离线渲染，音游直接用兜底时钟游玩。
     * 这是关键——在受限环境里 OfflineAudioContext.startRendering() 可能既不返回也不报错，
     * 每次尝试都会把主线程占满数秒，导致页面像假死。
     */
    this.autoSilentOnFailure = true;
    this.audioSynthesisDisabled = false;
    this.musicSynthEnabled = true;
    this.lastRenderStats = null;
  }

  // ---------- 生命周期 ----------

  /** 创建 AudioContext（只在用户手势或显式调用时执行，避免浏览器告警） */
  ensureContext() {
    if (this.ctx) return this.ctx;
    const Ctor = getAudioCtor();
    if (!Ctor) return null;
    try {
      this.ctx = new Ctor();
      this.sampleRate = nfin(this.ctx.sampleRate, 44100);
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    } catch (err) {
      this.ctx = null;
      this.master = null;
      return null;
    }
    return this.ctx;
  }

  /** 首次用户手势里调用，恢复 AudioContext（永不长时间挂起） */
  async unlock() {
    const ctx = this.ensureContext();
    if (!ctx) { this.unlocked = false; return false; }
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        await promiseWithTimeout(Promise.resolve(ctx.resume()), 2000, 'AudioContext.resume 超时').catch(() => {});
      }
    } catch (err) { /* 静音环境：忽略 */ }
    this.unlocked = ctx.state === 'running' || ctx.state === 'suspended';
    if (this.pendingBgm && this.bgmEnabled) {
      const kind = this.pendingBgm;
      this.pendingBgm = null;
      try { await promiseWithTimeout(this.playBgm(kind), 3000, 'BGM 播放超时').catch(() => {}); } catch (err) { /* 忽略 */ }
    }
    return true;
  }

  /** 音频输出是否就绪 */
  ready() {
    if (!this.ctx) return false;
    return this.ctx.state === 'running';
  }

  /** 是否可用（上下文已存在且未被关闭） */
  available() {
    return !!(this.ctx && this.ctx.state !== 'closed') || hasAudioContext();
  }

  /** 挂载状态仓库，读取 settings.volume / sfx / bgm 并订阅变化 */
  attachStore(store) {
    if (!store || typeof store.get !== 'function') return this;
    this._store = store;
    let s = {};
    try {
      s = (store.get() || {}).settings || {};
      if (s.volume !== undefined) this.volume = clamp01(s.volume);
      if (s.sfx !== undefined) this.sfxEnabled = !!s.sfx;
      if (s.bgm !== undefined) this.bgmEnabled = !!s.bgm;
    } catch (err) { /* 忽略 */ }
    if (this.master && this.ctx) {
      try { this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01); } catch (err) { this.master.gain.value = this.volume; }
    }
    const sub = (path, cb) => {
      try {
        if (typeof store.subscribe === 'function') {
          const un = store.subscribe(path, cb);
          if (typeof un === 'function') this._unsubs.push(un);
        }
      } catch (err) { /* 忽略 */ }
    };
    sub('settings.volume', (v) => this.setVolume(v));
    sub('settings.sfx', (v) => this.setSfxEnabled(v));
    sub('settings.bgm', (v) => this.setBgmEnabled(v));
    sub('settings.musicSynth', (v) => this.setMusicSynthEnabled(v));
    // 以存档为权威：默认关闭音乐合成（离线渲染会整段占用主线程）
    this.setMusicSynthEnabled(s.musicSynth !== false);
    return this;
  }

  setSfxEnabled(v) { this.sfxEnabled = !!v; return this; }

  /**
   * 是否允许程序化音频合成（离线渲染整曲 / 大厅 BGM）。
   * 关闭后曲目使用等长静音缓冲，音游走兜底时钟——在音频子系统受限的
   * 环境（虚拟声卡、远程桌面、受限浏览器）里这是最省心的选择。
   */
  setMusicSynthEnabled(v) {
    const on = v !== false;
    this.musicSynthEnabled = on;
    this.audioSynthesisDisabled = !on;
    if (!on) {
      this.stopBgm();
      console.warn('[phigrOS/audio] 已按设置关闭程序化音乐合成：音游使用兜底时钟（判定正常，无音乐）');
    } else {
      // 允许重试一次渲染（用户可能换了环境）
      this._renderBlocked = false;
      this._probeResult = undefined;
    }
    return this;
  }

  /**
   * 实时降载：判定为「音频合成正在拖垮帧率」时立刻停用合成。
   * 音游里帧率就是手感，宁可没有音乐也不能掉帧。
   */
  panicDisableSynthesis(reason) {
    if (this.audioSynthesisDisabled && this._renderBlocked) return false;
    this.autoSilentOnFailure = true;
    this._renderBlocked = true;
    this.audioSynthesisDisabled = true;
    this.stopBgm();
    console.warn(`[phigrOS/audio] 已停用音频合成以保证帧率（${reason || '帧率过低'}）`);
    return true;
  }

  setBgmEnabled(v) {
    this.bgmEnabled = !!v;
    if (!this.bgmEnabled) this.stopBgm();
    else if (this.pendingBgm) {
      const k = this.pendingBgm;
      this.pendingBgm = null;
      try { this.playBgm(k); } catch (err) { /* 忽略 */ }
    }
    return this;
  }

  /** 主音量 0..1，实时生效 */
  setVolume(v) {
    this.volume = clamp01(v);
    if (this.master && this.ctx) {
      try {
        this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.015);
      } catch (err) {
        this.master.gain.value = this.volume;
      }
    }
    return this.volume;
  }

  /** 当前主音量 */
  volumeValue() { return this.volume; }

  /** 清空渲染缓存（换曲式 / 调试用） */
  clearCache() {
    this.bufferCache.clear();
    this._pendingRender.clear();
    this.bgmBuffer = null;
    return this;
  }

  // ---------- 离线渲染 ----------

  /**
   * 离线渲染整首曲目为 AudioBuffer，并按 track.id 缓存。
   * @param {Object} chart 谱面（或整首 track）
   * @param {Object} track 曲目对象
   * @returns {Promise<AudioBuffer>}
   */
  renderChartToBuffer(chart, track) {
    const tr = normalizeTrackArgs(chart, track);
    const key = tr.id || ('__anon-' + (++this._anonSeq));
    if (this.bufferCache.has(key)) return Promise.resolve(this.bufferCache.get(key));
    if (this._pendingRender.has(key)) return this._pendingRender.get(key);
    const Ctor = getOfflineCtor();
    if (!Ctor) return Promise.reject(new Error('AudioContext 不可用：无法离线渲染曲目'));
    const duration = Math.max(4, trackDuration(chart, tr) + 0.7);
    const rate = this.ctx ? nfin(this.ctx.sampleRate, 44100) : this.sampleRate;
    const frames = Math.max(1, Math.ceil(duration * rate));
    // 已知本环境渲染不可用（或全局关闭合成）：直接给等长静音缓冲，
    // 让音游立刻用兜底时钟开始，不再阻塞主线程。
    if (this.audioSynthesisDisabled || this._renderBlocked) {
      const silent = this._silentBuffer(Ctor, frames, rate);
      this.bufferCache.set(key, silent);
      this.lastRenderStats = { mode: 'silent', reason: 'audio-synthesis-disabled', nodes: 0, synthMs: 0, totalMs: 0, duration: silent.duration };
      return Promise.resolve(silent);
    }
    const task = this._renderWithFallback(Ctor, tr, duration, frames, rate, key);
    this._pendingRender.set(key, task.catch((err) => {
      this._pendingRender.delete(key);
      throw err;
    }));
    return this._pendingRender.get(key);
  }

  /**
   * 同步查询「本环境当前能否离线渲染音频」。
   * true  = 探测已通过，可以渲染
   * false = 已确认不可用（或用户关闭了合成），音游应立刻用兜底时钟开始
   * undefined = 尚未探测（调用方可选择不等）
   */
  canRenderAudio() {
    if (!this.musicSynthEnabled) return false;
    if (this.audioSynthesisDisabled || this._renderBlocked) return false;
    return this._probeResult;
  }

  /** 后台预热探测：开机后在空闲时调用，这样玩家点开始时已经知道结果 */
  warmupProbe() {
    const Ctor = getOfflineCtor();
    if (!Ctor) {
      this.audioSynthesisDisabled = true;
      this._probeResult = false;
      return Promise.resolve(false);
    }
    if (!this.musicSynthEnabled) {
      // 用户/默认关闭了合成：不必探测
      this._probeResult = false;
      this.audioSynthesisDisabled = true;
      return Promise.resolve(false);
    }
    if (this._probeResult !== undefined) return Promise.resolve(this._probeResult);
    const rate = this.ctx ? nfin(this.ctx.sampleRate, 44100) : this.sampleRate;
    return this._probe(Ctor, rate).then((ok) => {
      if (!ok) this._markRenderBlocked('开机预热探测失败');
      return ok;
    });
  }

  /** 等长静音缓冲（离线渲染不可用时的安全替代） */
  _silentBuffer(Ctor, frames, rate) {
    try {
      const o = new Ctor(1, frames, rate);
      return o.createBuffer(1, frames, rate);
    } catch (err) {
      return null;
    }
  }

  /**
   * 离线渲染：单次尝试（单声道 + 明确的渲染预算），失败立刻回退静音缓冲。
   *
   * 为什么不重试多级：
   * 在受限环境里 startRendering() 可能既不 resolve 也不 reject，每次尝试都会
   * 把主线程占满整个预算时长。失败一次就足以判定「本环境离线渲染不可用」，
   * 之后所有曲目直接走静音缓冲 + 兜底时钟，页面再也不会出现数秒假死。
   */
  async _renderWithFallback(Ctor, tr, duration, frames, rate, key) {
    const started = wallClock();
    const mode = { name: 'full', lite: false, budget: this.renderBudgetMs };
    const attempts = [];

    // 先探测：极短缓冲试渲染一次，能在几十毫秒内确认环境是否可用（成本极低）
    const probeOk = await this._probe(Ctor, rate);
    if (!probeOk) {
      this._markRenderBlocked('离线渲染探测失败（startRendering 无响应）');
      return this._cacheSilent(Ctor, key, frames, rate, attempts);
    }

    let octx = null;
    try {
      octx = new Ctor(1, frames, rate); // 单声道：样本量减半，渲染更快
    } catch (err) {
      attempts.push(`创建 OfflineAudioContext 失败：${err && err.message}`);
      this._markRenderBlocked('无法创建 OfflineAudioContext');
      return this._cacheSilent(Ctor, key, frames, rate, attempts);
    }

    const counter = { osc: 0, src: 0, gain: 0, filt: 0, delay: 0 };
    nodeCounter = counter;
    let synthError = null;
    const synthT0 = wallClock();
    let lastReport = synthT0;
    const report = () => {
      const now = wallClock();
      if (now - lastReport < 120) return;
      lastReport = now;
      try { if (this.onRenderProgress) this.onRenderProgress({ phase: 'synth', mode: mode.name, elapsed: now - started }); } catch (e) { /* 忽略 */ }
    };
    audioSynthHook = report;
    try {
      synthTrack(octx, octx.destination, tr, duration - 0.7, { lite: mode.lite });
    } catch (err) {
      synthError = err;
    }
    audioSynthHook = null;
    const synthMs = wallClock() - synthT0;
    nodeCounter = null;
    const nodes = counter.osc + counter.src + counter.gain + counter.filt;
    try { if (this.onRenderProgress) this.onRenderProgress({ phase: 'render', mode: mode.name, elapsed: wallClock() - started, nodes }); } catch (e) { /* 忽略 */ }

    try {
      const rendered = await promiseWithTimeout(
        Promise.resolve(octx.startRendering()),
        mode.budget,
        `离线渲染超过 ${mode.budget}ms`
      );
      try { normalizeBuffer(rendered, 0.9); } catch (err) { /* 忽略 */ }
      this.bufferCache.set(key, rendered);
      this.lastSynthError = synthError || null;
      this.lastRenderStats = { mode: mode.name, nodes, synthMs, totalMs: wallClock() - started, attempts: attempts.slice(), duration: rendered.duration };
      this._pendingRender.delete(key);
      return rendered;
    } catch (err) {
      attempts.push(`${mode.name}: ${(err && err.message) || err} (节点 ${nodes}，合成 ${Math.round(synthMs)}ms)`);
      console.warn(`[phigrOS/audio] ${key} 渲染失败，回退静音缓冲：${attempts[attempts.length - 1]}`);
      this._markRenderBlocked('离线渲染超时');
      return this._cacheSilent(Ctor, key, frames, rate, attempts, nodes, synthMs);
    }
  }

  /**
   * 环境探测：用一个 0.25 秒的极短离线上下文试跑 startRendering。
   * 能在几十毫秒内判断本环境是否支持离线渲染，成本可忽略。
   */
  _probe(Ctor, rate) {
    if (this._probeResult !== undefined) return Promise.resolve(this._probeResult);
    return new Promise((resolve) => {
      let octx = null;
      try {
        octx = new Ctor(1, Math.max(1, Math.round(rate * 0.25)), rate);
        const o = octx.createOscillator();
        const g = octx.createGain();
        g.gain.value = 0.0001;
        o.connect(g);
        g.connect(octx.destination);
        o.start(0);
        o.stop(0.05);
      } catch (err) {
        this._probeResult = false;
        resolve(false);
        return;
      }
      promiseWithTimeout(Promise.resolve(octx.startRendering()), 1500, 'probe timeout').then(
        () => { this._probeResult = true; resolve(true); },
        () => { this._probeResult = false; resolve(false); }
      );
    });
  }

  _markRenderBlocked(reason) {
    this._renderBlocked = true;
    if (this.autoSilentOnFailure) this.audioSynthesisDisabled = true;
    console.warn(`[phigrOS/audio] 本环境离线音频渲染不可用（${reason}）：后续曲目使用静音缓冲与兜底时钟，判定精度略降但游玩完全可用`);
  }

  _cacheSilent(Ctor, key, frames, rate, attempts, nodes = 0, synthMs = 0) {
    const silent = this._silentBuffer(Ctor, frames, rate);
    if (silent) this.bufferCache.set(key, silent);
    this._pendingRender.delete(key);
    this.lastRenderStats = { mode: 'silent', nodes, synthMs, totalMs: 0, attempts: attempts.slice(), duration: silent ? silent.duration : 0 };
    return silent;
  }

  // ---------- 播放 ----------

  /**
   * 播放一个 AudioBuffer。
   * @returns {{source:*, gainNode:*, startedAt:number, offset:number, paused:boolean, buffer:*, loop:boolean}}
   */
  play(buffer, opts = {}) {
    const at = Math.max(0, nfin(opts.at, 0));
    const loop = !!opts.loop;
    const gain = nfin(opts.gain, 1);
    if (!buffer) {
      const dead = { source: null, gainNode: null, startedAt: 0, offset: at, paused: true, buffer: null, loop, unsupported: true };
      this.lastHandle = dead;
      return dead;
    }
    if (!this.ctx) this.ensureContext();
    if (!this.ctx) {
      // 无 AudioContext（node / 能力缺失）：返回安全降级句柄，不抛异常
      const dead = { source: null, gainNode: null, startedAt: 0, offset: at, paused: true, buffer, loop, unsupported: true };
      this.lastHandle = dead;
      return dead;
    }
    const g = this.ctx.createGain();
    g.gain.value = gain;
    if (this.master) g.connect(this.master);
    const src = this._makeSource(buffer, loop);
    src.connect(g);
    const startedAt = this.ctx.currentTime;
    try { src.start(startedAt, at); } catch (err) { /* 静音环境忽略 */ }
    const handle = { source: src, gainNode: g, startedAt, offset: at, paused: false, buffer, loop, ended: false };
    src.onended = () => { handle.ended = true; };
    this.lastHandle = handle;
    return handle;
  }

  _makeSource(buffer, loop) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = !!loop;
    return src;
  }

  /** 播放时钟（秒）：暂停时冻结 */
  currentTime(handle) {
    const h = handle || this.lastHandle;
    if (!h) return 0;
    if (h.paused || h.unsupported || !this.ctx) return h.offset || 0;
    let t = this.ctx.currentTime - h.startedAt + (h.offset || 0);
    if (!Number.isFinite(t) || t < 0) t = 0;
    if (!h.loop && h.buffer && h.buffer.duration && t > h.buffer.duration) t = h.buffer.duration;
    return t;
  }

  pause(handle) {
    const h = handle || this.lastHandle;
    if (!h || h.paused) return h;
    h.offset = this.currentTime(h);
    h.paused = true;
    try { if (h.source && h.source.stop) h.source.stop(); } catch (err) { /* 忽略 */ }
    h.source = null;
    return h;
  }

  resume(handle) {
    const h = handle || this.lastHandle;
    if (!h || !h.paused || !h.buffer) return h;
    if (!this.ctx) this.ensureContext();
    if (!this.ctx) { h.paused = false; return h; }
    const offset = h.loop && h.buffer.duration ? (h.offset % h.buffer.duration) : Math.min(h.offset, h.buffer.duration);
    const src = this._makeSource(h.buffer, h.loop);
    if (h.gainNode) src.connect(h.gainNode);
    const startedAt = this.ctx.currentTime;
    try { src.start(startedAt, offset); } catch (err) { /* 忽略 */ }
    src.onended = () => { h.ended = true; };
    h.source = src;
    h.startedAt = startedAt;
    h.offset = offset;
    h.paused = false;
    h.ended = false;
    return h;
  }

  stop(handle) {
    const h = handle || this.lastHandle;
    if (!h) return h;
    const wasPlaying = !h.paused;
    h.paused = true;
    h.offset = 0;
    h.stopped = true;
    try { if (h.source && h.source.stop && wasPlaying) h.source.stop(); } catch (err) { /* 忽略 */ }
    h.source = null;
    return h;
  }

  /** 实时调整某个播放句柄的音量 */
  setHandleGain(handle, gain) {
    if (!handle || !handle.gainNode || !this.ctx) return;
    try { handle.gainNode.gain.setTargetAtTime(nfin(gain, 1), this.ctx.currentTime, 0.02); } catch (err) { handle.gainNode.gain.value = nfin(gain, 1); }
  }

  // ---------- 大厅 BGM ----------

  /** 渲染 12 秒可循环的大厅 loop（轻松、无重鼓） */
  async _renderLobby() {
    const Ctor = getOfflineCtor();
    if (!Ctor) return null;
    const rate = this.ctx ? nfin(this.ctx.sampleRate, 44100) : this.sampleRate;
    const duration = 12;
    const octx = new Ctor(2, Math.ceil(duration * rate), rate);
    const out = octx.createGain();
    out.gain.value = 0.85;
    out.connect(octx.destination);
    const bpm = 96;
    const beat = 60 / bpm;
    const barLen = beat * 4;
    const scale = SCALES.major;
    const root = parseRoot('D');
    const prog = [0, 5, 3, 4];
    const noise = makeNoiseBuffer(octx, 0.3);
    const rng = mulberry32(0x10bb17);
    for (let bar = 0; bar < Math.ceil(duration / barLen); bar++) {
      const barT = bar * barLen;
      const degree = prog[Math.floor(bar / 2) % prog.length];
      const chordSemis = [0, 2, 4].map((k) => degreeToSemi(scale, degree + k));
      const padDur = Math.min(barLen * 2 - 0.05, duration - barT);
      padChord(octx, out, barT, padDur, chordSemis.map((s) => mtof(root + 12 + s)), 0.05, false);
      const rootFreq = mtof(root - 12 + chordSemis[0]);
      for (let b = 0; b < 4; b += 2) {
        bassNote(octx, out, barT + b * beat, beat * 1.4, b === 0 ? rootFreq : mtof(root - 12 + chordSemis[2]), 0.16);
      }
      // 轻拨弦旋律
      for (let s = 0; s < 8; s++) {
        const t = barT + s * beat * 0.5;
        if (t >= duration - 0.1) break;
        if (rng() < 0.35) continue;
        const pick = Math.floor(rng() * chordSemis.length);
        tone(octx, out, {
          type: 'triangle',
          freq: mtof(root + 24 + chordSemis[pick]),
          t, dur: beat * 0.45, peak: 0.035, attack: 0.01,
        });
      }
      // 极轻的踩镲，保持节奏感
      for (let b = 0; b < 4; b += 1) hihat(octx, out, noise, barT + b * beat, 0.03, false);
    }
    const rendered = await Promise.resolve(octx.startRendering());
    normalizeBuffer(rendered, 0.7);
    return rendered;
  }

  /** 播放大厅背景音乐（音量约为主音量的 0.25 倍）
   *  渲染推迟到主线程空闲时进行：离线渲染是同步占主线程的，
   *  若在开机后立刻渲染，会让整个桌面「假死」几秒。 */
  async playBgm(kind = 'lobby') {
    if (kind === 'none' || !kind) return this.stopBgm();
    if (!this.bgmEnabled) return null;
    if (this.bgmHandle && this.bgmKind === kind && !this.bgmHandle.stopped) return this.bgmHandle;
    this.stopBgm();
    this.ensureContext();
    if (!this.ctx || this.ctx.state === 'closed') { this.pendingBgm = kind; return null; }
    if (!this.bgmBuffer) {
      if (this._bgmFailed) return null;       // 渲染过一次失败就不再反复重试
      if (this._bgmDeferred) return null;     // 已在等待空闲渲染
      this._bgmDeferred = true;
      const go = () => {
        this._bgmDeferred = false;
        if (!this.bgmEnabled || this.bgmBuffer || this._bgmFailed) return;
        this._renderLobby()
          .then((buf) => {
            this.bgmBuffer = buf;
            if (this.bgmEnabled && !this.bgmHandle) this.playBgm(kind);
          })
          .catch(() => { this._bgmFailed = true; });
      };
      if (typeof requestIdleCallback === 'function') requestIdleCallback(go, { timeout: 6000 });
      else setTimeout(go, 2500);
      return null;
    }
    if (!this.bgmEnabled) return null;
    const h = this.play(this.bgmBuffer, { at: 0, loop: true, gain: 0.25 });
    this.bgmHandle = h;
    this.bgmKind = kind;
    return h;
  }

  stopBgm() {
    if (this.bgmHandle) {
      this.stop(this.bgmHandle);
      this.bgmHandle = null;
      this.bgmKind = null;
    }
    this.pendingBgm = null;
    return this;
  }

  bgmPlaying() {
    return !!(this.bgmHandle && !this.bgmHandle.paused && !this.bgmHandle.stopped);
  }

  // ---------- 音效 ----------

  /**
   * 极短音效（全部 < 200ms），可叠加、不爆音。
   * 未 unlock 时安全降级为静默，不抛异常。
   */
  sfx(name) {
    if (!this.sfxEnabled || !name) return false;
    if (!this.ctx) {
      this.ensureContext();
      if (!this.ctx) return false;
    }
    if (this.ctx.state !== 'running') return false; // 未解锁：静默降级
    const t = this.ctx.currentTime + 0.002;
    const dest = this.master;
    if (!dest) return false;
    try {
      this._sfxGraph(name, t, dest);
    } catch (err) {
      return false;
    }
    return true;
  }

  _sfxGraph(name, t, dest) {
    switch (name) {
      case 'click':
        tone(this.ctx, dest, { type: 'square', freq: 1180, t, dur: 0.035, peak: 0.12, attack: 0.002 });
        break;
      case 'open':
        tone(this.ctx, dest, { type: 'sine', freq: 520, to: 900, t, dur: 0.09, peak: 0.16, attack: 0.004 });
        break;
      case 'close':
        tone(this.ctx, dest, { type: 'sine', freq: 760, to: 380, t, dur: 0.09, peak: 0.14, attack: 0.004 });
        break;
      case 'error':
        tone(this.ctx, dest, { type: 'square', freq: 240, to: 150, t, dur: 0.17, peak: 0.1, attack: 0.004 });
        tone(this.ctx, dest, { type: 'square', freq: 232, to: 144, t, dur: 0.17, peak: 0.07, attack: 0.004 });
        break;
      case 'ok':
        tone(this.ctx, dest, { type: 'sine', freq: 660, t, dur: 0.06, peak: 0.14, attack: 0.003 });
        tone(this.ctx, dest, { type: 'sine', freq: 990, t: t + 0.055, dur: 0.09, peak: 0.13, attack: 0.003 });
        break;
      case 'typing':
        tone(this.ctx, dest, { type: 'square', freq: 1500 + ((t * 1000) % 7) * 40, t, dur: 0.02, peak: 0.07, attack: 0.001 });
        break;
      case 'boot':
        tone(this.ctx, dest, { type: 'triangle', freq: 180, to: 1180, t, dur: 0.18, peak: 0.14, attack: 0.01 });
        tone(this.ctx, dest, { type: 'sine', freq: 520, to: 1560, t: t + 0.04, dur: 0.13, peak: 0.07, attack: 0.006 });
        break;
      case 'judge-perfect':
        tone(this.ctx, dest, { type: 'sine', freq: 1568, t, dur: 0.085, peak: 0.2, attack: 0.002 });
        tone(this.ctx, dest, { type: 'sine', freq: 2093, t, dur: 0.05, peak: 0.09, attack: 0.002 });
        break;
      case 'judge-good':
        tone(this.ctx, dest, { type: 'sine', freq: 1046, t, dur: 0.07, peak: 0.16, attack: 0.002 });
        break;
      case 'judge-bad':
        tone(this.ctx, dest, { type: 'triangle', freq: 300, to: 240, t, dur: 0.1, peak: 0.12, attack: 0.002 });
        break;
      case 'judge-miss':
        tone(this.ctx, dest, { type: 'sine', freq: 160, to: 110, t, dur: 0.14, peak: 0.1, attack: 0.003 });
        break;
      case 'combo':
        tone(this.ctx, dest, { type: 'sine', freq: 1318, t, dur: 0.05, peak: 0.1, attack: 0.002 });
        tone(this.ctx, dest, { type: 'sine', freq: 1760, t: t + 0.04, dur: 0.06, peak: 0.09, attack: 0.002 });
        break;
      default:
        tone(this.ctx, dest, { type: 'sine', freq: 880, t, dur: 0.05, peak: 0.1, attack: 0.002 });
        break;
    }
  }

  /** 全部可用音效名 */
  static sfxNames() {
    return ['click', 'open', 'close', 'error', 'ok', 'typing', 'boot',
      'judge-perfect', 'judge-good', 'judge-bad', 'judge-miss', 'combo'];
  }
}

// ---------------------------------------------------------------- 单例与工厂

if (!AudioEngine.instance) AudioEngine.instance = new AudioEngine();

/** 兼容便捷导出 */
export const audio = AudioEngine.instance;

/**
 * 内核使用的工厂：createAudioEngine(store) -> AudioEngine 单例
 * @param {Object} store state 模块实例（get/raw/set/update/subscribe）
 */
export function createAudioEngine(store) {
  const engine = AudioEngine.instance;
  if (store) engine.attachStore(store);
  return engine;
}

export default AudioEngine.instance;
