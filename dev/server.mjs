/**
 * phigrOS · dev/server.mjs
 * 零依赖静态服务器（ES Module 需要 http 协议，不能直接 file:// 打开）。
 *
 * 用法：node dev/server.mjs [port]
 */
import http from 'node:http';
import { createReadStream, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const PORT = Number(process.argv[2] || process.env.PORT || 4173);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

const VERBOSE = process.argv.includes('--verbose') || process.env.PHIGROS_LOG === '1';

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);

  if (req.method === 'POST' && urlPath === '/__heartbeat') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      console.log(`[phigrOS] 心跳: ${body.slice(0, 400)}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    });
    return;
  }

  // 验收台上报端点：把浏览器里的自测结果写到 dev/last-report.json
  if (req.method === 'POST' && urlPath === '/__report') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 4_000_000) req.destroy();
    });
    req.on('end', () => {
      const file = join(ROOT, 'dev', 'last-report.json');
      try {
        writeFileSync(file, body, 'utf8');
        console.log(`[phigrOS] 收到验收报告 ${body.length} 字节 -> dev/last-report.json`);
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      } catch (err) {
        res.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: String(err) }));
      }
    });
    return;
  }

  let target = normalize(join(ROOT, urlPath));
  if (VERBOSE) console.log(`[phigrOS] ${req.method} ${urlPath}`);
  if (!target.startsWith(ROOT)) {
    res.writeHead(403).end('403 Forbidden');
    return;
  }
  try {
    const st = statSync(target);
    if (st.isDirectory()) target = join(target, 'index.html');
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`404 Not Found: ${urlPath}`);
    return;
  }
  let st;
  try {
    st = statSync(target);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end(`404 Not Found: ${urlPath}`);
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'content-length': st.size,
    // 强失效：开发期改动必须立刻生效，绝不能吃到旧 JS（否则会跑到已经修掉的 bug 上）
    'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
    pragma: 'no-cache',
    expires: '0',
    vary: '*'
  });
  createReadStream(target).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[phigrOS] 静态服务器已启动： http://127.0.0.1:${PORT}/`);
  console.log(`[phigrOS] 根目录： ${ROOT}`);
});
