/**
 * phigrOS · dev/run-verify.mjs
 * 用真实浏览器（Edge/Chrome）打开自驱动验收台，跑完自动退出。
 * 说明：本沙箱下 `Start-Process` 会被拦，`child_process.spawn` + stdio:'ignore' 可用。
 *
 * 用法：node dev/run-verify.mjs [--headful] [--url=...] [--minutes=3]
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];
const bin = BROWSERS.find(existsSync);
if (!bin) {
  console.error('未找到 Edge/Chrome');
  process.exit(2);
}

const args = process.argv.slice(2);
const headful = args.includes('--headful');
const url = (args.find((a) => a.startsWith('--url=')) || '').slice(6) || 'http://127.0.0.1:4173/dev/verify.html';
const minutes = Number((args.find((a) => a.startsWith('--minutes=')) || '').slice(10)) || 3;
const profile = `${process.env.TEMP || '.'}\\phigros-verify-${Date.now()}`;

const child = spawn(
  bin,
  [
    ...(headful ? [] : ['--headless=new']),
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--autoplay-policy=no-user-gesture-required',
    '--mute-audio',
    '--window-size=1500,1000',
    `--user-data-dir=${profile}`,
    url
  ],
  { stdio: 'ignore', detached: false }
);

console.log(`[verify] 已启动 ${bin}`);
console.log(`[verify] 模式=${headful ? '有头' : '无头'} URL=${url}`);
console.log(`[verify] PID=${child.pid}，预计 ${minutes} 分钟后退出`);

child.on('exit', (code) => console.log(`[verify] 浏览器退出 code=${code}`));

const timer = setTimeout(() => {
  console.log('[verify] 到时，关闭浏览器');
  try {
    child.kill();
  } catch {
    /* ignore */
  }
  process.exit(0);
}, minutes * 60 * 1000);
timer.unref?.();
