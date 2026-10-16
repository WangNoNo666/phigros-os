// fsinit.js —— phigrOS 初始文件系统内容（首次开机即有内容）
//
// 语义约定（内核/Lead 注意）：
//   seedFs(fs, opts) 返回一个【全新的】fs 对象，不会原地修改传入对象。
//   同名路径已存在时不覆盖用户内容（幂等）。
//   opts.now 可指定新建节点的 mtime；缺省用固定常数 DEFAULT_MTIME，
//   这样连续调用两次得到完全相同的对象（便于自测与状态比较）。
//
// 只依赖 CONTRACT §3 的扁平 fs 结构，不触碰 window/document/Host。

/** 新建节点的默认修改时间（固定值，保证幂等） */
export const DEFAULT_MTIME = 1700000000000;

/** 绝对路径规范化：去多余斜杠、只保留 '/' 根、去掉结尾斜杠 */
export function normalizePath(input) {
  if (typeof input !== 'string') return '/';
  let s = input.trim().replace(/\\/g, '/');
  if (!s) return '/';
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

/** 取父目录绝对路径；'/' 的父目录为 null */
export function parentPath(path) {
  const p = normalizePath(path);
  if (p === '/') return null;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** 取路径最后一段名字 */
export function baseName(path) {
  const p = normalizePath(path);
  if (p === '/') return '/';
  return p.slice(p.lastIndexOf('/') + 1);
}

const README_TEXT = [
  'phigrOS —— 为音游而生的网页操作系统',
  '',
  '欢迎回来。这里是一份极简使用说明：',
  '',
  '1. 桌面：双击图标即可启动应用；桌面空白处右键可打开右键菜单。',
  '2. 开始菜单：点击左下角按钮（或按键盘上的开始键区）浏览全部应用。',
  '3. 文件管理器（📁）可以浏览这个虚拟文件系统；/home 是你的家目录。',
  '4. 记事本（📝）可以打开并编辑任何 .txt / .md 文件，Ctrl+S 保存。',
  '5. 音游（🎵）：选择曲目与难度，开始游玩。成绩会写入 player.record。',
  '6. 设置（⚙️）：主题色相、墙纸、音量、下落速度与判定偏移都在那里。',
  '7. 关于（💠）：查看系统信息与成就列表。',
  '',
  '本系统完全离线运行：零构建、零 CDN、无外部依赖。',
  '所有数据保存在浏览器的 localStorage 中，可在「设置 → 数据」里导出或重置。',
  '',
  '祝游玩愉快。',
  ''
].join('\n');

const WELCOME_TEXT = [
  '# 欢迎来到 phigrOS',
  '',
  '这是一个把节奏游戏当成一等公民的小型操作系统。',
  '',
  '## 目录导览',
  '',
  '- `/home` —— 你的家目录，所有个人文件放这里',
  '- `/home/Music` —— 曲目说明与自制谱面草稿',
  '- `/home/Documents` —— 笔记与文档',
  '- `/system` —— 系统说明文件（请勿删除）',
  '',
  '## 一些约定',
  '',
  '- 谱面文件后缀为 `.phigros` 或 `.json`，双击会用音游应用打开。',
  '- `.txt` / `.md` 文件双击用记事本打开。',
  '- 文件名尽量避免 `/` 字符。',
  '',
  '> 提示：在文件管理器里按 `~` 直接回到 /home，按 `/` 回到根目录。',
  ''
].join('\n');

const MUSIC_TEXT = [
  '曲目说明',
  '========',
  '',
  'phigrOS 内置曲目（全部由 Web Audio 程序化合成，无音频文件）：',
  '',
  '1. First Light      —— Easy   （定数 4）  明亮的入门曲，适合熟悉判定。',
  '2. Neon Runner      —— Hard   （定数 9）  快节奏，8 分音符连打较多。',
  '3. Void Cathedral   —— Extra  （定数 14） 高密度谱面，注意位移与长按。',
  '',
  '自制谱面草稿可以放在这个目录里，后缀用 .json 或 .phigros，',
  '双击即可用音游应用尝试打开。',
  '',
  '谱面时间单位是秒；x 为 0..1 的横向位置；type 支持 tap / drag / hold。',
  ''
].join('\n');

const NOTE_TEXT = [
  '随手记',
  '------',
  '',
  '- 今天试了 Extra 难度，判定偏移好像要往 -20ms 调。',
  '- 记得去设置里把主题色相改成 300 试试。',
  '- 待办：给 /home/Music 里加一首自制谱。',
  ''
].join('\n');

const SYSTEM_TEXT = [
  'phigrOS 系统说明',
  '================',
  '',
  '版本：1.0.0',
  '形态：纯静态网页操作系统（零构建 / 零 CDN / 离线可用）',
  '',
  '内核模块：state.js 唯一状态源，kernel.js 生命周期，host.js 宿主 API，',
  'compositor.js 桌面墙纸，shell/ 窗口管理器与任务栏，engine/ 音频与音游引擎。',
  '',
  '状态存储：localStorage（键名由 js/core/state.js 决定）。',
  '重置数据：设置 → 数据 → 重置全部数据。',
  '',
  '本文件由 fsinit.js 的 DEFAULT_FILES 生成，可安全删除。',
  ''
].join('\n');

/** 初始文件系统内容：绝对路径 -> 节点定义 */
export const DEFAULT_FILES = {
  '/home': { type: 'dir' },
  '/home/README.txt': { type: 'file', text: README_TEXT },
  '/home/欢迎.md': { type: 'file', text: WELCOME_TEXT },
  '/home/Desktop': { type: 'dir' },
  '/home/Music': { type: 'dir' },
  '/home/Music/曲目说明.txt': { type: 'file', text: MUSIC_TEXT },
  '/home/Documents': { type: 'dir' },
  '/home/Documents/笔记.txt': { type: 'file', text: NOTE_TEXT },
  '/system': { type: 'dir' },
  '/system/about.txt': { type: 'file', text: SYSTEM_TEXT }
};

/** DEFAULT_FILES 的规范化路径列表（父目录在前，顺序稳定） */
export const DEFAULT_PATHS = Object.keys(DEFAULT_FILES)
  .map(normalizePath)
  .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'zh'));

