// tests/test-apps-sysapps.mjs —— sysapps 纯逻辑自测（node 环境，无 DOM）
//
// 运行：node tests/test-apps-sysapps.mjs
// 覆盖：fsinit.js（seedFs 幂等性 / 路径集合 / children 一致性 / 无孤儿节点）
//       about.js（ACHIEVEMENTS 定义表 + 纯函数）
//       settings.js（formatBytes / clampNumber / localStorage 估算 等纯函数）
//       notes.js（countText 等纯函数）
//       manifest.js（清单可被 node import、id 唯一、顺序正确）

import assert from 'node:assert/strict';
import {
  DEFAULT_FILES,
  DEFAULT_PATHS,
  DEFAULT_MTIME,
  seedFs,
  normalizeFs,
  normalizePath,
  parentPath,
  baseName
} from '../js/apps/fsinit.js';
import {
  ACHIEVEMENTS,
  achievementView,
  unlockedCount,
  readVersion,
  formatDuration,
  describeUA,
  storageAvailable
} from '../js/apps/about.js';
import {
  WALLPAPER_KINDS,
  SFX_NAMES,
  clampNumber,
  formatBytes,
  formatVolume,
  formatHue,
  formatSpeed,
  formatOffset,
  estimateLocalStorageBytes
} from '../js/apps/settings.js';
import { countText, formatClock, joinPath as notesJoin } from '../js/apps/notes.js';
import manifest, { MANIFEST_IDS, findApp } from '../js/apps/manifest.js';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log('PASS ' + name);
  } catch (err) {
    failed += 1;
    const msg = err && err.message ? err.message : String(err);
    console.log('FAIL ' + name);
    console.log('     ' + msg.split('\n').join('\n     '));
  }
}

/** 键顺序无关的规范化序列化，用于比较 fs 结构 */
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const EXPECTED_PATHS = [
  '/',
  '/home',
  '/home/Desktop',
  '/home/Documents',
  '/home/Documents/笔记.txt',
  '/home/Music',
  '/home/Music/曲目说明.txt',
  '/home/README.txt',
  '/home/欢迎.md',
  '/system',
  '/system/about.txt'
];

// ======================= fsinit.js =======================

test('fsinit: seedFs(null) 生成预期的路径集合', () => {
  const fs = seedFs(null);
  assert.deepEqual(Object.keys(fs).sort(), EXPECTED_PATHS.slice().sort());
});

test('fsinit: DEFAULT_PATHS 与 DEFAULT_FILES 一致且父目录在前', () => {
  assert.equal(DEFAULT_PATHS.length, Object.keys(DEFAULT_FILES).length);
  for (const path of DEFAULT_PATHS) assert.ok(DEFAULT_FILES[path], 'DEFAULT_FILES 缺少 ' + path);
  const index = new Map(DEFAULT_PATHS.map((p, i) => [p, i]));
  for (const path of DEFAULT_PATHS) {
    const parent = parentPath(path);
    if (!parent || parent === '/') continue;
    assert.ok(index.get(parent) < index.get(path), '父目录应排在子路径之前：' + path);
  }
});

test('fsinit: duplicate keys 归一化后仍然幂等（含尾斜杠写法）', () => {
  const a = seedFs({ '/home/Music/': { type: 'dir', children: [] } });
  const b = seedFs(a);
  assert.equal(canonical(a), canonical(b));
  assert.ok(a['/home/Music'], '尾斜杠键应被归一化为 /home/Music');
});

test('fsinit: seedFs 幂等（跑两次结果完全一致）', () => {
  const once = seedFs(null);
  const twice = seedFs(once);
  assert.equal(canonical(twice), canonical(once));
  assert.equal(canonical(seedFs(seedFs(null))), canonical(seedFs(null)));
});

