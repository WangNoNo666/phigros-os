/**
 * phigrOS —— 窗口管理器（js/shell/wm.js）
 *
 * 纯手写，无第三方依赖，ES Module；不 import 内核任何模块（避免循环依赖），
 * 内核对象由 ctx.kernel 在运行时注入。
 *
 * 对外导出：
 *   createWindowManager(ctx)     -> windowManager 对象
 *   clampWindow / placeNewWindow -> 纯函数（不触碰 DOM，供 node 自测使用）
 *
 * 注意：launch() / toggleApp() / restoreAll() 是 async 函数。
 * 因为必须先等应用模块加载成功之后才创建窗口，
 * 所以它们的返回值是 Promise<windowId|null>；调用方可以 await，也可以忽略返回值。
 *
 * 注意：ctx.host 是「稍后回填」的（内核先建 wm，再建 host，最后写 wm.ctx.host），
 * 所以宿主对象一律通过 ctx.host 运行时读取，绝不在构造时缓存。
 *
 * 内联样式只用于几何（left/top/width/height/z-index）与 CSS 变量 --accent；
 * 颜色一律交给 styles/shell.css 里的 CSS 变量。
 */

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 窗口最小尺寸 */
export const MIN_W = 320;
export const MIN_H = 220;
/** 新窗口阶梯偏移（每个窗口 +28, +24） */
export const CASCADE_X = 28;
export const CASCADE_Y = 24;
/** 标题栏高度估计值（纯函数用它算垂直边界） */
export const TITLEBAR_H = 34;
/** 拖动时至少保留可见的标题栏宽度 */
export const TITLEBAR_VISIBLE = 80;

/** 合法事件名 */
const EVENTS = ['open', 'close', 'focus', 'minimize', 'restore', 'resize'];

/* ------------------------------------------------------------------ *
 * 小工具（纯函数）
 * ------------------------------------------------------------------ */

function toNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function msgOf(err) {
  if (err == null) return '未知错误';
  if (typeof err === 'string') return err;
  if (err && err.message) return String(err.message);
  return String(err);
}

/* ------------------------------------------------------------------ *
 * 纯函数：窗口几何
 * ------------------------------------------------------------------ */

/**
 * 把窗口矩形夹进视口约束（不触碰 DOM，可 node 自测）。
 * - 尺寸不小于 MIN_W x MIN_H，也不大于视口
 * - 水平方向至少保留 TITLEBAR_VISIBLE 宽度的标题栏可见
 * - 垂直方向标题栏必须完整可见（y 落在 [0, vh - TITLEBAR_H]）
 * @param {number} x @param {number} y @param {number} w @param {number} h
 * @param {{w:number,h:number}} viewport
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function clampWindow(x, y, w, h, viewport) {
  const vp = viewport || {};
  const vw = Math.max(1, Math.round(toNum(vp.w, 1280)));
  const vh = Math.max(1, Math.round(toNum(vp.h, 720)));

  const width = Math.round(clampNum(toNum(w, 720), MIN_W, Math.max(MIN_W, vw)));
  const height = Math.round(clampNum(toNum(h, 480), MIN_H, Math.max(MIN_H, vh)));

  const minX = TITLEBAR_VISIBLE - width;
  const maxX = vw - TITLEBAR_VISIBLE;
  const maxY = Math.max(0, vh - TITLEBAR_H);

  return {
    x: Math.round(clampNum(toNum(x, 0), minX, maxX)),
    y: Math.round(clampNum(toNum(y, 0), 0, maxY)),
    w: width,
    h: height,
  };
}

/**
 * 为新窗口选择一个位置与尺寸（不触碰 DOM，可 node 自测）。
 * 以「当前窗口数量」为阶梯序号，每个新窗口 +28 / +24；超出可用空间后从头循环。
 * @param {Array<object>} windows 已有窗口（state.windows）
 * @param {number} w 期望宽度 @param {number} h 期望高度
 * @param {{w:number,h:number}} viewport
 * @returns {{x:number,y:number,w:number,h:number}}
 */
