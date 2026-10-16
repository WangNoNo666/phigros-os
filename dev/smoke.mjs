/**
 * phigrOS · dev/smoke.mjs
 * 真实浏览器冒烟测试：启动 Edge/Chrome headless + CDP，
 * 走完「开机 → 桌面 → 终端 → 音游 → 判定 → 结算 → 存档」全流程，
 * 抓取 console error / 未捕获异常，并输出截图。
 *
 * 用法：node dev/smoke.mjs [--url=...] [--out=dev/shots] [--headful]
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));

const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};
const URL_ = argOf('url', 'http://127.0.0.1:4173/');
const OUT = resolve(ROOT, argOf('out', 'dev/shots'));
const HEADFUL = args.includes('--headful');
const PORT = 9333 + Math.floor(Math.random() * 400);

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
];

function findBrowser() {
  for (const p of BROWSERS) if (existsSync(p)) return p;
  throw new Error('未找到 Edge/Chrome 可执行文件');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(path) {
  return new Promise((resolvePromise, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          resolvePromise(JSON.parse(body));
        } catch (err) {
          reject(err);
        }
      });
    });
    req.on('error', reject);
  });
}

/** 极简 CDP 客户端（Node 内置 WebSocket） */
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.listeners = new Map();
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data || '')})`));
          else p.resolve(msg.result);
        }
        return;
      }
      const set = this.listeners.get(msg.method);
      if (set) for (const fn of set) fn(msg.params);
    });
  }

  on(method, fn) {
    if (!this.listeners.has(method)) this.listeners.set(method, new Set());
    this.listeners.get(method).add(fn);
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时: ${method}`));
        }
      }, 30000);
    });
  }

  /** 在页面里执行表达式并返回 JSON 结果 */
  async eval(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression: `(() => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(`页面异常: ${res.exceptionDetails.text} ${res.exceptionDetails.exception?.description || ''}`);
    }
    return res.result.value;
  }
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  const browser = findBrowser();
  const profile = join(OUT, `.profile-${process.pid}`);
  const logs = [];
  const errors = [];

  const proc = spawn(
    browser,
    [
      ...(HEADFUL ? [] : ['--headless=new']),
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--mute-audio',
      '--autoplay-policy=no-user-gesture-required',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      '--window-size=1440,900',
      'about:blank'
    ],
    { stdio: 'ignore', detached: false }
  );

  let targets = null;
  for (let i = 0; i < 60; i++) {
    try {
      targets = await fetchJson('/json/list');
      if (targets && targets.length) break;
    } catch {
      /* 还没起来 */
    }
    await sleep(250);
  }
  if (!targets) {
    proc.kill();
    throw new Error('浏览器未能在 15 秒内启动调试端口');
  }

  const page = targets.find((t) => t.type === 'page') || targets[0];
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const cdp = new CDP(ws);

  cdp.on('Runtime.consoleAPICalled', (p) => {
    const text = (p.args || []).map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[${p.type}] ${text}`);
    if (p.type === 'error') errors.push(`console.error: ${text}`);
  });
  cdp.on('Runtime.exceptionThrown', (p) => {
    errors.push(`exception: ${p.exceptionDetails?.exception?.description || p.exceptionDetails?.text}`);
  });
  cdp.on('Log.entryAdded', (p) => {
    const e = p.entry;
    logs.push(`[log:${e.level}] ${e.text}`);
    if (e.level === 'error') errors.push(`log.error: ${e.text}`);
  });

  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  await cdp.send('Network.enable');

  const shot = async (name) => {
    try {
      const { data } = await cdp.send('Page.captureScreenshot', { format: 'png' });
      writeFileSync(join(OUT, `${name}.png`), Buffer.from(data, 'base64'));
    } catch (err) {
      logs.push(`[warn] 截图失败 ${name}: ${err.message}`);
    }
  };

  const checks = [];
  const check = (name, ok, detail = '') => {
    checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  };

  // ---------- 1. 打开页面 ----------
  await cdp.send('Page.navigate', { url: URL_ });
  await sleep(600);
  await shot('01-boot');
  // 等开机完成
  const booted = await waitFor(cdp, `return Boolean(window.PhigrOS && window.PhigrOS.bootMs);`, 20000);
  check('开机完成（window.PhigrOS.bootMs 存在）', booted, booted ? '' : '20 秒内未完成开机');
  await sleep(700);
  await shot('02-desktop');

  const info = await cdp.eval(`
    const s = window.PhigrOS.state.get();
    return {
      version: window.PhigrOS.version,
      bootMs: window.PhigrOS.bootMs,
      apps: window.Host.apps().map(a => a.id),
      appCount: window.Host.apps().length,
      bootHidden: document.getElementById('boot').classList.contains('hidden'),
      desktopReady: document.getElementById('desktop').classList.contains('desktop-ready'),
      desktopIcons: document.querySelectorAll('#desktop-icons .dicon').length,
      fsPaths: Object.keys(s.fs).length,
      taskbar: Boolean(document.querySelector('.tb-start')),
      clock: (document.querySelector('.tb-clock') || {}).textContent || ''
    };
  `);
  check('内核版本号', info.version === '1.0.0', info.version);
  check('桌面就绪 class', info.desktopReady);
  check('开机屏已隐藏', info.bootHidden);
  check('桌面图标渲染', info.desktopIcons >= 4, `${info.desktopIcons} 个`);
  check('任务栏渲染（开始按钮 + 时钟）', info.taskbar && /\d{1,2}:\d{2}/.test(info.clock), info.clock);
  check('应用清单登记', info.appCount >= 5, info.apps.join(','));
  check('初始文件系统已播种', info.fsPaths >= 6, `${info.fsPaths} 个节点`);

  // ---------- 2. 开始菜单 + 终端 ----------
  await cdp.eval(`document.querySelector('.tb-start').click(); return 1;`);
  await sleep(260);
  const menuOpen = await cdp.eval(`return document.getElementById('start-menu').classList.contains('open');`);
  check('开始菜单可打开', menuOpen);
  await shot('03-startmenu');

  const winBefore = await cdp.eval(`return window.Host.wm.list().length;`);
  await cdp.eval(`
    const items = [...document.querySelectorAll('#start-list .start-item')];
    const t = items.find(i => i.textContent.includes('终端'));
    if (t) t.click();
    return Boolean(t);
  `);
  await sleep(700);
  const termWin = await cdp.eval(`
    const list = window.Host.wm.list();
    const w = list.find(x => x.appId === 'terminal');
    return { count: list.length, hasTerm: Boolean(w), focused: window.Host.wm.focused(), id: w && w.id };
  `);
  check('终端窗口已打开', termWin.count > winBefore && termWin.hasTerm, JSON.stringify(termWin));
  check('焦点在终端', termWin.focused === termWin.id, `${termWin.focused} vs ${termWin.id}`);

  // 终端跑几条命令
  await cdp.eval(`
    const inp = document.querySelector('.terminal-app .term-input');
    const fire = (v) => {
      inp.value = v;
      inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    };
    fire('sysinfo'); fire('ls /home'); fire('theme 265'); fire('help');
    return inp.value;
  `);
  await sleep(500);
  const termOut = await cdp.eval(`return document.querySelector('.terminal-app .term-out').textContent;`);
  check('终端可执行命令（sysinfo/ls/theme/help）',
    termOut.includes('phigrOS Shell') && termOut.includes('分辨率') && termOut.includes('help'),
    `${termOut.length} 字符`);
  const hueAfter = await cdp.eval(`return window.Host.store.get().settings.themeHue;`);
  check('终端 theme 命令生效', hueAfter === 265, String(hueAfter));
  const termAch = await cdp.eval(`return Boolean(window.Host.store.get().achievements['terminal-unlock']);`);
  check('成就 terminal-unlock 解锁', termAch);
  await shot('04-terminal');

  // ---------- 3. 音游 ----------
  const appMeta = await cdp.eval(`
    return window.Host.appMeta('phigros') ? { ok: true, meta: window.Host.appMeta('phigros') } : { ok: false };
  `);
  check('phigros 应用已登记', appMeta.ok, JSON.stringify(appMeta.meta || {}));

  const launched = await cdp.eval(`return window.Host.launch('phigros');`);
  check('启动音游返回 windowId', Boolean(launched), String(launched));

  // 等待选曲界面出现（工程队会用 .phigros-* class）
  const selectReady = await waitFor(
    cdp,
    `const w = document.querySelector('.win[data-app-id="phigros"]');
     if (!w) return false;
     return Boolean(w.querySelector('[data-track]')) || /选曲|曲目|Phigros/.test(w.textContent);`,
    15000
  );
  check('音游选曲界面渲染', selectReady, selectReady ? '' : '未找到曲目卡片');
  await shot('05-phigros-select');

  const tracks = await cdp.eval(`
    const w = document.querySelector('.win[data-app-id="phigros"]');
    const cards = [...w.querySelectorAll('[data-track]')];
    return { count: cards.length, ids: cards.map(c => c.dataset.track), text: w.textContent.slice(0, 200) };
  `);
  check('至少 3 首曲目', tracks.count >= 3, tracks.ids.join(','));

  // 进入第一首
  await cdp.eval(`
    const w = document.querySelector('.win[data-app-id="phigros"]');
    const card = w.querySelector('[data-track]');
    card.click();
    return 1;
  `);
  await sleep(800);
  await shot('06-phigros-detail');

  // 点「开始」按钮
  const started = await cdp.eval(`
    const w = document.querySelector('.win[data-app-id="phigros"]');
    const btns = [...w.querySelectorAll('button')];
    const b = btns.find(x => /开始|游玩|START|Play/i.test(x.textContent));
    if (!b) return { ok: false, text: w.textContent.slice(0, 300) };
    b.click();
    return { ok: true, label: b.textContent };
  `);
  check('能够点击开始游玩', started.ok, started.ok ? started.label : started.text);

  // 等待进入游玩态（出现 canvas）
  const canvasReady = await waitFor(
    cdp,
    `const w = document.querySelector('.win[data-app-id="phigros"]');
     return Boolean(w && w.querySelector('canvas'));`,
    15000
  );
  check('音游 canvas 已创建', canvasReady);
  await sleep(2500);
  await shot('07-phigros-play');

  const engineInfo = await cdp.eval(`
    const w = document.querySelector('.win[data-app-id="phigros"]');
    const c = w.querySelector('canvas');
    return { w: c.width, h: c.height, phase: window.__PHIGROS_GAME_STATE__ || null };
  `);
  check('canvas 尺寸有效', engineInfo.w > 100 && engineInfo.h > 100, `${engineInfo.w}x${engineInfo.h}`);

  // 用真实按键打谱（间隔 120ms 轮换 4 键，尽量命中）
  await cdp.eval(`
    const w = document.querySelector('.win[data-app-id="phigros"]');
    const keys = ['d','f','j','k'];
    window.__smokeKeys = 0;
    window.__smokeTimer = setInterval(() => {
      const k = keys[window.__smokeKeys++ % 4];
      for (const type of ['keydown','keyup']) {
        w.dispatchEvent(new KeyboardEvent(type, { key: k, code: 'Key' + k.toUpperCase(), bubbles: true }));
        document.dispatchEvent(new KeyboardEvent(type, { key: k, code: 'Key' + k.toUpperCase(), bubbles: true }));
      }
    }, 110);
    return 1;
  `);
  await sleep(6000);
  await cdp.eval(`clearInterval(window.__smokeTimer); return 1;`);
  const midPlay = await cdp.eval(`
    const w = document.querySelector('.win[data-app-id="phigros"]');
    return { text: w.textContent.slice(0, 400), paused: /暂停|继续/.test(w.textContent) };
  `);
  logs.push(`[play] 画面文本：${midPlay.text.replace(/\s+/g, ' ').slice(0, 200)}`);

  // 直接跳到结算：用引擎暴露的调试句柄（若存在）
  const ended = await cdp.eval(`
    if (window.__PHIGROS_GAME__ && typeof window.__PHIGROS_GAME__.finish === 'function') {
      window.__PHIGROS_GAME__.finish();
      return 'finish()';
    }
    if (window.__PHIGROS_GAME__ && typeof window.__PHIGROS_GAME__.seekToEnd === 'function') {
      window.__PHIGROS_GAME__.seekToEnd();
      return 'seekToEnd()';
    }
    return 'none';
  `);
  logs.push(`[play] 结算触发方式：${ended}`);
  await sleep(3500);
  await shot('08-phigros-result');

  const result = await cdp.eval(`
    const s = window.Host.store.get();
    const rec = s.player.record || {};
    const ids = Object.keys(rec);
    return {
      totalPlay: s.player.totalPlay,
      rks: s.player.rks,
      tracks: ids,
      record: ids.length ? rec[ids[0]] : null,
      achievements: Object.keys(s.achievements || {}),
      text: (document.querySelector('.win[data-app-id="phigros"]') || {}).textContent.slice(0, 500)
    };
  `);
  check('成绩已写入 player.record', result.tracks.length > 0, JSON.stringify(result.record));
  check('player.totalPlay 已累加', result.totalPlay >= 1, String(result.totalPlay));
  check('解锁了音游相关成就', result.achievements.length >= 2, result.achievements.join(','));
  check('结算界面可读', /分数|准确|评级|PERFECT/i.test(result.text || ''), (result.text || '').replace(/\s+/g, ' ').slice(0, 160));

  // ---------- 4. 窗口管理 ----------
  const wmTest = await cdp.eval(`
    const list = window.Host.wm.list();
    const target = list[0];
    const before = { z: target.z, focused: window.Host.wm.focused() };
    // 关掉一个窗口
    window.Host.wm.close(target.id);
    const after = window.Host.wm.list();
    return { before, closed: !after.some(w => w.id === target.id), remaining: after.length };
  `);
  check('Host.wm.close 生效', wmTest.closed, JSON.stringify(wmTest));

  const persist = await cdp.eval(`
    const raw = localStorage.getItem('phigros-os:state:v1');
    if (!raw) return { ok: false };
    const parsed = JSON.parse(raw);
    return { ok: true, hasRecord: Object.keys(parsed.player.record || {}).length > 0 || parsed.player.totalPlay > 0, boot: parsed.boot.bootCount };
  `);
  check('状态已持久化到 localStorage', persist.ok, JSON.stringify(persist));

  // ---------- 5. 文件管理器 / 设置 ----------
  await cdp.eval(`window.Host.launch('files'); return 1;`);
  await sleep(900);
  const filesWin = await cdp.eval(`
    const w = document.querySelector('.win[data-app-id="files"]');
    return { has: Boolean(w), text: w ? w.textContent.slice(0, 200) : '' };
  `);
  check('文件管理器可打开', filesWin.has, filesWin.text.replace(/\s+/g, ' ').slice(0, 120));
  await shot('09-files');

  await cdp.eval(`window.Host.launch('settings'); return 1;`);
  await sleep(900);
  const settingsWin = await cdp.eval(`
    const w = document.querySelector('.win[data-app-id="settings"]');
    return { has: Boolean(w), sliders: w ? w.querySelectorAll('input[type=range]').length : 0, text: w ? w.textContent.slice(0, 160) : '' };
  `);
  check('设置可打开且有滑杆', settingsWin.has && settingsWin.sliders >= 2, `${settingsWin.sliders} 个滑杆`);
  await shot('10-settings');

  await cdp.eval(`window.Host.launch('notes'); window.Host.launch('about'); return 1;`);
  await sleep(1100);
  await shot('11-multi-window');

  const finalErrors = errors.filter((e) => !/favicon|Autoplay|play\(\) failed|NotAllowedError/i.test(e));
  check('无 console error / 未捕获异常', finalErrors.length === 0, finalErrors.slice(0, 6).join(' ;; '));

  // ---------- 汇总 ----------
  const passed = checks.filter((c) => c.ok).length;
  console.log('\n===== phigrOS 冒烟测试 =====');
  for (const c of checks) {
    console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? `  :: ${c.detail}` : ''}`);
  }
  console.log(`\nRESULT: ${passed} passed, ${checks.length - passed} failed`);
  console.log(`截图目录：${OUT}`);
  if (errors.length) {
    console.log('\n--- 页面错误 ---');
    for (const e of errors.slice(0, 20)) console.log(e);
  }

  ws.close();
  proc.kill();
  await sleep(400);
  try {
    rmSync(profile, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  process.exit(checks.length - passed === 0 ? 0 : 1);
}

async function waitFor(cdp, expression, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const ok = await cdp.eval(expression);
      if (ok) return true;
    } catch (err) {
      // 页面可能正在导航
    }
    await sleep(250);
  }
  return false;
}

main().catch((err) => {
  console.error('冒烟测试自身异常：', err);
  process.exit(2);
});
