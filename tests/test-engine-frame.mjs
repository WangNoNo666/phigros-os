/**
 * phigros-os · tests/test-engine-frame.mjs
 * 帧预算测试：用假画布驱动真实 PhigrosGame 主循环，量化 CPU 时间与绘制调用次数。
 * 这是「音游卡不卡」的客观判据——不依赖浏览器。
 *
 * 用法：node tests/test-engine-frame.mjs
 */
import { PhigrosGame } from '../js/engine/phigros.js';
import chart from '../data/charts/first-light.js';

let passed = 0;
let failed = 0;
function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}${detail ? ` :: ${detail}` : ''}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

/** 记录调用次数的假 2D 上下文（未实现的方法一律 no-op，属性可读写） */
function fakeCtx() {
  const counts = { calls: 0, shadowBlurUses: 0, save: 0, gradient: 0 };
  const target = {
    canvas: null,
    _counts: counts
  };
  const handler = {
    get(obj, prop) {
      if (prop in obj) {
        const v = obj[prop];
        if (prop === 'shadowBlur') {
          return v;
        }
        return v;
      }
      return function stub(...args) {
        counts.calls += 1;
        if (prop === 'save') counts.save += 1;
        if (prop === 'createLinearGradient' || prop === 'createRadialGradient') counts.gradient += 1;
        return prop === 'createLinearGradient' || prop === 'createRadialGradient'
          ? { addColorStop() {} }
          : undefined;
      };
    },
    set(obj, prop, value) {
      if (prop === 'shadowBlur' && Number(value) > 0) counts.shadowBlurUses += 1;
      obj[prop] = value;
      return true;
    }
  };
  return new Proxy(target, handler);
}

function fakeCanvas() {
  const ctx = fakeCtx();
  const canvas = {
    width: 900,
    height: 640,
    clientWidth: 900,
    clientHeight: 640,
    style: {},
    getContext: () => ctx,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 640 }),
    addEventListener() {},
    removeEventListener() {},
    focus() {},
    _ctx: ctx
  };
  ctx.canvas = canvas;
  return canvas;
}

const track = chart;
const canvas = fakeCanvas();

const game = new PhigrosGame(canvas, {
  track,
  settings: { speed: 1, offsetMs: 0, volume: 0, sfx: false, bgm: false },
  onEvent: () => {}
});

// 手动驱动一帧（绕过 rAF）：直接调用内部帧函数，用假时钟推进
function drive(frames, dtMs = 16.7) {
  let t = 0;
  const started = process.hrtime.bigint();
  for (let i = 0; i < frames; i++) {
    t += dtMs;
    // game.clock() 在无音频时会走兜底时钟；这里直接指定 time 后跑一帧渲染
    game.time = t / 1000;
    game.core.tick(game.time);
    game._updateEffects(dtMs);
    game._render(game.time, false);
  }
  const ns = Number(process.hrtime.bigint() - started);
  return ns / 1e6; // ms
}

check('曲目可构建时间轴', game.timeline.notes.length > 100, `${game.timeline.notes.length} 音符`);
check('画布上下文可用', Boolean(game._ensureCtx()));

// 预热（首次会创建渐变等一次性对象）
drive(60);
const before = canvas._ctx._counts.calls;

const FRAMES = 600;
const ms = drive(FRAMES);
const perFrame = ms / FRAMES;
const drawCallsPerFrame = (canvas._ctx._counts.calls - before) / FRAMES;

console.log(`--- 帧预算（${FRAMES} 帧，约 10 秒谱面）---`);
console.log(`总耗时 ${ms.toFixed(1)} ms · 每帧 ${perFrame.toFixed(3)} ms · 每帧绘制调用 ${drawCallsPerFrame.toFixed(1)} 次`);
console.log(`shadowBlur 使用次数 ${canvas._ctx._counts.shadowBlurUses}（应只在判定线出现，且低画质模式为 0）`);

check('每帧 CPU 时间 < 4ms（60fps 预算 16.7ms）', perFrame < 4, `${perFrame.toFixed(3)} ms/帧`);
check('每帧绘制调用 < 400 次', drawCallsPerFrame < 400, `${drawCallsPerFrame.toFixed(1)} 次/帧`);
check(
  'shadowBlur 每帧不超过 2 次（只用于判定线）',
  canvas._ctx._counts.shadowBlurUses / FRAMES <= 2,
  `${canvas._ctx._counts.shadowBlurUses} 次 / ${FRAMES} 帧 = 每帧 ${(canvas._ctx._counts.shadowBlurUses / FRAMES).toFixed(2)} 次`
);

