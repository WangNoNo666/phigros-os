/**
 * phigrOS · js/core/kernel.js
 * 内核：应用登记 / 启动 / 子系统装配 / 生命周期。
 */
import { store } from './state.js';
import { createAudioEngine } from '../engine/audio.js';
import { createWindowManager } from '../shell/wm.js';
import { createTaskbar } from '../shell/taskbar.js';
import { createCompositor } from './compositor.js';
import { createHost } from './host.js';

export const VERSION = '1.0.0';

export function createKernel(options = {}) {
  const kernel = {
    version: VERSION,
    store,
    bootStartedAt: nowStamp(),
    apps: new Map(), // appId -> 已完整加载的应用模块（带 mount）
    registry: new Map(), // appId -> 清单项（可能是只有 loader 的惰性项）
    manifest: [], // 有序清单
    audio: null,
    wm: null,
    taskbar: null,
    compositor: null,
    host: null,
    document: options.document || (typeof document !== 'undefined' ? document : null),
    _appLoadCache: new Map()
  };

  // ---- 时间基准（UI 动画用） ----
  function nowStamp() {
    if (typeof performance !== 'undefined' && performance.now) return performance.now();
    return Date.now();
  }

  // ---- 应用登记 ----
  kernel.registerApp = function registerApp(app) {
    if (!app || !app.id) return false;
    kernel.apps.set(app.id, app);
    return true;
  };

  kernel.registerManifest = function registerManifest(list) {
    kernel.manifest = (list || []).filter((a) => a && a.id);
    for (const app of kernel.manifest) {
      kernel.registry.set(app.id, app);
      // 只有真正带 mount 的清单项才算「已加载」
      if (typeof app.mount === 'function') kernel.apps.set(app.id, app);
    }
    return kernel.manifest.length;
  };

  /**
   * 惰性加载应用模块（manifest 用动态 import 时会挂 app.loader）。
   * 失败会 reject，由 wm 负责提示。
   */
  kernel.loadApp = async function loadApp(appId) {
    const loaded = kernel.apps.get(appId);
    if (loaded && typeof loaded.mount === 'function') return loaded;
    if (kernel._appLoadCache.has(appId)) {
      const cached = await kernel._appLoadCache.get(appId);
      if (cached && typeof cached.mount === 'function') return cached;
    }
    const entry = kernel.registry.get(appId);
    if (!entry) throw new Error(`未找到应用：${appId}`);
    if (typeof entry.loader !== 'function') {
      throw new Error(`应用 ${appId} 缺少 mount 与 loader，无法启动`);
    }
    const p = Promise.resolve()
      .then(() => entry.loader())
      .then((mod) => (mod && mod.default ? mod.default : mod))
      .then((app) => {
        if (!app || !app.id) throw new Error(`应用模块无效：${appId}`);
        if (typeof app.mount !== 'function') throw new Error(`应用 ${appId} 未导出 mount()`);
        kernel.registerApp(app);
        return app;
      });
    kernel._appLoadCache.set(appId, p);
    return p;
  };

  // ---- 开机 ----
  kernel.boot = async function boot() {
    const t0 = nowStamp();
    const doc = kernel.document;
    const bootEl = doc && doc.getElementById('boot');
    const logEl = doc && doc.getElementById('boot-log');
    const barEl = doc && doc.getElementById('boot-bar-fill');

    const lines = [
      ['phigrOS BIOS v1.0.0', 0],
      ['检测音频子系统 ... OK', 120],
      ['挂载虚拟文件系统 ... OK', 260],
      ['校准节奏时钟 (AudioContext) ... OK', 420],
      ['加载窗口合成器 ... OK', 560],
      ['注册应用清单 ...', 700],
      ['启动桌面环境 ...', 860]
    ];

    const pushLine = (text) => {
      if (!logEl) return;
      const div = doc.createElement('div');
      div.className = 'boot-line';
      div.textContent = text;
      logEl.appendChild(div);
      logEl.scrollTop = logEl.scrollHeight;
    };

    const setBar = (p) => {
      if (barEl) barEl.style.width = `${Math.round(p * 100)}%`;
    };

    const firstRun = Boolean(store.raw().boot.firstRun) || store.raw().boot.bootCount === 0;

    // 注册应用清单
    let manifestOk = [];
    try {
      const mod = await import('../apps/manifest.js');
      manifestOk = kernel.registerManifest(await resolveManifest(mod.default !== undefined ? mod.default : mod));
    } catch (err) {
      console.warn('[phigrOS] 应用清单加载失败', err);
      pushLine(`警告：应用清单加载失败（${err && err.message ? err.message : err}）`);
    }

    for (const [text, delay] of lines) {
      pushLine(text);
      setBar((delay + 120) / 1100);
      await wait(delay);
    }
    pushLine(`已登记 ${kernel.manifest.length} 个应用` + (manifestOk.length ? '' : '（部分应用不可用）'));

    // 初始文件系统
    try {
      const fsinit = await import('../apps/fsinit.js');
      const seeded = fsinit.seedFs(store.raw().fs, { firstRun });
      store.set('fs', seeded);
    } catch (err) {
      console.warn('[phigrOS] 初始文件系统写入失败', err);
    }

    // 音频子系统
    kernel.audio = createAudioEngine(store);
    // 后台预热：探测本环境能否离线渲染音频（几十毫秒的极短试渲染）。
    // 提前知道结果，玩家点「开始」时就不会有任何等待。
    try {
      if (typeof kernel.audio.warmupProbe === 'function') {
        kernel.audio.warmupProbe().then((ok) => {
          if (!ok) pushLine('提示：本环境音频合成不可用，音游将使用无音乐模式（判定不受影响）');
        }).catch(() => {});
      }
    } catch (err) { /* 忽略 */ }
    pushLine('音频引擎就绪');
    // 窗口管理器
    kernel.wm = createWindowManager({
      root: doc.getElementById('windows'),
      state: store,
      host: null, // 稍后回填
      kernel
    });
    // 桌面合成
    kernel.compositor = createCompositor({ state: store, kernel });
    // 任务栏
    kernel.taskbar = createTaskbar({
      root: doc.getElementById('taskbar'),
      state: store,
      wm: kernel.wm,
      startMenu: { toggle: () => kernel.compositor.startMenu.toggle() }
    });
    // 宿主 API
    kernel.host = createHost({
      state: store,
      kernel,
      audio: kernel.audio,
      wm: kernel.wm,
      document: doc,
      version: VERSION
    });
    // 回填 host（wm 的拖动音效、通知等需要）。
    // 注意：子系统的 ctx 未必存在（各自的实现细节），任何一处缺失都不能中断开机。
    if (kernel.wm && kernel.wm.ctx) kernel.wm.ctx.host = kernel.host;
    if (kernel.taskbar && kernel.taskbar.ctx) kernel.taskbar.ctx.host = kernel.host;
    if (kernel.compositor && kernel.compositor.ctx) kernel.compositor.ctx.host = kernel.host;
    if (kernel.host) {
      if (kernel.compositor && kernel.compositor.desktop) kernel.host.desktop = kernel.compositor.desktop;
      else if (typeof kernel.host.desktop !== 'object') kernel.host.desktop = null;
      if (kernel.compositor && kernel.compositor.startMenu) kernel.host.startMenu = kernel.compositor.startMenu;
    }

    kernel.compositor.mount();
    kernel.taskbar.render();
    kernel.compositor.applyTheme();

    // 应用通过 window.Host 访问宿主能力（CONTRACT §4 承诺）
    if (typeof window !== 'undefined') {
      window.Host = kernel.host;
      if (window.PhigrOS) {
        window.PhigrOS.host = kernel.host;
        window.PhigrOS.wm = kernel.wm;
        window.PhigrOS.audio = kernel.audio;
      }
    }

    const bootMs = Math.round(nowStamp() - t0);
    pushLine(`启动完成，用时 ${bootMs} ms`);
    setBar(1);

    store.set('boot.bootTimeMs', bootMs);
    store.set('boot.bootCount', Number(store.raw().boot.bootCount || 0) + 1);
    store.set('boot.lastBootAt', Date.now());
    store.set('boot.firstRun', false);
    store.save();

    await kernel.host.achievement('boot', '第一次开机', 'Welcome to phigrOS');

    // 淡出开机屏
    if (bootEl) {
      bootEl.classList.add('boot-done');
      await wait(420);
      bootEl.classList.add('hidden');
    }
    if (doc) doc.getElementById('desktop').classList.add('desktop-ready');
    kernel.host.audio.playBgm('lobby');
    if (firstRun) {
      kernel.host.notify('欢迎使用 phigrOS', '这是为音游调校的系统。打开「Phigros」开始游玩。', {
        icon: '🎵',
        timeout: 6000
      });
    }
    return kernel;
  };

  kernel.reboot = function reboot() {
    if (kernel.document && kernel.document.defaultView) kernel.document.defaultView.location.reload();
  };

  kernel.destroyApp = function destroyApp(windowId) {
    if (kernel.wm) kernel.wm.close(windowId);
  };

  return kernel;
}

/** manifest 允许 default 为数组或返回数组的 Promise */
async function resolveManifest(manifest) {
  if (typeof manifest === 'function') return await manifest();
  return Array.isArray(manifest) ? manifest : [];
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export default createKernel;
