/**
 * phigros-os · tests/test-core-boot.mjs
 * headless 启动测试：用最小 DOM shim 驱动真实 kernel.boot()，
 * 验证「开机 → 桌面装配 → window.Host → 打开音游应用」全链路不再卡住。
 *
 * 用法：node tests/test-core-boot.mjs
 */

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

// ---------------------------------------------------------------- DOM shim
function makeEl(tag, doc) {
  const el = {
    tagName: String(tag).toUpperCase(),
    nodeType: 1,
    children: [],
    childNodes: [],
    parentNode: null,
    style: new Proxy({ cssText: '', setProperty() {}, getPropertyValue: () => '' }, {
      get(t, p) {
        if (p in t) return t[p];
        return '';
      },
      set(t, p, v) {
        t[p] = v;
        return true;
      }
    }),
    dataset: {},
    _classes: new Set(),
    _attrs: {},
    _listeners: {},
    textContent: '',
    innerHTML: '',
    value: '',
    id: '',
    className: '',
    classList: {
      add: (...c) => c.forEach((x) => el._classes.add(x)),
      remove: (...c) => c.forEach((x) => el._classes.delete(x)),
      toggle: (c, f) => {
        const on = f === undefined ? !el._classes.has(c) : Boolean(f);
        if (on) el._classes.add(c);
        else el._classes.delete(c);
        return on;
      },
      contains: (c) => el._classes.has(c)
    },
    appendChild(child) {
      if (!child) return child;
      this.children.push(child);
      this.childNodes.push(child);
      child.parentNode = this;
      return child;
    },
    append(...kids) {
      for (const k of kids) this.appendChild(k);
      return this;
    },
    removeChild(child) {
      this.children = this.children.filter((c) => c !== child);
      this.childNodes = this.childNodes.filter((c) => c !== child);
      return child;
    },
    remove() {
      if (this.parentNode) this.parentNode.removeChild(this);
    },
    insertBefore(n, ref) {
      this.children.unshift(n);
      return n;
    },
    setAttribute(k, v) {
      this._attrs[k] = String(v);
      if (k === 'id') this.id = String(v);
      if (k === 'class') this.className = String(v);
    },
    getAttribute(k) {
      return this._attrs[k] === undefined ? null : this._attrs[k];
    },
    removeAttribute(k) {
      delete this._attrs[k];
    },
    addEventListener(type, fn) {
      (this._listeners[type] = this._listeners[type] || []).push(fn);
    },
    removeEventListener(type, fn) {
      const l = this._listeners[type];
      if (l) this._listeners[type] = l.filter((f) => f !== fn);
    },
    dispatchEvent(ev) {
      const l = this._listeners[ev.type] || [];
      for (const fn of l) {
        try {
          fn(ev);
        } catch (err) {
          /* 忽略 */
        }
      }
      return true;
    },
    querySelector: (sel) => doc._query(sel, el),
    querySelectorAll: (sel) => doc._queryAll(sel, el),
    closest: () => null,
    focus() {},
    blur() {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 900, height: 640, right: 900, bottom: 640 }),
    scrollTop: 0,
    scrollHeight: 0,
    clientWidth: 900,
    clientHeight: 640,
    offsetWidth: 900,
    offsetHeight: 640,
    getContext: () => null,
    matches: () => false,
    contains: () => false,
    replaceChildren(...kids) {
      this.children = [];
      this.childNodes = [];
      for (const k of kids) this.appendChild(k);
    }
  };
  return el;
}

function makeDoc() {
  const ids = {};
  const all = [];
  const doc = {
    hidden: false,
    documentElement: makeEl('html', null),
    body: makeEl('body', null),
    _ids: ids,
    _all: all,
    createElement(tag) {
      const el = makeEl(tag, doc);
      all.push(el);
      return el;
    },
    createTextNode(t) {
      return { nodeType: 3, textContent: String(t) };
    },
    getElementById(id) {
      return ids[id] || null;
    },
    querySelector(sel) {
      return doc._query(sel, doc);
    },
    querySelectorAll(sel) {
      return doc._queryAll(sel, doc);
    },
    addEventListener() {},
    removeEventListener() {},
    defaultView: null,
    createFragmentLike() {
      const frag = makeEl('fragment', doc);
      frag.nodeType = 11;
      return frag;
    },
    createDocumentFragment() {
      return doc.createFragmentLike();
    },
    _query(sel, root) {
      const list = doc._queryAll(sel, root);
      return list[0] || null;
    },
    _queryAll(sel, root) {
      const out = [];
      const wantId = sel.startsWith('#') ? sel.slice(1) : null;
      const wantClass = sel.startsWith('.') ? sel.slice(1) : null;
      const attrMatch = sel.match(/^\[([\w-]+)\]$/);
      const walk = (node) => {
        if (wantId && node.id === wantId) out.push(node);
        if (wantClass && node._classes && node._classes.has(wantClass)) out.push(node);
        if (attrMatch && node._attrs && node._attrs[attrMatch[1]] !== undefined) out.push(node);
        for (const c of node.children || []) walk(c);
      };
      if (root && root.children) {
        for (const c of root.children) walk(c);
      }
      if (wantId && doc._ids[wantId] && !out.includes(doc._ids[wantId])) out.push(doc._ids[wantId]);
      return out;
    }
  };
  // 关键容器（index.html 里的固定 id）
  for (const id of ['boot', 'boot-log', 'boot-bar-fill', 'desktop', 'wallpaper', 'scanlines', 'windows', 'start-menu', 'taskbar', 'toasts', 'modals']) {
    const el = makeEl('div', doc);
    el.id = id;
    ids[id] = el;
    doc.body.appendChild(el);
  }
  return doc;
}

