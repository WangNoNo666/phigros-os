/**
 * phigrOS · dev/cdp-probe.mjs
 * 用 headful（有头）Edge + CDP 自己驱动诊断页：读取真实帧率遥测并打印。
 * 之前 headless 模式在本机无法创建渲染进程，headful 可以。
 *
 * 用法：node dev/cdp-probe.mjs [--url=...] [--seconds=45] [--headless]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const args = process.argv.slice(2);
const argOf = (n, d) => {
  const hit = args.find((a) => a.startsWith(`--${n}=`));
  return hit ? hit.slice(n.length + 3) : d;
};
const URL_ = argOf('url', 'http://127.0.0.1:4173/dev/fps-diag.html');
const SECONDS = Number(argOf('seconds', '60'));
const HEADLESS = args.includes('--headless');
const PORT = 9500 + Math.floor(Math.random() * 300);
const OUT = resolve(ROOT, 'dev/shots');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
];
const bin = BROWSERS.find(existsSync);
if (!bin) {
  console.error('未找到浏览器');
  process.exit(2);
}

const profile = join(process.env.TEMP || '.', `phigros-cdp-${Date.now()}`);
const proc = spawn(bin, [
  ...(HEADLESS ? ['--headless=new'] : []),
  '--no-first-run', '--no-default-browser-check', '--disable-extensions',
  '--autoplay-policy=no-user-gesture-required', '--mute-audio',
  '--window-size=1500,1000', '--window-position=40,40',
  `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, 'about:blank'
], { stdio: 'ignore' });

const getJson = (path) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port: PORT, path }, (r) => {
    let b = '';
    r.on('data', (c) => (b += c));
    r.on('end', () => {
      try { res(JSON.parse(b)); } catch (e) { rej(e); }
    });
  }).on('error', rej);
});

let targets = null;
for (let i = 0; i < 60; i++) {
  try { targets = await getJson('/json/list'); if (targets && targets.length) break; } catch { /* 等 */ }
  await sleep(300);
}
if (!targets) {
  console.error('浏览器未启动调试端口');
  proc.kill();
  process.exit(2);
}

const page = targets.find((t) => t.type === 'page') || targets[0];
console.log(`[probe] 目标: ${page.url}`);

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', () => rej(new Error('WS 连接失败')), { once: true });
});

let idSeq = 0;
const pending = new Map();
const events = [];
ws.addEventListener('message', (ev) => {
  let msg = null;
  try { msg = JSON.parse(ev.data); } catch { return; }
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Runtime.exceptionThrown') {
    const text = msg.method === 'Runtime.exceptionThrown'
      ? `EXC ${msg.params.exceptionDetails && (msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text)}`
      : `LOG ${(msg.params.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ')}`;
    events.push(text);
  }
});

const send = (method, params = {}) => new Promise((res, rej) => {
  const id = ++idSeq;
  pending.set(id, { resolve: res, reject: rej });
  ws.send(JSON.stringify({ id, method, params }));
  setTimeout(() => {
    if (pending.has(id)) { pending.delete(id); rej(new Error(`CDP 超时 ${method}`)); }
  }, 25000);
});

try {
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  console.log('[probe] CDP 域已启用（页面级命令可用）');
} catch (err) {
  console.error('[probe] CDP 初始化失败:', err.message);
  ws.close();
  proc.kill();
  process.exit(3);
}

const evalJs = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(() => { ${expr} })()`, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};

console.log(`[probe] 打开 ${URL_}`);
await send('Page.navigate', { url: URL_ });

const deadline = Date.now() + SECONDS * 1000;
let last = null;
while (Date.now() < deadline) {
  await sleep(2000);
  try {
    const snap = await evalJs(`
      const el = document.getElementById('raw');
      const v = document.getElementById('verdict');
      return { verdict: v ? v.textContent : '', raw: el ? el.textContent : '', note: (document.getElementById('note')||{}).textContent || '' };
    `);
    if (snap.raw) {
      last = snap;
      if (snap.verdict && !/测量中/.test(snap.verdict)) break;
    }
  } catch (err) {
    console.log('[probe] 读取状态失败:', err.message);
  }
}

// 截图
try {
  mkdirSync(OUT, { recursive: true });
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(join(OUT, 'fps-diag.png'), Buffer.from(shot.data, 'base64'));
  console.log(`[probe] 截图: ${join(OUT, 'fps-diag.png')}`);
} catch (err) {
  console.log('[probe] 截图失败:', err.message);
}

console.log('\n===== 诊断结果 =====');
if (last) {
  console.log('判定:', last.verdict);
  try {
    const raw = JSON.parse(last.raw);
    console.log(JSON.stringify(raw, null, 2));
  } catch {
    console.log(last.raw);
  }
} else {
  console.log('（未取到诊断结果）');
}
if (events.length) {
  console.log('\n--- 页面事件（末尾 25 条）---');
  for (const e of events.slice(-25)) console.log(' ', e);
}
console.log(`\n[probe] 浏览器 PID=${proc.pid} 将关闭`);
ws.close();
proc.kill();
await sleep(400);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* 忽略 */ }
process.exit(0);