test('fsinit: 不覆盖已存在内容', () => {
  const first = seedFs(null);
  first['/home/README.txt'].text = '用户自己改过的内容';
  first['/home/自定义目录'] = { type: 'dir', children: [] };
  const second = seedFs(first);
  assert.equal(second['/home/README.txt'].text, '用户自己改过的内容');
  assert.ok(second['/home/自定义目录'], '用户自建目录必须保留');
});

test('fsinit: 不修改传入对象（返回新对象）', () => {
  const original = seedFs(null);
  const snapshot = canonical(original);
  const next = seedFs(original);
  assert.equal(canonical(original), snapshot, '入参 fs 被修改了');
  assert.notEqual(next, original, '应返回新对象');
  assert.notEqual(next['/home'], original['/home'], '节点也应是新的');
});

test('fsinit: 每个目录的 children 与其子路径一致', () => {
  const fs = seedFs(null);
  const paths = Object.keys(fs).filter((p) => p !== '/');
  for (const path of paths) {
    if (fs[path].type !== 'dir') continue;
    const expected = paths.filter((p) => parentPath(p) === path).sort();
    assert.deepEqual(fs[path].children.slice().sort(), expected, path + ' 的 children 不一致');
  }
  assert.deepEqual(fs['/'].children.slice().sort(), ['/home', '/system']);
});

test('fsinit: 没有孤儿节点（全部可从 / 到达）', () => {
  const fs = seedFs(null);
  const seen = new Set();
  const queue = ['/'];
  while (queue.length) {
    const cur = queue.shift();
    assert.ok(!seen.has(cur), '存在环：' + cur);
    seen.add(cur);
    const node = fs[cur];
    assert.ok(node, 'children 引用了不存在的路径：' + cur);
    for (const child of node.children || []) queue.push(child);
    if (node.type === 'file') assert.equal((node.children || []).length, 0, '文件不应有 children');
  }
  assert.equal(seen.size, Object.keys(fs).length, '存在孤立节点');
  for (const path of Object.keys(fs)) {
    if (path === '/') continue;
    const parent = parentPath(path);
    assert.ok(fs[parent], path + ' 的父目录不存在');
    assert.ok(fs[parent].children.includes(path), path + ' 未登记在父目录 children 中');
  }
});

test('fsinit: 目录/文件节点形状正确，mtime 为固定值', () => {
  const fs = seedFs(null);
  for (const path of EXPECTED_PATHS) {
    const node = fs[path];
    assert.ok(node, '缺少节点 ' + path);
    if (path === '/' || node.type === 'dir') {
      assert.equal(node.type, 'dir', path + ' 应为目录');
      assert.ok(Array.isArray(node.children), path + ' 的 children 应为数组');
    } else {
      assert.equal(node.type, 'file', path + ' 应为文件');
      assert.equal(typeof node.text, 'string', path + ' 的 text 应为字符串');
      assert.equal(node.mtime, DEFAULT_MTIME, path + ' 的 mtime 应为默认值');
      assert.ok(node.text.length > 0, path + ' 的内容不应为空');
    }
  }
});

test('fsinit: 文本内容为中文说明且包含关键路径提示', () => {
  const fs = seedFs(null);
  assert.ok(fs['/home/README.txt'].text.includes('phigrOS'));
  assert.match(fs['/home/README.txt'].text, /[\u4e00-\u9fff]/, 'README 应含中文');
  assert.ok(fs['/home/欢迎.md'].text.includes('# 欢迎来到 phigrOS'));
  assert.ok(fs['/home/Music/曲目说明.txt'].text.includes('First Light'));
  assert.ok(fs['/system/about.txt'].text.includes('1.0.0'));
});

test('fsinit: firstRun 选项被接受且语义不变（都只补缺）', () => {
  const a = seedFs(null, { firstRun: true });
  const b = seedFs(a, { firstRun: false });
  assert.equal(canonical(b), canonical(a));
  assert.ok(b['/home/Desktop'], '非首次启动也应补上缺失的 /home/Desktop');
});