function makeFileNode(text, mtime) {
  return { type: 'file', text: typeof text === 'string' ? text : String(text == null ? '' : text), mtime };
}

function cloneNode(path, node) {
  if (node.type === 'file') {
    const mtime = Number.isFinite(node.mtime) ? node.mtime : DEFAULT_MTIME;
    return makeFileNode(node.text, mtime);
  }
  return { type: 'dir', children: Array.isArray(node.children) ? node.children.map(normalizePath) : [] };
}

/**
 * 深拷贝并规整一份 fs：规范化键名、补全根目录、修剪孤儿节点。
 * 返回新对象，不修改入参。
 */
export function cloneFs(fs) {
  const out = { '/': { type: 'dir', children: [] } };
  if (fs && typeof fs === 'object') {
    for (const rawKey of Object.keys(fs)) {
      const path = normalizePath(rawKey);
      if (path === '/') continue;
      const node = fs[rawKey];
      if (!node || typeof node !== 'object') continue;
      if (out[path]) continue; // 键名冲突时保留先出现的
      out[path] = cloneNode(path, node);
    }
  }
  return out;
}

/**
 * 重建所有目录的 children，使其与该目录下真实存在的子路径一致：
 * 顺序上先保留原有合法子项，再按名称补上缺失的子项。
 */
