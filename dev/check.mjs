/**
 * phigrOS · dev/check.mjs
 * 语法与策略自检。使用 vm.SourceTextModule 在进程内解析 ES Module，
 * 不 spawn 子进程（沙箱下管道 stdio 不可用）。
 *
 * 用法：node --experimental-vm-modules dev/check.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const SKIP_DIRS = new Set(['node_modules', '.git', 'shots', 'dev/shots']);
const USE_VM = typeof vm.SourceTextModule === 'function';

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else if (['.js', '.mjs'].includes(extname(entry))) out.push(full);
  }
  return out;
}

const files = walk(ROOT).sort();
const results = [];
let failed = 0;

function ok(line) {
  results.push(line);
}
function fail(line) {
  results.push(line);
  failed += 1;
}

// ---------- 1. ESM 语法解析 ----------
if (!USE_VM) {
  fail('FAIL setup :: 需要以 `node --experimental-vm-modules dev/check.mjs` 运行才能做 ESM 语法解析');
} else {
  const context = vm.createContext({ console });
  for (const file of files) {
    const rel = relative(ROOT, file).replace(/\\/g, '/');
    const source = readFileSync(file, 'utf8');
    try {
      // 只解析、不执行；无 import 的模块可直接 instantiate
      // eslint-disable-next-line no-new
      new vm.SourceTextModule(source, { identifier: rel, context });
      ok(`PASS syntax ${rel}`);
    } catch (err) {
      const msg = String(err && err.message ? err.message : err).split('\n').slice(0, 3).join(' | ');
      fail(`FAIL syntax ${rel} :: ${msg}`);
    }
  }
}

// ---------- 2. 结构约束 ----------
const constraints = [
  ['index.html', (t) => t.includes('type="module"') && t.includes('./boot.js'), 'index.html 引入 boot.js (module)'],
  [
    'index.html',
    (t) => ['boot', 'windows', 'taskbar', 'toasts', 'modals', 'desktop', 'start-menu'].every((id) => t.includes(`id="${id}"`)),
    'index.html 关键容器齐全'
  ],
  ['boot.js', (t) => t.includes('window.PhigrOS'), 'boot.js 暴露 window.PhigrOS'],
  ['js/core/state.js', (t) => t.includes('export const store'), 'state.js 导出单例 store'],
  ['js/core/state.js', (t) => t.includes('subscribe('), 'state.js 提供 subscribe'],
  ['js/core/host.js', (t) => t.includes('createHost'), 'host.js 导出 createHost'],
  ['js/core/kernel.js', (t) => t.includes('createKernel'), 'kernel.js 导出 createKernel'],
  ['js/apps/manifest.js', (t) => t.includes('export default'), 'manifest.js 默认导出应用数组']
];

for (const [rel, test, label] of constraints) {
  let text = '';
  try {
    text = readFileSync(join(ROOT, rel), 'utf8');
  } catch {
    fail(`FAIL constraint ${label} :: 文件缺失 (${rel})`);
    continue;
  }
  if (test(text)) ok(`PASS constraint ${label}`);
  else fail(`FAIL constraint ${label}`);
}

// ---------- 3. 策略检查 ----------
const POLICY = [
  [/https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+/i, '禁止引用外部 URL'],
  [/(?<![\w.$])eval\s*\(/, '禁止使用 eval'],
  [/new\s+Function\s*\(/, '禁止 new Function'],
  [/document\.write\s*\(/, '禁止 document.write']
];

for (const file of files) {
  const rel = relative(ROOT, file).replace(/\\/g, '/');
  const text = readFileSync(file, 'utf8');
  // dev/ 下是开发工具，允许使用 eval 字样的标识符
  if (!rel.startsWith('dev/')) {
    for (const [re, label] of POLICY) {
      const m = text.match(re);
      if (m) fail(`FAIL policy ${rel} :: ${label} -> ${m[0].slice(0, 60)}`);
    }
  }
  // 谱面生成必须确定性
  if (rel.includes('chartgen') && /Math\.random\s*\(/.test(text)) {
    fail(`FAIL policy ${rel} :: 谱面生成禁止使用 Math.random（必须确定性）`);
  }
  // 顶层直接访问 DOM/浏览器模块无法在 node 下被测试
  // （state.js 是纯工具模块，允许 typeof 探测；window.X = v 是合法的全局导出）
  if (/^js\/(core|engine)\//.test(rel) && !/^js\/core\/state\.js$/.test(rel)) {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!/^(document|window|localStorage|AudioContext)\s*\./.test(line)) continue;
      if (/^(document|window|localStorage|AudioContext)\s*\.[\w$]+\s*=[^=]/.test(line)) continue; // 全局导出
      fail(`FAIL policy ${rel}:${i + 1} :: 顶层不得直接访问浏览器全局对象`);
      break;
    }
  }
}

// ---------- 4. 交付清单 ----------
const REQUIRED = [
  'index.html',
  'boot.js',
  'styles/shell.css',
  'js/core/state.js',
  'js/core/kernel.js',
  'js/core/host.js',
  'js/core/compositor.js',
  'js/core/palette.js',
  'js/shell/wm.js',
  'js/shell/taskbar.js',
  'js/engine/audio.js',
  'js/engine/phigros.js',
  'js/engine/chartgen.js',
  'js/apps/manifest.js',
  'js/apps/phigros.js',
  'js/apps/terminal.js',
  'js/apps/files.js',
  'js/apps/notes.js',
  'js/apps/settings.js',
  'js/apps/about.js',
  'js/apps/fsinit.js',
  'data/charts/first-light.js',
  'data/charts/neon-runner.js',
  'data/charts/void-cathedral.js',
  'tests/test-engine-judge.mjs',
  'tests/test-engine-charts.mjs',
  'tests/test-engine-frame.mjs',
  'tests/test-shell-wm.mjs',
  'tests/test-apps-sysapps.mjs',
  'tests/test-core-state.mjs',
  'tests/test-core-boot.mjs',
  'tests/test-core-raf.mjs',
  'dev/server.mjs',
  'dev/verify.html',
  'README.md'
];
const missing = REQUIRED.filter((rel) => {
  try {
    statSync(join(ROOT, rel));
    return false;
  } catch {
    return true;
  }
});
if (missing.length === 0) ok(`PASS inventory 全部 ${REQUIRED.length} 个交付文件存在`);
else fail(`FAIL inventory 缺失 ${missing.length} 个文件 :: ${missing.join(', ')}`);

for (const line of results) console.log(line);
console.log(`RESULT: ${results.length - failed} passed, ${failed} failed (${files.length} 个脚本文件)`);
process.exit(failed === 0 ? 0 : 1);
