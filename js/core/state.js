/**
 * phigrOS · js/core/state.js
 * 唯一状态源。所有状态改动都必须经过本模块，便于落盘与订阅。
 */

const KEY = 'phigros-os:state:v1';
const VERSION = 1;

/** 默认状态（CONTRACT §2：顶层键不得增删） */
export function defaults() {
  return {
    version: VERSION,
    boot: { firstRun: true, bootCount: 0, lastBootAt: 0, bootTimeMs: 0 },
    fs: {
      '/': { type: 'dir', children: ['/home', '/system'] },
      '/home': { type: 'dir', children: [] },
      '/system': { type: 'dir', children: [] }
    },
    windows: [],
    zTop: 10,
    settings: {
      volume: 0.8,
      sfx: true,
      bgm: true,
      musicSynth: false, // 程序化音乐合成默认关闭：离线渲染会整段占用主线程，会毁掉判定手感。需要音乐时在「设置 → 程序化音乐合成」打开。
      speed: 1.0,
      offsetMs: 0,
      themeHue: 190,
      scanlines: true,
      smoothMode: true, // 流畅模式：关闭模糊/动画/重特效（弱 GPU 或远程桌面必备）
      renderMode: 'dom', // 音游渲染后端：'dom'（CSS transform，默认，最流畅）或 'canvas'
      showFps: false
    },
    player: { name: 'PHIGROS-PLAYER', rks: 0, totalPlay: 0, record: {} },
    achievements: {}
  };
}

/** 深拷贝（结构化数据，无循环引用） */
export function deepClone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(deepClone);
  const out = {};
  for (const k of Object.keys(value)) out[k] = deepClone(value[k]);
  return out;
}

/** 深度合并：以 base 的类型为准，用 patch 覆盖；数组直接替换 */
export function deepMerge(base, patch) {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(base) || Array.isArray(patch)) return deepClone(patch);
  if (typeof base !== 'object' && typeof patch !== 'object') return patch;
  if (typeof patch !== 'object') return base;
  const out = {};
  const keys = new Set([...Object.keys(base || {}), ...Object.keys(patch || {})]);
  for (const k of keys) {
    if (!(k in patch)) {
      out[k] = deepClone(base[k]);
    } else if (base && typeof base[k] === 'object' && base[k] !== null && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], patch[k]);
    } else {
      out[k] = deepClone(patch[k]);
    }
  }
  return out;
}

/** 按点分路径读值 */
export function getPath(obj, path) {
  if (!path) return obj;
  const parts = String(path).split('.');
  let cur = obj;
  for (const p of parts) {
    if (cur === null || cur === undefined) return undefined;
    cur = cur[p];
  }
  return cur;
}

/** 按点分路径写值（返回新的根对象，不可变更新） */
export function setPath(obj, path, value) {
  const parts = String(path).split('.');
  const root = deepClone(obj);
  let cur = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] === null || typeof cur[p] !== 'object') cur[p] = {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = deepClone(value);
  return root;
}

function safeStorage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    const probe = '__phigros_probe__';
    localStorage.setItem(probe, '1');
    localStorage.removeItem(probe);
    return localStorage;
  } catch (_e) {
    return null;
  }
}

/**
 * 迁移：保证老存档缺少的新字段被补上，且顶层键完整。
 * 用户数据（player/achievements/fs/settings 的自定义键）一律保留。
 */
export function migrate(raw) {
  const base = defaults();
  if (!raw || typeof raw !== 'object') return base;
  const merged = deepMerge(base, raw);
  // 顶层键强制存在
  for (const k of Object.keys(base)) {
    if (!(k in merged)) merged[k] = base[k];
  }
  merged.version = VERSION;
  // 数值合法性兜底
  const s = merged.settings;
  s.volume = num(s.volume, base.settings.volume, 0, 1);
  s.speed = num(s.speed, base.settings.speed, 0.5, 2);
  s.offsetMs = num(s.offsetMs, 0, -200, 200);
  s.themeHue = num(s.themeHue, 190, 0, 360);
  if (!merged.player || typeof merged.player !== 'object') merged.player = base.player;
  if (!merged.player.record || typeof merged.player.record !== 'object') merged.player.record = {};
  merged.player.totalPlay = num(merged.player.totalPlay, 0, 0, Infinity);
  merged.player.rks = num(merged.player.rks, 0, 0, Infinity);
  // v1.0.1：离线音频渲染会整段占用主线程、毁掉判定手感，因此默认关闭合成；
  // 并默认开启「流畅模式」，避免首次运行就撞上模糊/动画的合成开销。
  if (typeof merged.settings.musicSynth !== 'boolean') merged.settings.musicSynth = false;
  if (typeof merged.settings.smoothMode !== 'boolean') merged.settings.smoothMode = true;
  const rawSettings = (raw && typeof raw.settings === 'object' && raw.settings) || {};
  const schema = num(rawSettings.schema, 0, 0, 9999);
  if (schema < 3) {
    // 老存档升级：这两项是性能修复的关键开关，未被用户显式设置过就采用新默认值
    merged.settings.schema = 3;
    if (rawSettings.musicSynth !== true) merged.settings.musicSynth = false;
    if (rawSettings.smoothMode === undefined) merged.settings.smoothMode = true;
  }
  if (!merged.achievements || typeof merged.achievements !== 'object') merged.achievements = {};
  if (!merged.fs || typeof merged.fs !== 'object') merged.fs = base.fs;
  if (!Array.isArray(merged.windows)) merged.windows = [];
  return merged;
}