export function normalizeChildren(fs) {
  const byParent = new Map();
  for (const path of Object.keys(fs)) {
    if (path === '/') continue;
    const parent = parentPath(path);
    if (!parent) continue;
    const parentNode = fs[parent];
    if (!parentNode || parentNode.type !== 'dir') continue;
    if (!byParent.has(parent)) byParent.set(parent, []);
    byParent.get(parent).push(path);
  }
  for (const path of Object.keys(fs)) {
    const node = fs[path];
    if (!node || node.type !== 'dir') continue;
    const expected = byParent.get(path) || [];
    const expectedSet = new Set(expected);
    const kept = [];
    const raw = Array.isArray(node.children) ? node.children : [];
    for (const child of raw) {
      const cp = normalizePath(child);
      if (!expectedSet.has(cp)) continue;
      if (kept.indexOf(cp) !== -1) continue;
      kept.push(cp);
    }
    const missing = expected
      .filter((p) => kept.indexOf(p) === -1)
      .sort((a, b) => a.localeCompare(b, 'zh'));
    node.children = kept.concat(missing);
  }
  return fs;
}

/**
 * 修剪孤儿节点：从 '/' 出发按 children 可达的节点才是有效节点。
 * 返回被删除的路径数组。
 */
export function pruneOrphans(fs) {
  const reachable = new Set(['/']);
  const queue = ['/'];
  while (queue.length) {
    const cur = queue.shift();
    const node = fs[cur];
    if (!node || node.type !== 'dir') continue;
    for (const child of node.children || []) {
      if (!fs[child]) continue;
      if (reachable.has(child)) continue;
      reachable.add(child);
      queue.push(child);
    }
  }
  const removed = [];
  for (const path of Object.keys(fs)) {
    if (reachable.has(path)) continue;
    delete fs[path];
    removed.push(path);
  }
  return removed;
}

/** 完整的 fs 规整流程（内部使用，也便于自测） */
export function normalizeFs(fs) {
  const out = cloneFs(fs);
  normalizeChildren(out);
  pruneOrphans(out);
  normalizeChildren(out);
  return out;
}

function ensureDir(fs, path, mtime) {
  const p = normalizePath(path);
  if (p !== '/' && !fs[p]) fs[p] = { type: 'dir', children: [] };
  return fs[p];
}

/**
 * 幂等写入初始文件系统内容。
 * @param {object|null} fs 现有 fs（可为 null / undefined）
 * @param {{now?: number, only?: string[], firstRun?: boolean}} [opts]
 *        now: 新建节点 mtime；only: 只播种这些路径。
 *        firstRun: 兼容内核签名。为真表示首次开机（写入全部初始内容），
 *        为假表示非首次（只补缺失路径）。两种情况下都【绝不覆盖】已存在节点，
 *        因此结果一致，仅语义标注不同。
 * @returns {object} 新的 fs 对象（不修改入参）
 */
export function seedFs(fs, opts = {}) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const mtime = Number.isFinite(options.now) ? options.now : DEFAULT_MTIME;
  const only = Array.isArray(options.only) ? options.only.map(normalizePath) : null;
  const out = cloneFs(fs);

  // 先建目录，再建文件，保证父目录一定存在
  const entries = Object.keys(DEFAULT_FILES).map((key) => ({
    raw: key,
    path: normalizePath(key),
    def: DEFAULT_FILES[key] || {}
  }));
  const dirs = entries.filter((e) => e.def.type === 'dir');
  const files = entries.filter((e) => e.def.type !== 'dir');
  const ordered = dirs.concat(files);

  for (const entry of ordered) {
    const { path, def } = entry;
    if (path === '/') continue;
    if (only && only.indexOf(path) === -1) continue;
    if (out[path]) continue; // 已存在：绝不覆盖用户内容
    ensureDir(out, parentPath(path), mtime);
    if (def.type === 'dir') out[path] = { type: 'dir', children: [] };
    else out[path] = makeFileNode(def.text, mtime);
  }

  normalizeChildren(out);
  pruneOrphans(out);
  normalizeChildren(out);
  return out;
}

export default { DEFAULT_FILES, DEFAULT_PATHS, seedFs, normalizeFs };