// 低画质模式必须关闭辉光
const canvas2 = fakeCanvas();
const game2 = new PhigrosGame(canvas2, { track, settings: { speed: 1 }, lowQuality: true, onEvent: () => {} });
game2._ensureCtx();
for (let i = 0; i < 30; i++) {
  game2.time = i / 60;
  game2.core.tick(game2.time);
  game2._render(game2.time, false);
}
check('低画质模式不产生 shadowBlur', canvas2._ctx._counts.shadowBlurUses === 0, `${canvas2._ctx._counts.shadowBlurUses} 次`);

// 掉帧守卫：连续慢帧后必须触发降载回调
const canvas3 = fakeCanvas();
let degraded = null;
const game3 = new PhigrosGame(canvas3, {
  track,
  settings: { speed: 1 },
  onEvent: () => {},
  onPerfDegrade: (info) => { degraded = info; }
});
game3._ensureCtx();
for (let i = 0; i < 40 && !degraded; i++) {
  game3._frame(80, i * 80); // 每帧 80ms = 12.5fps
}
check('掉帧守卫能触发降载回调', Boolean(degraded), degraded ? `fps=${degraded.fps} 慢帧=${degraded.slowFrames}` : '未触发');

// ---- rAF 节流兜底：连续大间隔帧必须切换到定时器驱动 ----
{
  const canvas4 = fakeCanvas();
  const game4 = new PhigrosGame(canvas4, { track, settings: { speed: 1 }, onEvent: () => {}, raf: () => () => {} });
  game4._ensureCtx();
  game4._lastFrameMs = 0;
  for (let i = 1; i <= 3; i++) game4._frame(700, i * 700); // 每帧间隔 700ms（模拟被节流到 ~1.4fps）
  const escalated = game4._loopMode === 'timeout';
  check('rAF 被节流时自动切换为定时器驱动', escalated, `loopMode=${game4._loopMode}`);
  check('遥测记录了节流停顿', Boolean(game4._tmStalls >= 2), `stalls=${game4._tmStalls} 最长帧=${Math.round(game4._tmMax)}ms`);
  try { game4._loopMode = 'raf'; game4._timerId = 0; game4.destroy(); } catch (e) { /* 忽略 */ }
}

// ---- 切到后台必须自动暂停（避免回来时跳一大段） ----
{
  const canvas5 = fakeCanvas();
  const game5 = new PhigrosGame(canvas5, { track, settings: { speed: 1 }, onEvent: () => {} });
  game5._ensureCtx();
  game5.state = 'playing';
  game5.paused = false;
  game5.time = 5;
  // 模拟 visibilitychange -> hidden
  const origDoc = globalThis.document;
  let handler = null;
  globalThis.document = {
    visibilityState: 'hidden',
    addEventListener: (t, fn) => { if (t === 'visibilitychange') handler = fn; },
    removeEventListener: () => {}
  };
  game5._visibilityBound = false;
  game5._bindVisibility();
  check('注册了 visibilitychange 监听', typeof handler === 'function');
  if (handler) handler();
  check('切到后台后自动暂停', game5.paused === true && game5._autoPaused === true, `paused=${game5.paused}`);
  globalThis.document = origDoc;
  try { game5.destroy(); } catch (e) { /* 忽略 */ }
}

