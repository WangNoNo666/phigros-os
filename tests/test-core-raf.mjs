/**
 * phigros-os · tests/test-core-raf.mjs
 * 回归测试：Host.raf 的帧循环与 visibilitychange 监听绝不能泄漏。
 *
 * 背景（真实事故）：早期实现每次 raf() 都注册一个 visibilitychange 监听，
 * 而引擎每帧调用一次、又丢弃返回的取消函数 —— 监听器以 60/秒泄漏。
 * 用户切换标签页时，成百上千个陈旧监听器同时把旧帧循环重新启动，
 * 多条帧循环并发推进同一个判定核 → 游戏时钟跑到 2.88 倍速、音符跳格、
 * 最终整个页面卡死。
 *
 * 用法：node tests/test-core-raf.mjs
 */
import { createHost } from '../js/core/host.js';
import { State } from '../js/core/state.js';

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

// ---------------- 可计数的 DOM / rAF 桩 ----------------
function makeEnv() {
  const stats = { visListeners: 0, rafScheduled: 0, rafCancelled: 0, pending: new Map(), id: 0, hidden: false, handlers: new Set() };
  const doc = {
    hidden: false,
    addEventListener(type, fn) {
      if (type === 'visibilitychange') {
        stats.visListeners += 1;
        stats.handlers.add(fn);
      }
    },
    removeEventListener(type, fn) {
      if (type === 'visibilitychange') {
        stats.visListeners -= 1;
        stats.handlers.delete(fn);
      }
    },
    /** 模拟浏览器派发 visibilitychange */
    dispatchVisibility(hidden) {
      doc.hidden = hidden;
      for (const fn of [...stats.handlers]) fn();
    },
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({
      style: { cssText: '', setProperty() {} },
      classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
      dataset: {},
      appendChild() {},
      addEventListener() {},
      setAttribute() {},
      remove() {}
    }),
    createTextNode: (t) => ({ text: t }),
    body: { appendChild() {} },
    defaultView: null
  };
  const win = {
    requestAnimationFrame(fn) {
      stats.rafScheduled += 1;
      const id = ++stats.id;
      stats.pending.set(id, fn);
      return id;
    },
    cancelAnimationFrame(id) {
      if (stats.pending.has(id)) {
        stats.rafCancelled += 1;
        stats.pending.delete(id);
      }
    },
    performance: { now: () => Number(process.hrtime.bigint() / 1000000n) },
    addEventListener() {},
    setTimeout,
    clearTimeout
  };
  doc.defaultView = win;
  globalThis.document = doc;
  globalThis.window = win;
  globalThis.performance = win.performance;
  globalThis.requestAnimationFrame = win.requestAnimationFrame;
  globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
  return { doc, win, stats };
}

/** 让所有待执行的 rAF 回调跑一轮 */
function flushRaf(stats, times = 1) {
  for (let i = 0; i < times; i++) {
    const batch = [...stats.pending.entries()];
    stats.pending.clear();
    for (const [, fn] of batch) fn(1000 + i * 16.7);
  }
}

const { doc, stats } = makeEnv();
const store = new State({ storage: null });
const host = createHost({
  state: store,
  kernel: { apps: new Map(), registry: new Map(), manifest: [] },
  audio: null,
  wm: { list: () => [], launch: () => null, close() {}, focus() {}, on: () => () => {}, focused: () => null },
  document: doc
});

// ---------------- 1. 高频调用不得泄漏监听器 ----------------
{
  const before = stats.visListeners;
  for (let i = 0; i < 200; i++) host.raf(() => {});
  check(
    '连续 200 次 raf() 只注册 1 个 visibilitychange 监听',
    stats.visListeners === 1,
    `监听数 ${stats.visListeners}（新增 ${stats.visListeners - before}）`
  );
  check('活跃循环计数正确', host.rafLoopCount() === 200, `活跃 ${host.rafLoopCount()}`);
}

