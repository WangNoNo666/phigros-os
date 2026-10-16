/**
 * phigrOS · js/core/host.js
 * 宿主 API 实现（window.Host）。契约：CONTRACT.md §4 + HOST-API.addendum.md
 * 注意：本模块不得 import kernel.js（会形成循环依赖），版本号由调用方传入。
 */

export function createHost({ state, kernel, audio, wm, document: doc, version = '1.0.0' }) {
  const VERSION = version;
  const win = doc && doc.defaultView ? doc.defaultView : (typeof window !== 'undefined' ? window : null);
  const fsSubs = new Set();
  let fsVersion = 0;
  let dialogDepth = 0;

  // ============ DOM ============
  const $ = (sel, root) => (root || doc).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || doc).querySelectorAll(sel));

  function el(tag, props = {}, ...children) {
    const node = doc.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'className' || k === 'class') {
        node.className = String(v);
      } else if (k === 'textContent') {
        node.textContent = String(v);
      } else if (k === 'innerHTML') {
        node.innerHTML = String(v);
      } else if (k === 'style') {
        if (typeof v === 'string') node.style.cssText = v;
        else for (const [sk, sv] of Object.entries(v)) {
          if (sv === null || sv === undefined) continue;
          if (sk.startsWith('--')) node.style.setProperty(sk, String(sv));
          else node.style[sk] = typeof sv === 'number' && !UNITLESS.has(sk) ? `${sv}px` : sv;
        }
      } else if (k === 'dataset') {
        for (const [dk, dv] of Object.entries(v)) node.dataset[dk] = String(dv);
      } else if (k.startsWith('on') && typeof v === 'function') {
        node.addEventListener(k.slice(2).toLowerCase(), v);
      } else if (k === 'value') {
        node.value = v;
      } else if (k === 'disabled' || k === 'checked' || k === 'selected') {
        node[k] = Boolean(v);
      } else {
        node.setAttribute(k, String(v));
      }
    }
    appendChildren(node, children);
    return node;
  }

  function appendChildren(node, children) {
    for (const child of children || []) {
      if (child === null || child === undefined || child === false || child === true) continue;
      if (Array.isArray(child)) appendChildren(node, child);
      else if (typeof child === 'string' || typeof child === 'number') node.appendChild(doc.createTextNode(String(child)));
      else node.appendChild(child);
    }
  }

  // ============ 工具 ============
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, Number(v) || 0));
  const lerp = (a, b, t) => a + (b - a) * t;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const perfNow = () => (win && win.performance ? win.performance.now() : Date.now());

  function formatTime(ms) {
    const total = Math.max(0, Math.floor((Number(ms) || 0) / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function escapeHtml(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  let idSeed = 0;
  function randomId(prefix = 'id') {
    idSeed += 1;
    return `${prefix}-${Date.now().toString(36).slice(-4)}${idSeed.toString(36)}${Math.floor(Math.random() * 1296).toString(36).padStart(2, '0')}`;
  }

  // ============ requestAnimationFrame 循环 ============
  //
  // 这里必须极其小心：raf() 会被高频调用（引擎每帧一次）。
  // 早期实现每次调用都 addEventListener('visibilitychange')，而调用方又往往丢弃
  // 返回的取消函数 —— 监听器以 60/秒 泄漏，切换标签页时成百上千个陈旧监听器
  // 会同时把旧帧循环重新启动，最终指数级爆炸、整个页面卡死。
  // 因此这里：全程只注册 1 个 document 监听，用活跃循环集合统一管理。
  const rafLoops = new Set();
  let rafVisBound = false;
  const onRafVisibility = () => {
    const hidden = Boolean(doc && doc.hidden);
    for (const loop of [...rafLoops]) {
      if (hidden) loop.suspend();
      else loop.resume();
    }
  };
  function bindRafVisibility() {
    if (rafVisBound) return;
    try {
      doc.addEventListener('visibilitychange', onRafVisibility);
      rafVisBound = true;
    } catch (err) { /* 忽略 */ }
  }
  function unbindRafVisibility() {
    if (!rafVisBound) return;
    try {
      doc.removeEventListener('visibilitychange', onRafVisibility);
    } catch (err) { /* 忽略 */ }
    rafVisBound = false;
  }

  /** requestAnimationFrame 循环，页面隐藏时自动暂停（全进程仅 1 个 visibility 监听） */
  function raf(fn) {
    const loop = {
      fn,
      handle: 0,
      last: perfNow(),
      stopped: false,
      running: false,
      step: null
    };
    loop.step = (t) => {
      if (loop.stopped) return;
      const dt = Math.min(100, t - loop.last);
      loop.last = t;
      loop.handle = 0;
      // 只有“当前待执行”的那一帧会走到这里，因此不会出现多条链
      loop.handle = win.requestAnimationFrame(loop.step);
      try {
        fn(dt, t);
      } catch (err) {
        console.warn('[phigrOS] raf 回调异常', err);
        loop.stopped = true;
        if (loop.handle) {
          try { win.cancelAnimationFrame(loop.handle); } catch (e) { /* 忽略 */ }
        }
        loop.handle = 0;
        rafLoops.delete(loop);
      }
    };
    loop.suspend = () => {
      if (loop.stopped || !loop.running) return;
      loop.running = false;
      if (loop.handle) {
        try { win.cancelAnimationFrame(loop.handle); } catch (err) { /* 忽略 */ }
      }
      loop.handle = 0;
    };
    loop.resume = () => {
      if (loop.stopped || loop.running) return; // 幂等：绝不重复启动
      loop.running = true;
      loop.last = perfNow();
      if (!loop.handle) loop.handle = win.requestAnimationFrame(loop.step);
    };

    rafLoops.add(loop);
    bindRafVisibility();
    if (!doc || !doc.hidden) loop.resume();

    return () => {
      if (loop.stopped) return;
      loop.stopped = true;
      loop.running = false;
      if (loop.handle) {
        try { win.cancelAnimationFrame(loop.handle); } catch (err) { /* 忽略 */ }
      }
      loop.handle = 0;
      rafLoops.delete(loop);
      if (rafLoops.size === 0) unbindRafVisibility();
    };
  }

  /** 诊断用：当前活跃的 rAF 循环数量（正常应恒为 1） */
  function rafLoopCount() {
    return rafLoops.size;
  }

  // ============ 文件系统 ============
  function normalize(p) {
    let path = String(p === null || p === undefined ? '/' : p).trim().replace(/\\/g, '/');
    if (!path.startsWith('/')) path = `/${path}`;
    const parts = [];
    for (const seg of path.split('/')) {
      if (!seg || seg === '.') continue;
      if (seg === '..') parts.pop();
      else parts.push(seg);
    }
    return `/${parts.join('/')}`;
  }

  function parentOf(p) {
    const path = normalize(p);
    if (path === '/') return null;
    const idx = path.lastIndexOf('/');
    return idx <= 0 ? '/' : path.slice(0, idx);
  }

  function nameOf(p) {
    const path = normalize(p);
    if (path === '/') return '/';
    return path.slice(path.lastIndexOf('/') + 1);
  }

  const fs = {
    normalize,
    parentOf,
    nameOf,
    list(dirPath) {
      const data = state.raw().fs || {};
      const dir = normalize(dirPath);
      const node = data[dir];
      if (!node) return [];
      if (node.type !== 'dir') return [fs.stat(dir)];
      const out = [];
      for (const childPath of node.children || []) {
        const st = fs.stat(childPath);
        if (st) out.push(st);
      }
      out.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name, 'zh') : a.type === 'dir' ? -1 : 1));
      return out;
    },
    stat(p) {
      const data = state.raw().fs || {};
      const path = normalize(p);
      const node = data[path];
      if (!node) return null;
      const isDir = node.type === 'dir';
      return {
        name: nameOf(path),
        path,
        type: isDir ? 'dir' : 'file',
        size: isDir ? 0 : (node.text || '').length,
        mtime: node.mtime || 0,
        children: isDir ? (node.children || []).slice() : undefined
      };
    },
    exists(p) {
      return Boolean((state.raw().fs || {})[normalize(p)]);
    },
    read(p) {
      const node = (state.raw().fs || {})[normalize(p)];
      if (!node || node.type !== 'file') return null;
      return typeof node.text === 'string' ? node.text : '';
    },
    mkdir(dirPath) {
      const path = normalize(dirPath);
      if (fs.exists(path)) return path;
      applyFs((data) => {
        mkdirIn(data, path);
        return path;
      });
      return path;
    },
    write(p, text) {
      const path = normalize(p);
      if (path === '/') throw new Error('不能写入根目录');
      applyFs((data) => {
        mkdirIn(data, parentOf(path));
        data[path] = { type: 'file', text: text === null || text === undefined ? '' : String(text), mtime: Date.now() };
        linkChild(data, parentOf(path), path);
        return path;
      });
      return path;
    },
    append(p, text) {
      const path = normalize(p);
      const cur = fs.read(path);
      if (cur === null) return fs.write(path, text);
      return fs.write(path, cur + (text === null || text === undefined ? '' : String(text)));
    },
    remove(p) {
      const path = normalize(p);
      if (path === '/') throw new Error('不能删除根目录');
      applyFs((data) => {
        removeIn(data, path);
        return path;
      });
      return path;
    },
    /** 目录树（供文件管理器用） */
    tree(dirPath = '/') {
      const st = fs.stat(dirPath);
      if (!st || st.type !== 'dir') return null;
      return {
        ...st,
        children: (st.children || []).map((c) => (fs.stat(c) && fs.stat(c).type === 'dir' ? fs.tree(c) : fs.stat(c))).filter(Boolean)
      };
    },
    onChange(cb) {
      fsSubs.add(cb);
      return () => fsSubs.delete(cb);
    }
  };

  function linkChild(data, dirPath, childPath) {
    if (!dirPath) return;
    const dir = data[dirPath];
    if (!dir || dir.type !== 'dir') return;
    if (!Array.isArray(dir.children)) dir.children = [];
    if (!dir.children.includes(childPath)) dir.children.push(childPath);
  }

  function mkdirIn(data, dirPath) {
    if (!dirPath) return;
    const parts = dirPath.split('/').filter(Boolean);
    if (!data['/']) data['/'] = { type: 'dir', children: [] };
    let cur = '';
    for (const seg of parts) {
      const next = cur ? `${cur}/${seg}` : `/${seg}`;
      if (!data[next] || data[next].type !== 'dir') data[next] = { type: 'dir', children: [] };
      linkChild(data, cur || '/', next);
      cur = next;
    }
    return cur;
  }

  function removeIn(data, path) {
    const node = data[path];
    if (!node) return;
    if (node.type === 'dir') {
      for (const child of (node.children || []).slice()) removeIn(data, child);
    }
    delete data[path];
    const parent = parentOf(path);
    const pnode = parent ? data[parent] : null;
    if (pnode && Array.isArray(pnode.children)) pnode.children = pnode.children.filter((c) => c !== path);
  }

  /** 统一的 fs 变更提交：保证 store 引用更新 + 通知订阅者 */
  function applyFs(mutator) {
    const data = JSON.parse(JSON.stringify(state.raw().fs || {}));
    const resultPath = mutator(data);
    fsVersion += 1;
    const myVersion = fsVersion;
    state.set('fs', data);
    queueMicrotask(() => {
      if (myVersion !== fsVersion) return; // 只通知最后一步，避免批量操作抖动
      for (const cb of [...fsSubs]) {
        try {
          cb();
        } catch (err) {
          console.warn('[phigrOS] fs 订阅回调异常', err);
        }
      }
    });
    return resultPath;
  }

  // ============ 窗口 ============
  const wmApi = {
    launch: (appId, opts) => wm.launch(appId, opts),
    close: (id) => wm.close(id),
    focus: (id) => wm.focus(id),
    minimize: (id) => wm.minimize(id),
    restore: (id) => wm.restore(id),
    list: () => wm.list(),
    focused: () => wm.focused(),
    on: (evt, cb) => wm.on(evt, cb),
    toggleApp: (appId) => wm.toggleApp(appId)
  };

  // ============ 通知 ============
  function notify(title, body = '', opts = {}) {
    const layer = doc.getElementById('toasts');
    if (!layer) return () => {};
    const node = el('div', { className: `toast ${opts.level || 'info'}` }, [
      opts.icon ? el('div', { className: 'toast-icon', textContent: String(opts.icon) }) : null,
      el('div', { className: 'toast-main' }, [
        el('div', { className: 'toast-title', textContent: String(title || '') }),
        body ? el('div', { className: 'toast-body', textContent: String(body) }) : null
      ])
    ]);
    layer.appendChild(node);
    requestAnimationFrame(() => node.classList.add('in'));
    let killed = false;
    const kill = () => {
      if (killed) return;
      killed = true;
      node.classList.remove('in');
      setTimeout(() => node.remove(), 260);
    };
    node.addEventListener('click', kill);
    const timeout = opts.timeout === undefined ? 3200 : Number(opts.timeout);
    if (timeout > 0) setTimeout(kill, timeout);
    if (audio && state.raw().settings.sfx) audio.sfx(opts.level === 'error' ? 'error' : 'ok');
    return kill;
  }

  // ============ 对话框 ============
  function dialog(opts = {}) {
    const layer = doc.getElementById('modals');
    return new Promise((resolve) => {
      const hasInput = Boolean(opts.input);
      const confirm = Boolean(opts.confirm);
      const inputEl = hasInput
        ? el('input', {
            className: 'ph-input dialog-input',
            type: 'text',
            value: opts.input && opts.input.value !== undefined ? String(opts.input.value) : '',
            placeholder: (opts.input && opts.input.placeholder) || ''
          })
        : null;
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        dialogDepth = Math.max(0, dialogDepth - 1);
        overlay.classList.remove('in');
        setTimeout(() => overlay.remove(), 180);
        doc.removeEventListener('keydown', onKey, true);
        resolve(value);
      };
      const overlay = el('div', { className: 'modal-overlay' }, [
        el('div', { className: 'modal', role: 'dialog', 'aria-modal': 'true' }, [
          el('div', { className: 'modal-title', textContent: String(opts.title || '提示') }),
          opts.body ? el('div', { className: 'modal-body', textContent: String(opts.body) }) : null,
          hasInput
            ? el('label', { className: 'modal-field' }, [
                el('span', { textContent: (opts.input && opts.input.label) || '输入' }),
                inputEl
              ])
            : null,
          el('div', { className: 'modal-actions' }, [
            hasInput || confirm
              ? el('button', { className: 'ph-btn ghost', textContent: '取消', onclick: () => finish(hasInput ? null : false) })
              : null,
            el('button', {
              className: `ph-btn ${opts.danger ? 'danger' : 'primary'}`,
              textContent: opts.okText || (hasInput || confirm ? '确定' : '知道了'),
              onclick: () => finish(hasInput ? (inputEl.value || '') : confirm ? true : null)
            })
          ])
        ])
      ]);
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          finish(hasInput ? null : false);
        } else if (e.key === 'Enter' && (hasInput || confirm)) {
          e.stopPropagation();
          finish(hasInput ? (inputEl.value || '') : true);
        }
      };
      overlay.addEventListener('mousedown', (e) => {
        if (e.target === overlay) finish(hasInput ? null : false);
      });
      doc.addEventListener('keydown', onKey, true);
      doc.getElementById('modals').appendChild(overlay);
      dialogDepth += 1;
      requestAnimationFrame(() => {
        overlay.classList.add('in');
        if (inputEl) {
          inputEl.focus();
          inputEl.select();
        }
      });
    });
  }

  // ============ 成就 / RKS ============
  function achievement(id, title, desc = '') {
    if (!id) return false;
    const cur = state.raw().achievements || {};
    if (cur[id] && cur[id].unlocked) return false;
    state.update('achievements', (a) => {
      const next = { ...(a || {}) };
      next[id] = { unlocked: true, at: Date.now(), title: String(title || ''), desc: String(desc || '') };
      return next;
    });
    recalcRks();
    notify(`成就解锁 · ${title}`, desc, { icon: '🏆', timeout: 4200 });
    // 收集类成就：解锁数达到 5 时自动解锁 collector
    if (id !== 'collector') {
      const count = Object.values(state.raw().achievements || {}).filter((a) => a && a.unlocked).length;
      if (count >= 5) {
        const c = state.raw().achievements.collector;
        if (!c || !c.unlocked) {
          state.update('achievements', (a) => {
            const next = { ...(a || {}) };
            next.collector = { unlocked: true, at: Date.now(), title: '收藏家', desc: '解锁 5 个成就' };
            return next;
          });
          notify('成就解锁 · 收藏家', '解锁 5 个成就', { icon: '🏆', timeout: 4200 });
        }
      }
    }
    return true;
  }

  /** 依据 player.record 计算 RKS（Phigros 公式：最高 27 个成绩） */
  function recalcRks() {
    const rec = state.raw().player.record || {};
    const accs = [];
    for (const trackId of Object.keys(rec)) {
      for (const diff of Object.keys(rec[trackId] || {})) {
        const r = rec[trackId][diff];
        if (!r || typeof r.acc !== 'number') continue;
        accs.push(r.acc);
      }
    }
    accs.sort((a, b) => b - a);
    const top = accs.slice(0, 27);
    const rks = top.reduce((sum, a) => sum + Math.pow(Math.max(0, a), 2) * 1, 0) / top.length;
    state.set('player.rks', Number.isFinite(rks) ? Number(rks.toFixed(4)) : 0);
    return rks;
  }

  // ============ 应用 / 系统 ============
  function apps(options = {}) {
    const q = (options.q || '').trim().toLowerCase();
    const list = [];
    // 以清单为准（惰性项虽未加载模块，也必须在开始菜单里可见）
    const source = kernel.registry && kernel.registry.size ? kernel.registry : kernel.apps;
    for (const app of source.values()) {
      if (!app || !app.id) continue;
      list.push({
        id: app.id,
        name: app.name || app.id,
        icon: app.icon || '▢',
        desc: app.desc || '',
        singleton: Boolean(app.singleton),
        loaded: typeof app.mount === 'function'
      });
    }
    const order = kernel.manifest.map((a) => a.id);
    list.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
    if (!q) return list;
    return list.filter((a) => `${a.name} ${a.id} ${a.desc}`.toLowerCase().includes(q));
  }

  function appMeta(appId) {
    const app = (kernel.registry && kernel.registry.get(appId)) || kernel.apps.get(appId);
    if (!app) return null;
    return {
      id: app.id,
      name: app.name || app.id,
      icon: app.icon || '▢',
      desc: app.desc || '',
      singleton: Boolean(app.singleton),
      loaded: typeof app.mount === 'function'
    };
  }

  function openFile(path) {
    const st = fs.stat(path);
    if (!st) {
      notify('打开失败', `路径不存在：${path}`, { level: 'error' });
      return null;
    }
    if (st.type === 'dir') return wm.launch('files', { file: st.path });
    const ext = (st.name.split('.').pop() || '').toLowerCase();
    if (ext === 'phigros' || ext === 'json') return wm.launch('phigros', { file: st.path });
    if (['txt', 'md', 'log', 'js', 'css', 'html', 'cpp', 'py'].includes(ext)) return wm.launch('notes', { file: st.path });
    return wm.launch('files', { file: st.path });
  }

  function onFocus(cb) {
    return wm.on('focus', (payload) => cb(payload.appId, payload.windowId));
  }

  function refreshWallpaper() {
    if (kernel.compositor) kernel.compositor.applyTheme();
  }

  // ============ 组装 ============
  const host = {
    version: VERSION,
    document: doc,
    window: win,
    $,
    $$,
    el,
    clamp,
    lerp,
    sleep,
    now: perfNow,
    formatTime,
    escapeHtml,
    raf,
    rafLoopCount,
    randomId,
    /** 切换元素 class，返回切换后的状态 */
    toggleClass(node, name, force) {
      if (!node) return false;
      if (force === undefined) node.classList.toggle(name);
      else node.classList.toggle(name, Boolean(force));
      return node.classList.contains(name);
    },
    store: {
      get: () => state.get(),
      raw: () => state.raw(),
      set: (p, v) => state.set(p, v),
      update: (p, fn) => state.update(p, fn),
      subscribe: (p, cb) => state.subscribe(p, cb),
      save: () => state.save(),
      reset: () => state.reset(),
      sizeBytes: () => state.sizeBytes()
    },
    fs,
    wm: wmApi,
    notify,
    dialog,
    achievement,
    recalcRks,
    apps,
    appMeta,
    openFile,
    onFocus,
    refreshWallpaper,
    desktop: null, // 由 compositor 回填
    startMenu: null,
    host: null
  };
  host.self = host;

  // 音频门面
  host.audio = {
    unlock: () => audio.unlock(),
    ready: () => audio.ready(),
    setVolume: (v) => audio.setVolume(v),
    volume: () => audio.volume(),
    sfx: (name) => audio.sfx(name),
    playBgm: (kind) => audio.playBgm(kind),
    stopBgm: () => audio.stopBgm(),
    engine: audio
  };

  host.power = (action) => {
    if (action === 'reboot') kernel.reboot();
  };

  host.launch = (appId, opts) => wm.launch(appId, opts);

  return host;
}

const UNITLESS = new Set(['zIndex', 'opacity', 'fontWeight', 'lineHeight', 'flex', 'flexGrow', 'flexShrink', 'order', 'zoom']);

export default createHost;