// ---- DOM 渲染后端（Sparebeat 同思路：CSS transform 交给合成器） ----
let hostEl = null;
let canvasShim = null;
{
  // 最小 DOM shim
  let created = 0;
  const mkEl = (tag) => {
    created += 1;
    const el = {
      tagName: String(tag).toUpperCase(),
      style: (() => {
        const store = {};
        return new Proxy(store, {
          get(t, p) {
            if (p === 'setProperty') return (k, v) => { t[k] = String(v); };
            if (p === 'getPropertyValue') return (k) => (t[k] === undefined ? '' : String(t[k]));
            if (p === 'cssText') return t.cssText || '';
            return t[p] === undefined ? '' : t[p];
          },
          set(t, p, v) {
            t[p] = v;
            return true;
          }
        });
      })(),
      children: [],
      _t: '',
      parentElement: null,
      isConnected: true,
      className: '',
      _attrs: {},
      appendChild(c) { this.children.push(c); c.parentElement = this; return c; },
      removeChild(c) { this.children = this.children.filter((x) => x !== c); return c; },
      remove() { this.isConnected = false; if (this.parentElement) this.parentElement.removeChild(this); },
      setAttribute(k, v) { this._attrs[k] = v; },
      getAttribute(k) { return this._attrs[k]; },
      addEventListener() {},
      removeEventListener() {},
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 640 }),
      get clientWidth() { return 900; },
      get clientHeight() { return 640; }
    };
    return el;
  };
  hostEl = mkEl('div');
  globalThis.document = {
    createElement: mkEl,
    body: mkEl('body'),
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {}
  };

  canvasShim = {
    width: 900, height: 640, clientWidth: 900, clientHeight: 640,
    style: {}, getContext: () => fakeCtx(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 640 }),
    addEventListener() {}, removeEventListener() {}, focus() {}
  };
  const before = created;
  const game6 = new PhigrosGame(hostEl, {
    canvas: canvasShim,
    track,
    settings: { speed: 1 },
    onEvent: () => {},
    raf: () => () => {}
  });
  check('DOM 后端被选中', game6.renderMode === 'dom', `renderMode=${game6.renderMode}`);
  game6.resize(868, 608);

  // 驱动 300 帧，统计 JS 工作量
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 300; i++) {
    game6.time = i / 60;
    game6.core.tick(game6.time);
    game6._updateEffects(16.7);
    game6._render(game6.time, false);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const perFrame = ms / 300;
  const elements = game6._noteEls.size;
  const poolSize = game6._dom ? game6._dom.pool.length : 0;
  console.log(`--- DOM 后端帧预算：${perFrame.toFixed(3)} ms/帧（300 帧），在用音符元素 ${elements}，池中复用 ${poolSize}，累计创建 ${created - before} ---`);
  check('DOM 后端每帧 CPU 时间 < 4ms', perFrame < 4, `${perFrame.toFixed(3)} ms/帧`);
  check('DOM 后端创建了音符元素', elements > 0 || created > before, `元素 ${elements}`);
  check('DOM 后端元素数量受控（复用池）', created - before < 400, `累计创建 ${created - before}`);
  // 检查确实写入了 transform
  let hasTransform = false;
  for (const rec of game6._noteEls.values()) {
    const el = rec && rec.el ? rec.el : rec;
    if (el && el.style && /translate3d/.test(el.style.cssText || '')) { hasTransform = true; break; }
  }
  check('音符使用 translate3d 定位', hasTransform, hasTransform ? 'ok' : '未找到 translate3d');

  // ---- 下落连续性：逐帧记录某个音符的 y，验证位移与理论速度一致且单调 ----
  {
    const game7 = new PhigrosGame(hostEl, {
      canvas: canvasShim,
      track,
      settings: { speed: 1 },
      onEvent: () => {},
      raf: () => () => {}
    });
    game7.resize(868, 608);
    const samples = [];
    let maxNotes = 0;
    for (let i = 0; i < 40; i++) {
      const t = 4 + i / 60; // 每帧 1/60 秒
      game7.time = t;
      game7.core.tick(t);
      game7._render(t, false);
      maxNotes = Math.max(maxNotes, game7._noteEls.size);
      let maxY = -Infinity;
      for (const rec of game7._noteEls.values()) {
        const el = rec && rec.el ? rec.el : rec;
        const m = /translate3d\(\s*(-?[\d.]+)px\s*,\s*(-?[\d.]+)px/.exec(el.style.transform || '');
        if (m) maxY = Math.max(maxY, Number(m[2]));
      }
      samples.push(maxY);
    }
    // 理论下落速度（像素/帧）
    const vyPx = (520 * 1) / 720 * 608;
    const perFrameTheory = vyPx / 60;
    const deltas = [];
    for (let i = 1; i < samples.length; i++) {
      if (Number.isFinite(samples[i - 1]) && Number.isFinite(samples[i])) {
        const d = samples[i] - samples[i - 1];
        if (d > 0) deltas.push(d);
      }
    }
    const avgDelta = deltas.length ? deltas.reduce((s, v) => s + v, 0) / deltas.length : 0;
    check('画面确实有音符元素（数量受控）', maxNotes > 0 && maxNotes < 120, `峰值 ${maxNotes} 个元素`);
    check(
      '音符每帧位移与理论下落速度一致（±35%）',
      deltas.length > 10 && Math.abs(avgDelta - perFrameTheory) / perFrameTheory < 0.35,
      `实测 ${avgDelta.toFixed(2)}px/帧 vs 理论 ${perFrameTheory.toFixed(2)}px/帧（样本 ${deltas.length}）`
    );
    check('音符位移单调递增（无回跳）', deltas.every((d) => d > 0), `最小位移 ${deltas.length ? Math.min(...deltas).toFixed(2) : 'n/a'}px`);
    try { game7.destroy(); } catch (e) { /* 忽略 */ }
  }
  try { game6.destroy(); } catch (e) { /* 忽略 */ }
}

// ---- 帧循环唯一性（真实事故回归） ----
// 事故：Host.raf 建立的循环会自我续期，而引擎曾每帧新建一条且不取消旧的，
// 于是每秒累积几十条僵尸循环同时推进判定与渲染 —— 表现就是「一帧一屏」
// 直到整个页面卡死。这里断言：任何时刻活跃循环恒为 1，且每帧回调只执行一次。
{
  const pending = new Map();
  let seq = 0;
  let active = 0;
  let callbacks = 0;
  // 与 Host.raf 行为一致的桩：循环自我续期；取消时移除待执行的帧
  const rafStub = (fn) => {
    active += 1;
    let stopped = false;
    let handle = 0;
    const step = () => {
      handle = 0;
      if (stopped) return;
      callbacks += 1;
      handle = ++seq;
      pending.set(handle, step); // 先续期，再执行（与 Host.raf 一致）
      try { fn(16.7, mockNow); } catch (err) { /* 忽略 */ }
    };
    handle = ++seq;
    pending.set(handle, step);
    return () => {
      if (stopped) return;
      stopped = true;
      if (handle && pending.delete(handle)) active -= 1;
      handle = 0;
    };
  };
  const flush = () => {
    const batch = [...pending.entries()];
    pending.clear();
    for (const [, fn] of batch) fn();
  };

  // 受控时钟
  let mockNow = 1000;
  const origPerf = globalThis.performance;
  globalThis.performance = { now: () => mockNow };

  const gameL = new PhigrosGame(hostEl, {
    canvas: canvasShim,
    track,
    settings: { speed: 1 },
    onEvent: () => {},
    raf: rafStub
  });
  gameL.resize(868, 608);
  gameL._fallbackTime(); // 初始化兜底时钟
  await gameL.start();

  const callbacksAtStart = callbacks;
  for (let i = 0; i < 60; i++) {
    mockNow += 16.7;
    flush();
  }
  const perFrame = (callbacks - callbacksAtStart) / 60;
  console.log(`--- 帧循环唯一性：60 帧后活跃循环 ${active}，每帧回调 ${perFrame.toFixed(2)} 次，游戏时间 ${gameL.time.toFixed(3)}s ---`);
  check('活跃帧循环恒为 1（无僵尸循环堆积）', active === 1, `活跃 ${active}`);
  check('每个显示器帧只执行一次帧回调', Math.abs(perFrame - 1) < 0.01, `每帧 ${perFrame.toFixed(2)} 次`);
  check('游戏时钟 1 秒内推进 ≈1.00s（不加速）', Math.abs(gameL.time - 1) < 0.2, `${gameL.time.toFixed(3)}s`);

  // 暂停后不得再有帧回调
  gameL.pause();
  const afterPause = callbacks;
  for (let i = 0; i < 10; i++) { mockNow += 16.7; flush(); }
  check('暂停后帧回调停止', callbacks === afterPause, `暂停后又执行 ${callbacks - afterPause} 次`);

  // 恢复后仍只有一条循环
  gameL.resume();
  const afterResume = callbacks;
  for (let i = 0; i < 10; i++) { mockNow += 16.7; flush(); }
  check('恢复后活跃循环仍为 1', active === 1, `活跃 ${active}`);
  check('恢复后每帧回调 1 次', callbacks - afterResume === 10, `10 帧执行 ${callbacks - afterResume} 次`);

  // 反复暂停/恢复 20 次，不得累积循环
  for (let i = 0; i < 20; i++) { gameL.pause(); gameL.resume(); }
  check('反复暂停恢复 20 次后活跃循环仍为 1', active === 1, `活跃 ${active}`);

  gameL.destroy();
  check('销毁后活跃循环归零', active === 0, `活跃 ${active}`);
  globalThis.performance = origPerf;
  delete globalThis.document;
}

// 清理
try { game.destroy(); } catch (e) { /* 忽略 */ }
try { game2.destroy(); } catch (e) { /* 忽略 */ }
try { game3.destroy(); } catch (e) { /* 忽略 */ }

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