// ---------------- 2. 取消后监听归零 ----------------
{
  // 上面的 200 个循环没有取消函数，这里用新的环境做干净验证
  const env2 = makeEnv();
  const host2 = createHost({
    state: new State({ storage: null }),
    kernel: { apps: new Map(), registry: new Map(), manifest: [] },
    audio: null,
    wm: { list: () => [], launch: () => null, close() {}, focus() {}, on: () => () => {}, focused: () => null },
    document: env2.doc
  });
  const cancels = [];
  for (let i = 0; i < 50; i++) cancels.push(host2.raf(() => {}));
  check('50 个循环仍只有 1 个监听', env2.stats.visListeners === 1, `监听 ${env2.stats.visListeners}`);
  for (const c of cancels) c();
  check('全部取消后监听被移除', env2.stats.visListeners === 0, `监听 ${env2.stats.visListeners}`);
  check('全部取消后活跃循环为 0', host2.rafLoopCount() === 0, `活跃 ${host2.rafLoopCount()}`);
}

// ---------------- 3. 引擎式用法：每帧取消上一次，不得累积 ----------------
{
  const env3 = makeEnv();
  const host3 = createHost({
    state: new State({ storage: null }),
    kernel: { apps: new Map(), registry: new Map(), manifest: [] },
    audio: null,
    wm: { list: () => [], launch: () => null, close() {}, focus() {}, on: () => () => {}, focused: () => null },
    document: env3.doc
  });
  let frames = 0;
  let cancel = null;
  const loop = () => {
    if (frames > 300) return;
    frames += 1;
    if (cancel) cancel(); // 引擎 _schedule 的正确用法
    cancel = host3.raf(loop);
  };
  cancel = host3.raf(loop);
  for (let i = 0; i < 60; i++) flushRaf(env3.stats, 1);
  check('逐帧取消+重排 60 轮后活跃循环恒为 1', host3.rafLoopCount() === 1, `活跃 ${host3.rafLoopCount()}，帧数 ${frames}`);
  check('逐帧取消+重排 60 轮后仍只有 1 个监听', env3.stats.visListeners === 1, `监听 ${env3.stats.visListeners}`);
  if (cancel) cancel();
  check('收尾后监听与循环都清空', env3.stats.visListeners === 0 && host3.rafLoopCount() === 0,
    `监听 ${env3.stats.visListeners} 活跃 ${host3.rafLoopCount()}`);
}

// ---------------- 4. 隐藏/恢复不得复制循环 ----------------
{
  const env4 = makeEnv();
  const host4 = createHost({
    state: new State({ storage: null }),
    kernel: { apps: new Map(), registry: new Map(), manifest: [] },
    audio: null,
    wm: { list: () => [], launch: () => null, close() {}, focus() {}, on: () => () => {}, focused: () => null },
    document: env4.doc
  });
  let ticks = 0;
  const cancel = host4.raf(() => { ticks += 1; });
  flushRaf(env4.stats, 1); // 跑一帧

  // 模拟 10 次「切走 → 切回」，每次都真实派发 visibilitychange
  for (let i = 0; i < 10; i++) {
    env4.doc.dispatchVisibility(true);
    env4.doc.dispatchVisibility(false);
  }
  check('10 次切后台/恢复后活跃循环仍为 1', host4.rafLoopCount() === 1, `活跃 ${host4.rafLoopCount()}`);
  check('10 次切后台/恢复后监听数仍为 1', env4.stats.visListeners === 1, `监听 ${env4.stats.visListeners}`);

  const before = env4.stats.rafScheduled;
  flushRaf(env4.stats, 5);
  const perFrame = (env4.stats.rafScheduled - before) / 5;
  check('恢复后每帧仍只排 1 次 rAF（无循环叠加）', Math.abs(perFrame - 1) < 0.01, `每帧 ${perFrame.toFixed(2)} 次`);
  const tickBefore = ticks;
  flushRaf(env4.stats, 5);
  check('回调每帧只被调用 1 次', ticks - tickBefore === 5, `5 帧调用 ${ticks - tickBefore} 次`);
  cancel();
  check('取消后监听与循环都清空', env4.stats.visListeners === 0 && host4.rafLoopCount() === 0,
    `监听 ${env4.stats.visListeners} 活跃 ${host4.rafLoopCount()}`);
}

// 清理全局
delete globalThis.document;
delete globalThis.window;

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
