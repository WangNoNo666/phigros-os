/**
 * phigrOS · boot.js
 * 启动入口：装配内核、暴露 window.PhigrOS、处理首次手势解锁音频。
 */
import createKernel, { VERSION } from './js/core/kernel.js';

const bootStart = performance.now();

const kernel = createKernel({ document });

window.PhigrOS = {
  version: VERSION,
  kernel,
  host: null,
  wm: null,
  audio: null,
  get state() {
    return kernel.store;
  },
  ready: null
};
// 尽量早地挂上 Host（应用与验收脚本都依赖 window.Host）
window.Host = null;

// 首次用户手势：解锁 AudioContext
function unlockOnce() {
  try {
    if (kernel.host && kernel.host.audio) {
      const r = kernel.host.audio.unlock();
      // 某些环境下 resume() 的 Promise 可能一直不落地，绝不能变成未处理拒绝
      if (r && typeof r.catch === 'function') r.catch((err) => console.warn('[phigrOS] 音频解锁失败', err));
    }
  } catch (err) {
    console.warn('[phigrOS] 音频解锁失败', err);
  }
  window.removeEventListener('pointerdown', unlockOnce);
  window.removeEventListener('keydown', unlockOnce);
}
window.addEventListener('pointerdown', unlockOnce, { once: false });
window.addEventListener('keydown', unlockOnce, { once: false });

window.PhigrOS.ready = kernel
  .boot()
  .then((k) => {
    window.PhigrOS.bootMs = Math.round(performance.now() - bootStart);
    console.log(`[phigrOS] 就绪，用时 ${window.PhigrOS.bootMs} ms，应用 ${k.manifest.length} 个`);
    return k;
  })
  .catch((err) => {
    console.error('[phigrOS] 启动失败', err);
    const el = document.getElementById('boot-log');
    if (el) {
      const div = document.createElement('div');
      div.className = 'boot-line err';
      div.textContent = `启动失败：${err && err.message ? err.message : err}`;
      el.appendChild(div);
    }
    throw err;
  });

// 全局错误提示（便于验收时定位问题）
window.addEventListener('error', (e) => {
  console.error('[phigrOS] 未捕获错误', e.error || e.message);
});
window.addEventListener('unhandledrejection', (e) => {
  console.error('[phigrOS] 未处理的 Promise 拒绝', e.reason);
});

export default kernel;