test('fsinit: now / only 选项生效', () => {
  const fs = seedFs(null, { now: 42 });
  assert.equal(fs['/home/README.txt'].mtime, 42);
  const partial = seedFs(null, { only: ['/system'] });
  assert.ok(partial['/system'], 'only 命中的目录应被创建');
  assert.ok(!partial['/home/README.txt'], 'only 未命中的文件不应创建');
});

test('fsinit: 修剪孤儿节点与无效 children', () => {
  const broken = {
    '/': { type: 'dir', children: ['/home', '/不存在'] },
    '/home': { type: 'dir', children: ['/home/a.txt', '/也不存在'] },
    '/home/a.txt': { type: 'file', text: 'hi', mtime: 1 },
    '/nope/x.txt': { type: 'file', text: '父目录不存在', mtime: 1 },
    '/home/a.txt/y.txt': { type: 'file', text: '父节点是文件', mtime: 1 }
  };
  const fixed = normalizeFs(broken);
  assert.deepEqual(fixed['/'].children, ['/home']);
  assert.deepEqual(fixed['/home'].children, ['/home/a.txt']);
  assert.equal(fixed['/nope/x.txt'], undefined, '父目录不存在的节点应被修剪');
  assert.equal(fixed['/home/a.txt/y.txt'], undefined, '父节点为文件的节点应被修剪');
  assert.equal(fixed['/home/a.txt'].text, 'hi');
});

test('fsinit: 路径工具函数', () => {
  assert.equal(normalizePath('home//Music/'), '/home/Music');
  assert.equal(normalizePath('\\system\\'), '/system');
  assert.equal(normalizePath(''), '/');
  assert.equal(parentPath('/home/a.txt'), '/home');
  assert.equal(parentPath('/home'), '/');
  assert.equal(parentPath('/'), null);
  assert.equal(baseName('/home/a.txt'), 'a.txt');
  assert.equal(baseName('/'), '/');
});

// ======================= about.js =======================

test('about: 模块顶层不访问 window（能被 node 直接 import）', () => {
  assert.equal(typeof ACHIEVEMENTS.length, 'number');
});

test('about: ACHIEVEMENTS 数量 ≥ 8，字段齐全，id 唯一', () => {
  assert.ok(ACHIEVEMENTS.length >= 8, '成就定义应至少 8 个，实际 ' + ACHIEVEMENTS.length);
  const ids = new Set();
  for (const def of ACHIEVEMENTS) {
    assert.equal(typeof def.id, 'string');
    assert.ok(def.id.length > 0, 'id 不能为空');
    assert.ok(!ids.has(def.id), 'id 重复：' + def.id);
    ids.add(def.id);
    assert.equal(typeof def.title, 'string');
    assert.ok(def.title.length > 0, def.id + ' 缺少 title');
    assert.equal(typeof def.desc, 'string');
    assert.ok(def.desc.length > 0, def.id + ' 缺少 desc');
    assert.equal(typeof def.icon, 'string');
    assert.ok(def.icon.length > 0, def.id + ' 缺少 icon');
  }
});

test('about: 必需的 8 个成就 id 都存在', () => {
  const ids = ACHIEVEMENTS.map((a) => a.id);
  for (const need of [
    'boot',
    'first-play',
    'first-fc',
    'grade-s',
    'extra-clear',
    'play-10',
    'terminal-unlock',
    'theme-hue'
  ]) {
    assert.ok(ids.includes(need), '缺少成就 ' + need);
  }
});

test('about: achievementView 合并解锁状态', () => {
  const view = achievementView({ boot: { unlocked: true, at: 123 }, 'first-play': { unlocked: false } });
  assert.equal(view.length, ACHIEVEMENTS.length);
  const boot = view.find((v) => v.id === 'boot');
  assert.equal(boot.unlocked, true);
  assert.equal(boot.at, 123);
  const play = view.find((v) => v.id === 'first-play');
  assert.equal(play.unlocked, false);
  assert.equal(play.at, 0);
  const others = view.filter((v) => v.id !== 'boot' && v.id !== 'first-play');
  assert.ok(others.every((v) => v.unlocked === false), '未出现在状态里的成就应为未解锁');
});