export function placeNewWindow(windows, w, h, viewport) {
  const vp = viewport || {};
  const vw = Math.max(1, Math.round(toNum(vp.w, 1280)));
  const vh = Math.max(1, Math.round(toNum(vp.h, 720)));
  const list = Array.isArray(windows) ? windows : [];
  const margin = 16;

  const width = Math.round(clampNum(toNum(w, 720), MIN_W, Math.max(MIN_W, vw - margin * 2)));
  const height = Math.round(clampNum(toNum(h, 480), MIN_H, Math.max(MIN_H, vh - margin * 2)));

  const maxStepX = Math.max(0, Math.floor((vw - width - margin) / CASCADE_X));
  const maxStepY = Math.max(0, Math.floor((vh - height - margin) / CASCADE_Y));
  const maxStep = Math.max(1, Math.min(maxStepX, maxStepY));
  const span = maxStep + 1;
  const k = ((list.length % span) + span) % span;

  return clampWindow(margin + k * CASCADE_X, margin + k * CASCADE_Y, width, height, { w: vw, h: vh });
}

/* ------------------------------------------------------------------ *
 * DOM 辅助
 * ------------------------------------------------------------------ */

/**
 * 优先使用 Host.el（契约保证可用）；若它抛错则退回到内置实现，
 * 保证窗口管理器不会因为宿主实现的小问题整体失效。
 */
function mkEl(host, tag, props, kids) {
  if (host && typeof host.el === 'function') {
    try {
      return host.el(tag, props || {}, ...(kids || []));
    } catch (err) {
      /* 降级到内置实现 */
    }
  }
  return plainEl(tag, props || {}, kids || []);
}

function plainEl(tag, props, kids) {
  const e = document.createElement(tag);
  for (const key of Object.keys(props)) applyProp(e, key, props[key]);
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) {
      for (const k2 of kid) {
        if (k2 == null || k2 === false) continue;
        e.append(typeof k2 === 'string' ? document.createTextNode(k2) : k2);
      }
    } else {
      e.append(typeof kid === 'string' ? document.createTextNode(kid) : kid);
    }
  }
  return e;
}

function applyProp(e, key, value) {
  if (key === 'className' || key === 'class') e.className = String(value);
  else if (key === 'textContent') e.textContent = String(value);
  else if (key === 'style') {
    if (value && typeof value === 'object') {
      for (const s of Object.keys(value)) e.style[s] = value[s];
    } else {
      e.style.cssText = String(value);
    }
  } else if (key === 'dataset') {
    for (const d of Object.keys(value)) e.dataset[d] = String(value[d]);
  } else if (/^on[a-z]+$/.test(key)) {
    e.addEventListener(key.slice(2).toLowerCase(), value);
  } else if (value === true) {
    e.setAttribute(key, '');
  } else if (value !== false && value != null) {
    e.setAttribute(key, String(value));
  }
}

/* ------------------------------------------------------------------ *
 * 窗口管理器
 * ------------------------------------------------------------------ */

/**
 * 创建窗口管理器。
 * @param {{root:HTMLElement,state:object,host:object,kernel:object}} ctx
 */