function num(v, fallback, lo, hi) {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

/**
 * State —— 状态容器
 */
export class State {
  constructor(options = {}) {
    this.storage = options.storage === undefined ? safeStorage() : options.storage;
    this.subs = new Map(); // path -> Set<fn>
    this.persistTimer = null;
    this.persistDelay = options.persistDelay === undefined ? 220 : options.persistDelay;
    this._data = this.load();
  }

  load() {
    if (!this.storage) return defaults();
    try {
      const raw = this.storage.getItem(KEY);
      if (!raw) return defaults();
      return migrate(JSON.parse(raw));
    } catch (err) {
      console.warn('[phigrOS] 存档解析失败，已回退默认值', err);
      return defaults();
    }
  }

  /** 只读快照 */
  get() {
    return deepClone(this._data);
  }

  /** 不经拷贝的内部读取（性能敏感路径），请勿修改返回值 */
  raw() {
    return this._data;
  }

  set(path, value) {
    return this._commit(setPath(this._data, path, value), path);
  }

  update(path, fn) {
    const cur = getPath(this._data, path);
    const next = typeof fn === 'function' ? fn(deepClone(cur)) : fn;
    return this._commit(setPath(this._data, path, next), path);
  }

  _commit(nextData, changedPath) {
    const prev = this._data;
    this._data = nextData;
    this.saveSoon();
    this._emit(changedPath, prev);
    return this.get();
  }

  _emit(changedPath, prevData) {
    const path = changedPath || '';
    for (const [subPath, set] of this.subs) {
      const hit =
        subPath === '' ||
        subPath === path ||
        path === '' ||
        path.startsWith(subPath + '.') ||
        subPath.startsWith(path + '.');
      if (!hit) continue;
      const value = this.get() && getPath(this._data, subPath);
      for (const fn of [...set]) {
        try {
          fn(deepClone(value), subPath);
        } catch (err) {
          console.warn('[phigrOS] 订阅回调异常', subPath, err);
        }
      }
    }
  }

  /** 订阅某个路径（含父/子路径变化），返回取消函数 */
  subscribe(path, cb) {
    const key = path || '';
    if (!this.subs.has(key)) this.subs.set(key, new Set());
    this.subs.get(key).add(cb);
    return () => {
      const set = this.subs.get(key);
      if (!set) return;
      set.delete(cb);
      if (set.size === 0) this.subs.delete(key);
    };
  }

  saveSoon() {
    if (this.persistTimer !== null) return;
    const run = () => {
      this.persistTimer = null;
      this.save();
    };
    if (typeof setTimeout === 'function') this.persistTimer = setTimeout(run, this.persistDelay);
    else run();
  }

  save() {
    if (this.persistTimer !== null && typeof clearTimeout === 'function') {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    if (!this.storage) return false;
    try {
      this.storage.setItem(KEY, JSON.stringify(this._data));
      return true;
    } catch (err) {
      console.warn('[phigrOS] 存档写入失败', err);
      return false;
    }
  }

  reset() {
    const prev = this._data;
    this._data = defaults();
    this.save();
    this._emit('', prev);
    return this.get();
  }

  /** localStorage 占用估算（字节） */
  sizeBytes() {
    try {
      return this.storage ? (this.storage.getItem(KEY) || '').length * 2 : 0;
    } catch (_e) {
      return 0;
    }
  }
}

export const STORAGE_KEY = KEY;
export const STATE_VERSION = VERSION;
export const store = new State();
export default store;