test('about: achievementView 容错空状态', () => {
  assert.equal(achievementView(null).length, ACHIEVEMENTS.length);
  assert.equal(achievementView(undefined).every((v) => !v.unlocked), true);
  assert.equal(unlockedCount(null), 0);
  assert.equal(unlockedCount({ a: { unlocked: true }, b: { unlocked: false }, c: { unlocked: true } }), 2);
});

test('about: readVersion 默认值来自 window.PhigrOS', () => {
  assert.equal(readVersion({ PhigrOS: { version: '2.3.4' } }), '2.3.4');
  assert.equal(readVersion({}), '1.0.0');
  assert.equal(readVersion({ PhigrOS: { version: '' } }), '1.0.0');
  assert.equal(readVersion(null), '1.0.0');
});

test('about: formatDuration 与 describeUA 输出可读文本', () => {
  assert.equal(formatDuration(0), '—');
  assert.equal(formatDuration(-5), '—');
  assert.equal(formatDuration(320), '320 ms');
  assert.equal(formatDuration(1500), '1.50 s');
  assert.match(describeUA('Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36'), /Windows 10\/11/);
  assert.match(describeUA('Mozilla/5.0 (Windows NT 10.0) Chrome/131.0.0.0'), /Chrome 131/);
  assert.match(describeUA('Mozilla/5.0 (X11; Linux x86_64) Firefox/133.0'), /Firefox 133/);
  assert.equal(describeUA(''), '未知浏览器');
});

test('about: storageAvailable 容错', () => {
  assert.equal(storageAvailable(null), false);
  let store = {};
  const fake = {
    setItem: (k, v) => {
      store[k] = String(v);
    },
    getItem: (k) => (k in store ? store[k] : null),
    removeItem: (k) => {
      delete store[k];
    }
  };
  assert.equal(storageAvailable(fake), true);
  const throwing = {
    setItem() {
      throw new Error('quota');
    }
  };
  assert.equal(storageAvailable(throwing), false);
});

// ======================= settings.js =======================

test('settings: formatBytes 常见取值', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-1), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1024), '1.00 KB');
  assert.equal(formatBytes(1536), '1.50 KB');
  assert.equal(formatBytes(1024 * 1024), '1.00 MB');
  assert.equal(formatBytes(1024 * 1024 * 1.5), '1.50 MB');
  assert.equal(formatBytes(NaN), '0 B');
});

test('settings: clampNumber 夹取与 NaN 回落', () => {
  assert.equal(clampNumber(5, 0, 10), 5);
  assert.equal(clampNumber(-5, 0, 10), 0);
  assert.equal(clampNumber(15, 0, 10), 10);
  assert.equal(clampNumber('abc', 2, 10), 2);
  assert.equal(clampNumber('7', 0, 10), 7);
});

test('settings: 展示格式化函数', () => {
  assert.equal(formatVolume(0.8), '80%');
  assert.equal(formatVolume(2), '100%');
  assert.equal(formatHue(190.4), '190°');
  assert.equal(formatSpeed(1), '1.00×');
  assert.equal(formatSpeed(0.1), '0.50×');
  assert.equal(formatOffset(0), '0 ms');
  assert.equal(formatOffset(25), '+25 ms');
  assert.equal(formatOffset(-300), '-200 ms');
});

test('settings: 常量表与契约一致', () => {
  assert.deepEqual(
    WALLPAPER_KINDS.map((k) => k.id),
    ['aurora', 'grid', 'solid']
  );
  assert.deepEqual(SFX_NAMES, ['click', 'open', 'ok', 'error']);
});