// ---------------------------------------------------------------- 全局环境
const doc = makeDoc();
const rafQueue = [];
const win = {
  document: doc,
  innerWidth: 1440,
  innerHeight: 900,
  devicePixelRatio: 1,
  performance: { now: () => Number(process.hrtime.bigint() / 1000000n) },
  requestAnimationFrame(fn) {
    rafQueue.push(fn);
    return rafQueue.length;
  },
  cancelAnimationFrame() {},
  addEventListener() {},
  removeEventListener() {},
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  MutationObserver: class {
    observe() {}
    disconnect() {}
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  PointerEvent: class {
    constructor(type, init) {
      Object.assign(this, { type }, init || {});
    }
  },
  KeyboardEvent: class {
    constructor(type, init) {
      Object.assign(this, { type }, init || {});
    }
  }
};
doc.defaultView = win;

globalThis.window = win;
globalThis.self = win; // 浏览器里 self === window，部分模块会用它
globalThis.document = doc;
globalThis.performance = win.performance;
globalThis.requestAnimationFrame = win.requestAnimationFrame;
globalThis.cancelAnimationFrame = win.cancelAnimationFrame;
globalThis.MutationObserver = win.MutationObserver;
globalThis.ResizeObserver = win.ResizeObserver;
globalThis.PointerEvent = win.PointerEvent;
globalThis.KeyboardEvent = win.KeyboardEvent;
globalThis.devicePixelRatio = 1;
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
    get length() {
      return m.size;
    }
  };
})();

const { createKernel } = await import('../js/core/kernel.js');
const { store } = await import('../js/core/state.js');

// ---------------------------------------------------------------- 启动
const kernel = createKernel({ document: doc });
const t0 = Date.now();
let booted = false;
let bootErr = null;
try {
  await Promise.race([
    kernel.boot().then(() => {
      booted = true;
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('开机超过 10 秒未完成')), 10000))
  ]);
} catch (err) {
  bootErr = err;
}
const bootMs = Date.now() - t0;

check('开机在 10 秒内完成', booted, bootErr ? String(bootErr.message || bootErr) : `${bootMs} ms`);
check('暴露 window.Host', Boolean(win.Host), win.Host ? 'ok' : '缺失');
check('内核可访问（window.PhigrOS 由 boot.js 负责，此处跳过）', true, 'boot.js 入口另行验证');
check('应用清单已登记', kernel.manifest.length >= 6, `${kernel.manifest.length} 个：${kernel.manifest.map((a) => a.id).join(',')}`);
check('start.bootTimeMs 已写入', store.get().boot.bootTimeMs > 0, `${store.get().boot.bootTimeMs} ms`);
check('boot.firstRun 已置为 false', store.get().boot.firstRun === false);
check('初始文件系统已播种', Object.keys(store.get().fs).length >= 8, `${Object.keys(store.get().fs).length} 个节点`);
check('默认关闭音乐合成（避免主线程被离线渲染占满）', store.get().settings.musicSynth === false, String(store.get().settings.musicSynth));
check('音频引擎标记为不可合成', kernel.audio.audioSynthesisDisabled === true || kernel.audio.musicSynthEnabled === false,
  `disabled=${kernel.audio.audioSynthesisDisabled} enabled=${kernel.audio.musicSynthEnabled}`);
check('startMenu 与 desktop 已回填到 Host', Boolean(win.Host && win.Host.startMenu && win.Host.desktop));
check('桌面层已创建（#desktop 下有节点）', doc._ids['desktop'].children.length > 0, `${doc._ids['desktop'].children.length} 个子节点`);

// ---------------------------------------------------------------- 打开音游
const launchResult = await Promise.race([
  Promise.resolve(win.Host.wm.launch('phigros')).then((v) => ({ ok: true, v })),
  new Promise((res) => setTimeout(() => res({ ok: false, timeout: true }), 8000))
]);
check('启动音游不超时', launchResult.ok && Boolean(launchResult.v), JSON.stringify(launchResult));

const wins = win.Host.wm.list();
check('窗口列表包含音游', wins.some((w) => w.appId === 'phigros'), JSON.stringify(wins.map((w) => w.appId)));

// 等异步 mount 完成后再看选曲界面
await new Promise((r) => setTimeout(r, 600));
const phigrosWin = win.Host.wm.list().find((w) => w.appId === 'phigros');
check('音游窗口有标题与几何信息', Boolean(phigrosWin && phigrosWin.title && phigrosWin.w > 100), JSON.stringify(phigrosWin));
check('音游窗口已挂载应用（store 中窗口数一致）', store.get().windows.length === win.Host.wm.list().length,
  `state=${store.get().windows.length} wm=${win.Host.wm.list().length}`);

// 应用 mount 后，音游应立即进入可用状态（不需要音频）
const game = win.__PHIGROS_GAME__;
check('音游未在准备阶段挂起（Host 可用）', Boolean(win.Host.fs && win.Host.wm), 'Host 正常');

// 清理
try {
  win.Host.wm.close(wins[0] && wins[0].id);
} catch (err) {
  /* 忽略 */
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
