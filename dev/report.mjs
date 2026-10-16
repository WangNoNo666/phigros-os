/**
 * phigrOS · dev/report.mjs
 * 读取并美化浏览器验收台回传的报告（dev/last-report.json）。
 * 用法：node dev/report.mjs
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const file = resolve(ROOT, 'dev/last-report.json');

if (!existsSync(file)) {
  console.log('还没有报告。请先在浏览器打开 http://127.0.0.1:4173/dev/verify.html');
  process.exit(1);
}

const r = JSON.parse(readFileSync(file, 'utf8'));
const ICON = { pass: '[PASS]', fail: '[FAIL]', skip: '[SKIP]', pending: '[ -- ]', run: '[ .. ]' };

console.log(`phigrOS 浏览器验收报告 · ${r.finishedAt}`);
console.log(`UA: ${r.ua}`);
console.log(`meta: ${r.meta}`);
if (r.frameStats) {
  const f = r.frameStats;
  console.log(`帧率实测: ${f.fps} fps（平均帧 ${f.avg}ms，p95 ${f.p95}ms，最长 ${f.worst}ms，采样 ${f.frames} 帧，引擎自报 ${f.gameFps} fps）`);
  if (f.telemetry) {
    const t = f.telemetry;
    console.log(
      `引擎遥测: 平均帧 ${t.avgFrameMs}ms / 最长帧 ${t.maxFrameMs}ms / 单帧工作 ${t.avgWorkMs}ms / >200ms 停顿 ${t.stallsOver200ms} 次 / 驱动=${t.loop} / 可见性=${t.visible}`
    );
  }
  if (f.escalated) console.log(`已触发 rAF 节流兜底（切换为定时器驱动）: ${JSON.stringify(f.escalated)}`);
}
console.log(`汇总: ${r.summary.pass} 通过 / ${r.summary.fail} 失败 / ${r.summary.skipped} 跳过 (共 ${r.summary.total})`);console.log('─'.repeat(96));
for (const c of r.checks) {
  console.log(`${ICON[c.status] || '[????]'} ${c.label}${c.detail ? `\n         ${c.detail}` : ''}`);
}
console.log('─'.repeat(96));
if (r.errors && r.errors.length) {
  console.log('页面错误:');
  for (const e of r.errors.slice(0, 12)) console.log(`  - ${e}`);
} else {
  console.log('页面错误: 无');
}
if (r.console && r.console.length) {
  console.log('页面 console（末尾 12 条）:');
  for (const l of r.console.slice(-12)) console.log(`  · ${l}`);
}
process.exit(r.summary.fail === 0 ? 0 : 1);
