/**
 * phigrOS —— 底部任务栏 + 时钟（js/shell/taskbar.js）
 *
 * 纯手写，无第三方依赖，ES Module。
 * 任务栏只调用 ctx.wm（窗口管理器），自身不实现任何窗口管理逻辑。
 *
 * 结构（全部落在 #taskbar 内）：
 *   <button class="tb-start ph-btn">⊞ 开始</button>
 *   <div class="tb-tasks"> <button class="tb-task">…</button> … </div>
 *   <div class="tb-tray"> 音量 / FPS(span.tb-fps) / 时钟(div.tb-clock) </div>
 *
 * 注意：ctx.host 是「稍后回填」的（内核先建任务栏，再建 host，最后写 taskbar.ctx.host），
 * 所以宿主对象一律通过 ctx.host 运行时读取，绝不在构造时缓存。
 *
 * 所有定时器都在 destroy() 里清理；所有 wm / state 订阅都保存取消函数。
 */

/** FPS 刷新间隔（毫秒） */
const FPS_MS = 500;
/** 时钟对齐刷新间隔（毫秒） */
const CLOCK_MS = 10000;

const WEEK_CN = ['日', '一', '二', '三', '四', '五', '六'];

function toNum(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clampNum(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function two(n) {
  return n < 10 ? '0' + n : String(n);
}

function msgOf(err) {
  if (err == null) return '未知错误';
  if (typeof err === 'string') return err;
  if (err && err.message) return String(err.message);
  return String(err);
}

/** 与 wm.js 里同样的小工具：优先 Host.el，失败时退回内置实现 */
function mkEl(host, tag, props, kids) {
  if (host && typeof host.el === 'function') {
    try {
      return host.el(tag, props || {}, ...(kids || []));
    } catch (err) {
      /* 降级 */
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

/**
 * 找到 #taskbar 容器。
 * 优先 ctx.taskbar，其次按 id 查找（宿主可能还没回填），最后才退回 ctx.root。
 * @param {object} ctx @param {object} host
 */
function resolveRoot(ctx, host) {
  if (ctx && ctx.taskbar && typeof ctx.taskbar.appendChild === 'function') return ctx.taskbar;
  let el = null;
  if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    try {
      el = document.getElementById('taskbar');
    } catch (err) {
      el = null;
    }
  }
  if (!el) {
    try {
      if (host && typeof host.$ === 'function') el = host.$('#taskbar');
    } catch (err) {
      el = null;
    }
  }
  if (!el && ctx && ctx.root && typeof ctx.root.appendChild === 'function') el = ctx.root;
  if (!el && typeof document !== 'undefined' && document.body) {
    // 兜底：宿主没有提供 #taskbar 时自建一个，保证任务栏仍然可用
    try {
      el = document.createElement('div');
      el.id = 'taskbar';
      el.className = 'taskbar';
      document.body.appendChild(el);
    } catch (err) {
      el = null;
    }
  }
  return el;
}

/**
 * 创建任务栏。
 * @param {{root:HTMLElement,state:object,host:object,kernel:object,wm:object,startMenu?:object,taskbar?:HTMLElement}} ctx
 * @returns {{render:Function,destroy:Function,setClock:Function,startMenu:object}}
 */
export function createTaskbar(ctx) {
  const tbCtx = ctx || {};
  const state = tbCtx.state;
  const wm = tbCtx.wm;
  let destroyed = false;
  const unsubscribe = [];
  let fpsRaf = 0;
  let fpsTimer = 0;
  let fpsFrames = 0;
  let clockTimer = 0;
  let renderPending = false;
  let menuObserver = null;

  function H() {
    return (tbCtx && tbCtx.host) || {};
  }

  function mk(tag, props, kids) {
    return mkEl(H(), tag, props, kids);
  }

  const root = resolveRoot(tbCtx, H());

  /* ---------------- 宿主辅助 ---------------- */

  function notify(title, body, level) {
    try {
      const h = H();
      if (typeof h.notify === 'function') h.notify(title, String(body == null ? '' : body), { level: level || 'info' });
    } catch (err) {
      /* 忽略 */
    }
  }

  function sfx(name) {
    try {
      const audio = H().audio;
      if (!audio || typeof audio.sfx !== 'function') return;
      let enabled = true;
      if (state && typeof state.get === 'function') {
        const s = state.get().settings;
        if (s && s.sfx === false) enabled = false;
      }
      if (enabled) audio.sfx(name);
    } catch (err) {
      /* 忽略 */
    }
  }

  function settings() {
    try {
      return (state && typeof state.get === 'function' && state.get().settings) || {};
    } catch (err) {
      return {};
    }
  }

  /* ---------------- DOM ---------------- */

  const startBtn = mk('button', { className: 'tb-start ph-btn', type: 'button', title: '开始菜单', textContent: '⊞ 开始' });
  const tasksEl = mk('div', { className: 'tb-tasks' });
  const volBtn = mk('button', { className: 'tb-vol tb-tray-btn', type: 'button', title: '主音量' });
  const fpsEl = mk('span', { className: 'tb-fps' });
  const clockEl = mk('div', { className: 'tb-clock' });
  const trayEl = mk('div', { className: 'tb-tray' }, [volBtn, fpsEl, clockEl]);

  if (!root) {
    // 没有容器时不抛错，只返回空壳，避免拖垮内核启动
    return {
      ctx: tbCtx,
      render: function () {},
      destroy: function () {},
      setClock: function () {},
      startMenu: { toggle: function () {}, open: function () {}, close: function () {}, isOpen: function () { return false; } },
    };
  }

  root.replaceChildren(startBtn, tasksEl, trayEl);

  /* ---------------- 开始菜单代理 ---------------- */

  function resolveStartMenu() {
    const candidates = [tbCtx.startMenu || null, H().startMenu || null];
    for (const c of candidates) {
      if (c && c !== taskbar.startMenu && typeof c.toggle === 'function') return c;
    }
    return null;
  }

  /** 让开始按钮的 .on 跟随开始菜单真实的开关状态 */
  function syncStartButton() {
    if (!startBtn || !startBtn.classList) return;
    let open = false;
    const menu = resolveStartMenu();
    if (menu && typeof menu.isOpen === 'function') {
      try {
        open = !!menu.isOpen();
      } catch (err) {
        open = false;
      }
    } else if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
      try {
        const el = document.getElementById('start-menu');
        open = Boolean(el && el.classList && el.classList.contains('open'));
      } catch (err) {
        open = false;
      }
    }
    startBtn.classList.toggle('on', open);
  }

  function startToggle() {
    sfx('click');
    const menu = resolveStartMenu();
    if (menu) {
      try {
        menu.toggle();
      } catch (err) {
        notify('开始菜单异常', msgOf(err), 'warn');
      }
    }
    syncStartButton();
  }

  function startOpen() {
    const menu = resolveStartMenu();
    if (menu && typeof menu.open === 'function') {
      try {
        menu.open();
      } catch (err) {
        notify('开始菜单异常', msgOf(err), 'warn');
      }
    }
    syncStartButton();
  }

  function startClose() {
    const menu = resolveStartMenu();
    if (menu && typeof menu.close === 'function') {
      try {
        menu.close();
      } catch (err) {
        notify('开始菜单异常', msgOf(err), 'warn');
      }
    }
    syncStartButton();
  }

  function startIsOpen() {
    const menu = resolveStartMenu();
    if (menu && typeof menu.isOpen === 'function') {
      try {
        return !!menu.isOpen();
      } catch (err) {
        return false;
      }
    }
    if (typeof document !== 'undefined' && typeof document.getElementById === 'function') {
      try {
        const el = document.getElementById('start-menu');
        return Boolean(el && el.classList && el.classList.contains('open'));
      } catch (err) {
        return false;
      }
    }
    return false;
  }

  const startMenu = { toggle: startToggle, open: startOpen, close: startClose, isOpen: startIsOpen };

  // 提前声明，供 resolveStartMenu 做自我引用保护（避免宿主把我们的代理再指回来造成递归）
  const taskbar = {
    ctx: tbCtx,
    render: render,
    destroy: destroy,
    setClock: setClock,
    startMenu: startMenu,
  };

  startBtn.addEventListener('click', startToggle);

  // 开始菜单可能被合成器（点空白处）关闭，用 MutationObserver 保持按钮高亮同步
  if (typeof MutationObserver === 'function' && typeof document !== 'undefined' && typeof document.getElementById === 'function') {
    try {
      const menuEl = document.getElementById('start-menu');
      if (menuEl) {
        menuObserver = new MutationObserver(function () {
          syncStartButton();
        });
        menuObserver.observe(menuEl, { attributes: true, attributeFilter: ['class'] });
      }
    } catch (err) {
      menuObserver = null;
    }
  }

  /* ---------------- 任务列表 ---------------- */

  function windowIcon(appId) {
    try {
      const h = H();
      if (typeof h.appMeta === 'function') {
        const meta = h.appMeta(appId);
        if (meta && meta.icon) return String(meta.icon);
      }
    } catch (err) {
      /* 忽略 */
    }
    return '▫';
  }

  function render() {
    if (destroyed || !tasksEl || !wm || typeof wm.list !== 'function') return;
    const focusedId = typeof wm.focused === 'function' ? wm.focused() : null;
    const frag = document.createDocumentFragment();
    let items = [];
    try {
      const raw = wm.list();
      items = Array.isArray(raw) ? raw : [];
    } catch (err) {
      items = [];
    }
    for (let i = 0; i < items.length; i += 1) {
      const w = items[i] || {};
      const label = String(w.title == null ? w.appId : w.title);
      const btn = mk('button', {
        className: 'tb-task' + (w.id === focusedId ? ' on' : '') + (w.min ? ' min' : ''),
        type: 'button',
        title: label,
        dataset: { windowId: String(w.id), appId: String(w.appId), index: String(i) },
      });
      btn.append(mk('span', { className: 'tb-task-icon', textContent: windowIcon(w.appId) }), mk('span', { className: 'tb-task-name', textContent: label }));
      const winId = w.id;
      btn.addEventListener('click', function () {
        sfx('click');
        if (!wm) return;
        try {
          if (typeof wm.focused === 'function' && wm.focused() === winId) wm.minimize(winId);
          else wm.focus(winId);
        } catch (err) {
          notify('窗口操作失败', msgOf(err), 'warn');
        }
      });
      frag.appendChild(btn);
    }
    tasksEl.replaceChildren(frag);
  }

  /** 用 rAF 合并高频事件（拖动缩放期间不会反复重建任务按钮） */
  function scheduleRender() {
    if (destroyed) return;
    if (renderPending) return;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : null;
    if (raf) {
      renderPending = true;
      raf(function () {
        renderPending = false;
        render();
      });
    } else {
      render();
    }
  }

  /* ---------------- 托盘：音量 ---------------- */

  function currentVolume() {
    try {
      const audio = H().audio;
      if (audio && typeof audio.volume === 'function') {
        const v = Number(audio.volume());
        if (Number.isFinite(v)) return clampNum(v, 0, 1);
      }
    } catch (err) {
      /* 退回 state */
    }
    return clampNum(toNum(settings().volume, 0.8), 0, 1);
  }

  function renderVolume() {
    if (!volBtn) return;
    volBtn.textContent = '🔊 ' + Math.round(currentVolume() * 100) + '%';
  }

  async function onVolumeClick() {
    sfx('click');
    const before = currentVolume();
    const dlg = H().dialog;
    if (typeof dlg !== 'function') return;
    let answer = null;
    try {
      answer = await dlg({
        title: '主音量',
        body: '调整系统主音量（0 - 100）',
        input: { label: '主音量 0-100', value: String(Math.round(before * 100)) },
      });
    } catch (err) {
      notify('无法打开音量对话框', msgOf(err), 'warn');
      return;
    }
    if (answer == null || answer === '') return;
    const pct = Number(String(answer).trim());
    if (!Number.isFinite(pct)) {
      notify('音量设置失败', '请输入 0 - 100 之间的数字', 'warn');
      return;
    }
    const v = clampNum(pct, 0, 100) / 100;
    try {
      const audio = H().audio;
      if (audio && typeof audio.setVolume === 'function') audio.setVolume(v);
      if (state && typeof state.set === 'function') {
        state.set('settings.volume', v);
        if (typeof state.save === 'function') state.save();
      }
    } catch (err) {
      notify('音量设置失败', msgOf(err), 'warn');
    }
    renderVolume();
  }

  volBtn.addEventListener('click', onVolumeClick);

  /* ---------------- 托盘：FPS ---------------- */

  function fpsTick() {
    const fps = Math.round(fpsFrames * (1000 / FPS_MS));
    fpsFrames = 0;
    if (fpsEl) fpsEl.textContent = fps + ' FPS';
  }

  function fpsLoop() {
    fpsFrames += 1;
    fpsRaf = requestAnimationFrame(fpsLoop);
  }

  function startFps() {
    if (destroyed || fpsTimer) return;
    if (typeof requestAnimationFrame === 'function') fpsRaf = requestAnimationFrame(fpsLoop);
    fpsTimer = setInterval(fpsTick, FPS_MS);
  }

  function stopFps() {
    if (fpsTimer) {
      clearInterval(fpsTimer);
      fpsTimer = 0;
    }
    if (fpsRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(fpsRaf);
    fpsRaf = 0;
    fpsFrames = 0;
    if (fpsEl) fpsEl.textContent = '';
  }

  function syncFps() {
    const on = !!settings().showFps;
    if (!fpsEl) return;
    if (on) {
      fpsEl.classList.add('on');
      startFps();
    } else {
      fpsEl.classList.remove('on');
      stopFps();
    }
  }

  /* ---------------- 时钟 ---------------- */

  function setClock() {
    if (!clockEl) return;
    const d = new Date();
    clockEl.textContent = two(d.getHours()) + ':' + two(d.getMinutes());
    clockEl.title =
      d.getFullYear() + '年' + (d.getMonth() + 1) + '月' + d.getDate() + '日 星期' + WEEK_CN[d.getDay()] +
      ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }

  /** 对齐到 10 秒边界刷新（不累计漂移） */
  function scheduleClock() {
    if (destroyed) return;
    if (clockTimer) clearTimeout(clockTimer);
    setClock();
    const delay = CLOCK_MS - (Date.now() % CLOCK_MS) + 20;
    clockTimer = setTimeout(scheduleClock, delay);
  }

  /* ---------------- 订阅 ---------------- */

  if (wm && typeof wm.on === 'function') {
    const events = ['open', 'close', 'focus', 'minimize', 'restore', 'resize'];
    for (const evt of events) {
      try {
        const off = wm.on(evt, function () {
          scheduleRender();
        });
        if (typeof off === 'function') unsubscribe.push(off);
      } catch (err) {
        /* 忽略单个事件订阅失败 */
      }
    }
  }

  if (state && typeof state.subscribe === 'function') {
    try {
      const offVol = state.subscribe('settings.volume', function () {
        renderVolume();
      });
      if (typeof offVol === 'function') unsubscribe.push(offVol);
    } catch (err) {
      /* 忽略 */
    }
    try {
      const offFps = state.subscribe('settings.showFps', function () {
        syncFps();
      });
      if (typeof offFps === 'function') unsubscribe.push(offFps);
    } catch (err) {
      /* 忽略 */
    }
  }

  /* ---------------- 首帧 ---------------- */

  render();
  renderVolume();
  syncFps();
  scheduleClock();
  syncStartButton();

  /* ---------------- 销毁 ---------------- */

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    for (const off of unsubscribe.splice(0, unsubscribe.length)) {
      try {
        off();
      } catch (err) {
        /* 忽略 */
      }
    }
    if (menuObserver) {
      try {
        menuObserver.disconnect();
      } catch (err) {
        /* 忽略 */
      }
      menuObserver = null;
    }
    if (fpsTimer) {
      clearInterval(fpsTimer);
      fpsTimer = 0;
    }
    if (fpsRaf && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(fpsRaf);
    fpsRaf = 0;
    if (clockTimer) {
      clearTimeout(clockTimer);
      clockTimer = 0;
    }
    try {
      if (root) root.replaceChildren();
    } catch (err) {
      /* 忽略 */
    }
  }

  return taskbar;
}