test('settings: estimateLocalStorageBytes 估算 UTF-16 字节数', () => {
  const data = new Map([
    ['phigros-os', 'abc'],
    ['k', '12']
  ]);
  const fake = {
    get length() {
      return data.size;
    },
    key(i) {
      return Array.from(data.keys())[i];
    },
    getItem(k) {
      return data.has(k) ? data.get(k) : null;
    }
  };
  // ('phigros-os'=10 + 'abc'=3) * 2 + ('k'=1 + '12'=2) * 2 = 26 + 6 = 32
  assert.equal(estimateLocalStorageBytes(fake), 32);
  assert.equal(estimateLocalStorageBytes(null), 0);
  assert.equal(
    estimateLocalStorageBytes({
      get length() {
        throw new Error('blocked');
      }
    }),
    0
  );
});

// ======================= notes.js =======================

test('notes: countText 统计字符/行/中文', () => {
  assert.deepEqual(countText(''), { chars: 0, lines: 1, cjk: 0 });
  assert.deepEqual(countText('abc'), { chars: 3, lines: 1, cjk: 0 });
  assert.deepEqual(countText('a\nb\nc'), { chars: 5, lines: 3, cjk: 0 });
  assert.deepEqual(countText('你好abc'), { chars: 5, lines: 1, cjk: 2 });
  assert.equal(countText(null).chars, 0);
});

test('notes: formatClock 与 joinPath', () => {
  assert.equal(formatClock(new Date(2024, 0, 2, 3, 4, 5)), '03:04:05');
  assert.equal(formatClock(NaN), '--:--:--');
  assert.equal(notesJoin('/', 'a.txt'), '/a.txt');
  assert.equal(notesJoin('/home/', '/b.txt'), '/home/b.txt');
  assert.equal(notesJoin('/home', ''), '/home');
});

// ======================= manifest.js =======================

test('manifest: 可被 node import，id 唯一且顺序符合开始菜单', () => {
  assert.ok(Array.isArray(manifest));
  assert.deepEqual(manifest.map((a) => a.id), ['terminal', 'phigros', 'files', 'notes', 'settings', 'about']);
  assert.deepEqual(MANIFEST_IDS, ['terminal', 'phigros', 'files', 'notes', 'settings', 'about']);
  const ids = new Set(MANIFEST_IDS);
  assert.equal(ids.size, MANIFEST_IDS.length, '清单 id 重复');
});

test('manifest: 每项元信息齐全；惰性项带 loader，静态项带 mount', () => {
  for (const app of manifest) {
    assert.equal(typeof app.id, 'string');
    assert.equal(typeof app.name, 'string');
    assert.equal(typeof app.icon, 'string');
    assert.equal(typeof app.desc, 'string');
  }
  const terminal = findApp('terminal');
  const phigros = findApp('phigros');
  assert.equal(typeof terminal.loader, 'function');
  assert.equal(typeof phigros.loader, 'function');
  for (const id of ['files', 'notes', 'settings', 'about']) {
    const app = findApp(id);
    assert.equal(typeof app.mount, 'function', id + ' 应有 mount');
    assert.equal(app.loader, undefined, id + ' 不应是惰性项');
  }
  assert.equal(findApp('nope'), null);
});

test('manifest: 静态应用模块形状符合 CONTRACT §5', () => {
  for (const id of ['files', 'notes', 'settings', 'about']) {
    const app = findApp(id);
    assert.equal(app.id, id);
    assert.equal(typeof app.width, 'number');
    assert.equal(typeof app.height, 'number');
    assert.equal(typeof app.singleton, 'boolean');
  }
  assert.equal(findApp('settings').singleton, true);
  assert.equal(findApp('about').singleton, true);
  assert.equal(findApp('files').singleton, false);
  assert.equal(findApp('notes').singleton, false);
});

// ======================= 汇总 =======================

console.log('');
console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