export function createWindowManager(ctx) {
  if (!ctx || !ctx.root) throw new Error('createWindowManager: 缺少 ctx.root');
  const root = ctx.root;
  const state = ctx.state;
  const kernel = ctx.kernel || {};

  /** 宿主对象稍后回填，必须运行时读 ctx.host */
  const wmCtx = ctx;

  /** @type {Map<string, object>} 活动窗口：id -> 内部记录 */
  const wins = new Map();
  /** @type {Map<string, Set<Function>>} 事件名 -> 监听器 */
  const listeners = new Map();
  /** 构造时从 state.windows 取出的历史窗口，仅供 restoreAll() 使用 */
  const pendingRestore = [];

  let focusedId = null;
  let seq = 0;
  let viewportRaf = 0;

  function hostRef() {
    return (wmCtx && wmCtx.host) || {};
  }

  /** 创建元素：宿主已回填则走 Host.el，否则走内置降级实现 */
  function mk(tag, props, kids) {
    return mkEl(hostRef(), tag, props, kids);
  }

  /* ---------------- 状态同步 ---------------- */

  function list() {
    const out = [];
    for (const rec of wins.values()) {
      out.push({
        id: rec.id,
        appId: rec.appId,
        title: rec.title,
        x: rec.x,
        y: rec.y,
        w: rec.w,
        h: rec.h,
        z: rec.z,
        min: rec.min,
      });
    }
    return out;
  }

  /** state.windows 永远以真实窗口为准 */
  function syncState(options) {
    const save = !options || options.save !== false;
    if (!state || typeof state.set !== 'function') return;
    try {
      state.set('windows', list());
      if (save && typeof state.save === 'function') state.save();
    } catch (err) {
      /* 状态写入失败不应中断窗口操作 */
    }
  }

  function nextZ() {
    let base = 10;
    try {
      base = Math.round(toNum(state.get().zTop, 10));
    } catch (err) {
      base = 10;
    }
    let top = 0;
    for (const rec of wins.values()) top = Math.max(top, rec.z);
    const z = Math.max(11, base + 1, top + 1);
    try {
      state.set('zTop', z);
    } catch (err) {
      /* 忽略 */
    }
    return z;
  }

  function maxZ() {
    let top = 0;
    for (const rec of wins.values()) top = Math.max(top, rec.z);
    return top;
  }

  /* ---------------- 事件 ---------------- */

  function on(evt, cb) {
    if (typeof cb !== 'function' || EVENTS.indexOf(evt) < 0) return () => {};
    let set = listeners.get(evt);
    if (!set) {
      set = new Set();
      listeners.set(evt, set);
    }
    set.add(cb);
    return () => {
      set.delete(cb);
    };
  }

  function emit(evt, payload) {
    const set = listeners.get(evt);
    if (!set || set.size === 0) return;
    for (const cb of Array.from(set)) {
      try {
        cb(payload);
      } catch (err) {
        if (typeof console !== 'undefined' && console.warn) console.warn('[wm] 事件监听器异常：' + evt, err);
      }
    }
  }

  /* ---------------- 宿主辅助 ---------------- */

  function notify(title, body, level) {
    try {
      const h = hostRef();
      if (h && typeof h.notify === 'function') {
        h.notify(title, String(body == null ? '' : body), { level: level || 'info' });
      }
    } catch (err) {
      /* 通知失败不影响窗口 */
    }
  }

  /** 系统音效（可选链保护；设置里关掉 sfx 则不响） */
  function sfx(name) {
    try {
      const audio = hostRef().audio;
      if (!audio || typeof audio.sfx !== 'function') return;
      let enabled = true;
      if (state && typeof state.get === 'function') {
        const s = state.get().settings;
        if (s && s.sfx === false) enabled = false;
      }
      if (enabled) audio.sfx(name);
    } catch (err) {
      /* 音效失败不影响窗口 */
    }
  }

  /** 调用应用 handle 上的可选回调，异常只通知不抛出 */
  function safeHandle(rec, name) {
    const args = Array.prototype.slice.call(arguments, 2);
    const handle = rec && rec.handle;
    if (!handle || typeof handle[name] !== 'function') return;
    try {
      handle[name].apply(handle, args);
    } catch (err) {
      notify('应用回调异常', name + '：' + msgOf(err), 'warn');
    }
  }

  function destroyHandle(handle) {
    if (!handle || typeof handle.destroy !== 'function') return;
    try {
      handle.destroy();
    } catch (err) {
      notify('应用清理失败', msgOf(err), 'warn');
    }
  }

  function getViewport() {
    let w = toNum(root.clientWidth, 0);
    let h = toNum(root.clientHeight, 0);
    if ((!w || !h) && typeof window !== 'undefined') {
      w = w || toNum(window.innerWidth, 0);
      h = h || toNum(window.innerHeight, 0);
    }
    return { w: Math.max(MIN_W, Math.round(w || 1280)), h: Math.max(MIN_H, Math.round(h || 720)) };
  }

  function newId() {
    const h = hostRef();
    if (h && typeof h.randomId === 'function') {
      try {
        const id = h.randomId('win');
        if (id) return String(id);
      } catch (err) {
        /* 用本地生成 */
      }
    }
    seq += 1;
    return 'win-' + Date.now().toString(36) + '-' + seq.toString(36);
  }

  function lookupModule(appId) {
    const apps = kernel && kernel.apps;
    if (!apps) return null;
    if (typeof apps.get === 'function') return apps.get(appId) || null;
    if (typeof apps === 'object') return apps[appId] || null;
    return null;
  }

  function findWindowByApp(appId) {
    let found = null;
    for (const rec of wins.values()) {
      if (rec.appId === appId && (!found || rec.z > found.z)) found = rec;
    }
    return found;
  }

  function topVisibleWindow(excludeId) {
    let best = null;
    for (const rec of wins.values()) {
      if (rec.min) continue;
      if (excludeId && rec.id === excludeId) continue;
      if (!best || rec.z > best.z) best = rec;
    }
    return best;
  }

  function openFileOn(rec, file) {
    if (file == null || file === '') return;
    safeHandle(rec, 'onOpen', file);
  }

  /**
   * 取得可直接 mount 的应用模块。
   * 兼容两种情况：
   *  1. 内核 loadApp 直接返回含 mount 的完整模块；
   *  2. 内核返回的是「惰性清单项」（只有 loader、没有 mount）——
   *     此时由本层触发 loader 并回登记到内核，避免整个应用不可用。
   */
  async function resolveModule(appId) {
    let mod = lookupModule(appId);
    if (mod && typeof mod.mount === 'function') return { ok: true, mod: mod };

    if (typeof kernel.loadApp === 'function') {
      let loaded = null;
      try {
        loaded = await kernel.loadApp(appId);
      } catch (err) {
        notify('应用启动失败', msgOf(err), 'error');
        return { ok: false, mod: null };
      }
      if (loaded && typeof loaded.mount === 'function') return { ok: true, mod: loaded };
      if (loaded) mod = loaded;
    }

    if (mod && typeof mod.loader === 'function') {
      let loaded = null;
      try {
        loaded = await mod.loader();
      } catch (err) {
        notify('应用启动失败', msgOf(err), 'error');
        return { ok: false, mod: null };
      }
      if (loaded && typeof loaded.mount === 'function') {
        try {
          if (typeof kernel.registerApp === 'function') kernel.registerApp(loaded);
        } catch (err) {
          /* 回登记失败不影响启动 */
        }
        return { ok: true, mod: loaded };
      }
      notify('应用启动失败', '应用模块无效：' + appId, 'error');
      return { ok: false, mod: null };
    }

    if (!mod) {
      notify('应用启动失败', '未找到应用：' + appId, 'error');
      return { ok: false, mod: null };
    }
    notify('应用启动失败', '应用模块缺少 mount：' + appId, 'error');
    return { ok: false, mod: null };
  }

  /* ---------------- 窗口 DOM ---------------- */

  function applyRect(rec) {
    const s = rec.el.style;
    s.left = rec.x + 'px';
    s.top = rec.y + 'px';
    s.width = rec.w + 'px';
    s.height = rec.h + 'px';
    s.zIndex = String(rec.z);
  }

  function buildWindowDom(rec) {
    const el = mk('div', {
      className: 'win',
      dataset: { winId: rec.id, appId: rec.appId },
    });

    const bar = mk('div', { className: 'win-titlebar' });
    const icon = mk('span', { className: 'win-icon', textContent: rec.icon });
    const title = mk('span', { className: 'win-title', textContent: rec.title });
    const actions = mk('span', { className: 'win-actions' });

    const btnMin = mk('button', { className: 'win-btn min', type: 'button', title: '最小化', textContent: '−' });
    const btnMax = mk('button', { className: 'win-btn max', type: 'button', title: '最大化', textContent: '▢' });
    const btnClose = mk('button', { className: 'win-btn close', type: 'button', title: '关闭', textContent: '✕' });
    actions.append(btnMin, btnMax, btnClose);
    bar.append(icon, title, actions);

    const body = mk('div', { className: 'win-body' });
    const grip = mk('div', { className: 'win-resize', title: '拖动调整窗口大小' });

    el.append(bar, body, grip);
    rec.el = el;
    rec.bodyEl = body;
    rec.titleEl = title;
    rec.iconEl = icon;

    // 应用强调色：只写 CSS 变量，不写死颜色
    const accent = rec.module && rec.module.accent;
    if (typeof accent === 'string' && accent.length < 40 && /^[#a-zA-Z0-9(),.%\s-]+$/.test(accent)) {
      try {
        el.style.setProperty('--accent', accent);
        el.style.setProperty('--win-accent', accent);
      } catch (err) {
        /* 忽略非法颜色值 */
      }
    }

    // 点击窗口任意位置 -> 聚焦（捕获阶段，避免被应用内部的 stopPropagation 挡住）
    el.addEventListener(
      'pointerdown',
      function () {
        if (focusedId !== rec.id) focus(rec.id);
      },
      true
    );

    btnMin.addEventListener('click', function (e) {
      e.stopPropagation();
      minimize(rec.id);
    });
    btnMax.addEventListener('click', function (e) {
      e.stopPropagation();
      toggleMaximize(rec.id);
    });
    btnClose.addEventListener('click', function (e) {
      e.stopPropagation();
      close(rec.id);
    });

    bar.addEventListener('pointerdown', function (e) {
      startDrag(rec, bar, e);
    });
    bar.addEventListener('dblclick', function () {
      toggleMaximize(rec.id);
    });
    grip.addEventListener('pointerdown', function (e) {
      startResize(rec, grip, e);
    });
  }

  /** 尝试设置指针捕获；失败则退回到 window 级监听，保证拖出元素后仍能跟随 */
  function captureOn(el, pointerId) {
    try {
      if (typeof el.setPointerCapture === 'function' && pointerId != null) {
        el.setPointerCapture(pointerId);
        return el;
      }
    } catch (err) {
      /* 退回到 window 级监听 */
    }
    return typeof window !== 'undefined' && window.addEventListener ? window : el;
  }

  function releaseCapture(el, pointerId) {
    try {
      if (typeof el.releasePointerCapture === 'function' && pointerId != null) el.releasePointerCapture(pointerId);
    } catch (err) {
      /* 已经释放 */
    }
  }

  function startDrag(rec, bar, e) {
    if (e.button !== undefined && e.button !== 0) return;
    if (e.target && typeof e.target.closest === 'function' && e.target.closest('.win-btn')) return;
    focus(rec.id);
    if (typeof e.preventDefault === 'function') e.preventDefault();

    // 最大化状态下拖动：先还原，再按指针比例接住窗口
    if (rec.maximized) {
      const ratio = clampNum((e.clientX - rec.x) / Math.max(1, rec.w), 0, 1);
      unmaximize(rec);
      rec.x = Math.round(e.clientX - ratio * rec.w);
      rec.y = Math.round(e.clientY - TITLEBAR_H / 2);
      applyRect(rec);
    }

    const startX = toNum(e.clientX, 0);
    const startY = toNum(e.clientY, 0);
    const originX = rec.x;
    const originY = rec.y;
    const pointerId = e.pointerId;
    const track = captureOn(bar, pointerId);

    function onMove(ev) {
      const vp = getViewport();
      const next = clampWindow(originX + (toNum(ev.clientX, 0) - startX), originY + (toNum(ev.clientY, 0) - startY), rec.w, rec.h, vp);
      rec.x = next.x;
      rec.y = next.y;
      applyRect(rec);
      syncState({ save: false });
    }

    function onUp() {
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup', onUp);
      track.removeEventListener('pointercancel', onUp);
      releaseCapture(bar, pointerId);
      syncState({ save: true });
    }

    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onUp);
    track.addEventListener('pointercancel', onUp);
  }

  function startResize(rec, grip, e) {
    if (e.button !== undefined && e.button !== 0) return;
    focus(rec.id);
    if (typeof e.preventDefault === 'function') e.preventDefault();
    if (rec.maximized) unmaximize(rec);

    const startX = toNum(e.clientX, 0);
    const startY = toNum(e.clientY, 0);
    const originW = rec.w;
    const originH = rec.h;
    const pointerId = e.pointerId;
    const track = captureOn(grip, pointerId);

    function onMove(ev) {
      const vp = getViewport();
      const next = clampWindow(rec.x, rec.y, originW + (toNum(ev.clientX, 0) - startX), originH + (toNum(ev.clientY, 0) - startY), vp);
      rec.w = next.w;
      rec.h = next.h;
      applyRect(rec);
      safeHandle(rec, 'onResize', rec.w, rec.h);
      syncState({ save: false });
    }

    function onUp() {
      track.removeEventListener('pointermove', onMove);
      track.removeEventListener('pointerup', onUp);
      track.removeEventListener('pointercancel', onUp);
      releaseCapture(grip, pointerId);
      syncState({ save: true });
      emit('resize', { windowId: rec.id, appId: rec.appId, w: rec.w, h: rec.h });
    }

    track.addEventListener('pointermove', onMove);
    track.addEventListener('pointerup', onUp);
    track.addEventListener('pointercancel', onUp);
  }

  /* ---------------- 窗口操作 ---------------- */

  function unminimize(rec) {
    if (!rec.min) return false;
    rec.min = false;
    rec.el.classList.remove('minimized');
    rec.el.style.display = '';
    emit('restore', { windowId: rec.id, appId: rec.appId });
    return true;
  }

  function focus(windowId) {
    const rec = wins.get(windowId);
    if (!rec) return null;
    const wasFocused = focusedId === windowId && !rec.min;
    unminimize(rec);
    if (rec.z !== maxZ()) {
      rec.z = nextZ();
      applyRect(rec);
    }
    const prevId = focusedId;
    focusedId = windowId;
    for (const w of wins.values()) {
      if (w.el && w.el.classList) w.el.classList.toggle('focused', w.id === windowId);
    }
    if (prevId && prevId !== windowId) {
      const prev = wins.get(prevId);
      if (prev) safeHandle(prev, 'onBlur');
    }
    if (!wasFocused) {
      safeHandle(rec, 'onFocus');
      emit('focus', { windowId: rec.id, appId: rec.appId });
    }
    syncState({ save: true });
    return windowId;
  }

  function minimize(windowId) {
    const rec = wins.get(windowId);
    if (!rec || rec.min) return null;
    rec.min = true;
    rec.el.classList.add('minimized');
    // 样式表已有 .win.minimized { display: none }，这里再兜底一层，缺 CSS 时也能隐藏
    rec.el.style.display = 'none';
    const wasFocused = focusedId === windowId;
    if (wasFocused) {
      focusedId = null;
      if (rec.el.classList) rec.el.classList.remove('focused');
      safeHandle(rec, 'onBlur');
    }
    emit('minimize', { windowId: rec.id, appId: rec.appId });
    syncState({ save: true });
    if (wasFocused) {
      const top = topVisibleWindow();
      if (top) focus(top.id);
    }
    return windowId;
  }

  function restore(windowId) {
    const rec = wins.get(windowId);
    if (!rec) return null;
    unminimize(rec);
    syncState({ save: true });
    return windowId;
  }

  function close(windowId) {
    const rec = wins.get(windowId);
    if (!rec) return false;
    // 1. 先清理应用（异常只通知不抛出）
    destroyHandle(rec.handle);
    rec.handle = null;
    // 2. 移除 DOM
    try {
      if (rec.el && rec.el.parentNode) rec.el.parentNode.removeChild(rec.el);
    } catch (err) {
      /* 忽略 */
    }
    // 3. 从窗口表（同时就是 state.windows）删除
    wins.delete(windowId);
    const wasFocused = focusedId === windowId;
    if (wasFocused) focusedId = null;
    // 4. 事件 + 音效
    emit('close', { windowId: rec.id, appId: rec.appId });
    sfx('close');
    syncState({ save: true });
    if (wasFocused) {
      const top = topVisibleWindow();
      if (top) focus(top.id);
    }
    return true;
  }

  function unmaximize(rec) {
    if (!rec.maximized) return false;
    rec.maximized = false;
    if (rec.el && rec.el.classList) rec.el.classList.remove('maximized');
    if (rec.prev) {
      const prev = rec.prev;
      rec.prev = null;
      const c = clampWindow(prev.x, prev.y, prev.w, prev.h, getViewport());
      rec.x = c.x;
      rec.y = c.y;
      rec.w = c.w;
      rec.h = c.h;
    }
    applyRect(rec);
    safeHandle(rec, 'onResize', rec.w, rec.h);
    emit('resize', { windowId: rec.id, appId: rec.appId, w: rec.w, h: rec.h });
    syncState({ save: true });
    return true;
  }

  function maximize(windowId) {
    const rec = wins.get(windowId);
    if (!rec || rec.maximized) return null;
    const vp = getViewport();
    rec.prev = { x: rec.x, y: rec.y, w: rec.w, h: rec.h };
    rec.maximized = true;
    rec.x = 0;
    rec.y = 0;
    rec.w = vp.w;
    rec.h = vp.h;
    if (rec.el && rec.el.classList) rec.el.classList.add('maximized');
    applyRect(rec);
    safeHandle(rec, 'onResize', rec.w, rec.h);
    emit('resize', { windowId: rec.id, appId: rec.appId, w: rec.w, h: rec.h });
    syncState({ save: true });
    focus(windowId);
    return windowId;
  }

  function toggleMaximize(windowId) {
    const rec = wins.get(windowId);
    if (!rec) return null;
    return rec.maximized ? unmaximize(rec) : maximize(windowId);
  }

  /** 直接设置窗口几何（内核/界面可用；不改变 z 序） */
  function setGeometry(windowId, x, y, w, h) {
    const rec = wins.get(windowId);
    if (!rec) return null;
    const c = clampWindow(x, y, w, h, getViewport());
    rec.x = c.x;
    rec.y = c.y;
    rec.w = c.w;
    rec.h = c.h;
    if (rec.maximized) {
      rec.maximized = false;
      rec.prev = null;
      if (rec.el && rec.el.classList) rec.el.classList.remove('maximized');
    }
    applyRect(rec);
    safeHandle(rec, 'onResize', rec.w, rec.h);
    syncState({ save: true });
    return windowId;
  }

  function focused() {
    return focusedId && wins.has(focusedId) ? focusedId : null;
  }

  function destroyAll() {
    for (const id of Array.from(wins.keys())) {
      try {
        close(id);
      } catch (err) {
        notify('关闭窗口失败', msgOf(err), 'warn');
      }
    }
    wins.clear();
    focusedId = null;
    syncState({ save: true });
  }

  /* ---------------- 启动 / 切换 ---------------- */

  async function launch(appId, opts) {
    const options = opts && typeof opts === 'object' ? opts : {};
    if (typeof appId !== 'string' || !appId) {
      notify('应用启动失败', '缺少应用 ID', 'error');
      return null;
    }

    // 1. 已登记的单例应用：直接聚焦已有窗口（清单项也带 singleton 元信息）
    let mod = lookupModule(appId);
    if (mod && mod.singleton) {
      const existing = findWindowByApp(appId);
      if (existing) {
        openFileOn(existing, options.file);
        focus(existing.id);
        return existing.id;
      }
    }

    // 2. 取得可 mount 的应用模块（失败已通知）
    const resolved = await resolveModule(appId);
    if (!resolved.ok) return null;
    mod = resolved.mod;

    // 3. 模块加载完成后再次检查单例（并发启动时可能已有窗口）
    if (mod.singleton) {
      const existing = findWindowByApp(appId);
      if (existing) {
        openFileOn(existing, options.file);
        focus(existing.id);
        return existing.id;
      }
    }

    // 4. 创建窗口
    const rect = placeNewWindow(list(), toNum(options.width, toNum(mod.width, 720)), toNum(options.height, toNum(mod.height, 480)), getViewport());
    const rec = {
      id: newId(),
      appId: appId,
      title: String(options.title || mod.name || appId),
      icon: String(mod.icon || '▫'),
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      z: nextZ(),
      min: false,
      maximized: false,
      prev: null,
      el: null,
      bodyEl: null,
      handle: null,
      module: mod,
    };
    buildWindowDom(rec);
    root.appendChild(rec.el);
    wins.set(rec.id, rec);
    applyRect(rec);
    emit('open', { windowId: rec.id, appId: appId });
    sfx('open');
    syncState({ save: true });

    // 5. 挂载应用（mount 可以是 async）
    try {
      const handle = await mod.mount(rec.bodyEl, {
        windowId: rec.id,
        appId: appId,
        args: options.args === undefined ? null : options.args,
        file: options.file === undefined ? null : options.file,
      });
      // 挂载期间用户可能已经把窗口关掉了
      if (!wins.has(rec.id)) {
        destroyHandle(handle);
        return null;
      }
      rec.handle = handle && typeof handle === 'object' ? handle : null;
      safeHandle(rec, 'onResize', rec.w, rec.h);
      focus(rec.id);
      return rec.id;
    } catch (err) {
      if (wins.has(rec.id)) close(rec.id);
      notify('应用启动失败', msgOf(err), 'error');
      return null;
    }
  }

  async function toggleApp(appId) {
    const target = findWindowByApp(appId);
    if (!target) return launch(appId);
    if (target.min) return focus(target.id);
    if (focusedId === target.id) return minimize(target.id);
    return focus(target.id);
  }

  /** 会话恢复（可选）：把构造时读到的 state.windows 重新打开。默认不自动调用。 */
  async function restoreAll() {
    if (pendingRestore.length === 0) return [];
    const queue = pendingRestore.splice(0, pendingRestore.length);
    const ids = [];
    for (const saved of queue) {
      if (!saved || !saved.appId) continue;
      let id = null;
      try {
        id = await launch(saved.appId, { title: saved.title, width: saved.w, height: saved.h });
      } catch (err) {
        id = null;
      }
      if (!id) continue;
      const rec = wins.get(id);
      if (!rec) continue;
      const c = clampWindow(toNum(saved.x, rec.x), toNum(saved.y, rec.y), toNum(saved.w, rec.w), toNum(saved.h, rec.h), getViewport());
      rec.x = c.x;
      rec.y = c.y;
      rec.w = c.w;
      rec.h = c.h;
      if (rec.maximized) unmaximize(rec);
      applyRect(rec);
      safeHandle(rec, 'onResize', rec.w, rec.h);
      if (saved.min) minimize(id);
      ids.push(id);
    }
    syncState({ save: true });
    return ids;
  }

  function destroy() {
    if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
      window.removeEventListener('resize', onViewportResize);
    }
    if (viewportRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(viewportRaf);
    viewportRaf = 0;
    destroyAll();
    listeners.clear();
  }

  /* ---------------- 视口变化 ---------------- */

  function onViewportResize() {
    if (viewportRaf) return;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    const run = function () {
      viewportRaf = 0;
      const vp = getViewport();
      for (const rec of wins.values()) {
        if (rec.maximized) {
          rec.x = 0;
          rec.y = 0;
          rec.w = vp.w;
          rec.h = vp.h;
        } else {
          const c = clampWindow(rec.x, rec.y, rec.w, rec.h, vp);
          rec.x = c.x;
          rec.y = c.y;
          rec.w = c.w;
          rec.h = c.h;
        }
        applyRect(rec);
        safeHandle(rec, 'onResize', rec.w, rec.h);
        emit('resize', { windowId: rec.id, appId: rec.appId, w: rec.w, h: rec.h });
      }
      syncState({ save: true });
    };
    if (raf) viewportRaf = raf(run);
    else run();
  }

  /* ---------------- 初始化 ---------------- */

  // 记录持久化过的窗口（若内核调用 restoreAll 则恢复），随后 state.windows 以真实窗口为准
  try {
    const persisted = state && typeof state.get === 'function' ? state.get().windows : null;
    if (Array.isArray(persisted)) {
      for (const w of persisted) {
        if (w && w.appId) pendingRestore.push({ id: w.id, appId: w.appId, title: w.title, x: w.x, y: w.y, w: w.w, h: w.h, min: !!w.min });
      }
    }
  } catch (err) {
    /* 忽略损坏的持久化数据 */
  }
  syncState({ save: false });
  try {
    if (state && typeof state.set === 'function') {
      const cur = Math.round(toNum(state.get().zTop, 10));
      if (cur < 10) state.set('zTop', 10);
    }
  } catch (err) {
    /* 忽略 */
  }
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('resize', onViewportResize);
  }

  /* ---------------- 返回对象 ---------------- */

  const wm = {
    // 契约要求的方法
    launch: launch,
    close: close,
    focus: focus,
    minimize: minimize,
    restore: restore,
    list: list,
    focused: focused,
    on: on,
    toggleApp: toggleApp,
    destroyAll: destroyAll,
    // 内核需要回填 ctx.host，必须暴露同一个 ctx 对象
    ctx: wmCtx,
    // 额外方法（界面按钮 / 内核可用，不属于契约必需项）
    maximize: maximize,
    toggleMaximize: toggleMaximize,
    setGeometry: setGeometry,
    restoreAll: restoreAll,
    viewport: getViewport,
    destroy: destroy,
  };

  try {
    if (typeof window !== 'undefined') window.__PHIGROS_WM__ = wm;
  } catch (err) {
    /* 忽略 */
  }

  return wm;
}
