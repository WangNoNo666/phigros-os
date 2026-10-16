// js/apps/phigros.js
// 音游应用挂载器：选曲 -> 准备 -> 游玩 -> 结算，全部在窗口内完成。
// 画面全部画在 canvas 里；本文件只负责 DOM 界面、设置、存档与生命周期。

import AudioEngine from '../engine/audio.js';
import { PhigrosGame, LANE_KEYS, GRADE_COLOR } from '../engine/phigros.js';
import firstLight from '../../data/charts/first-light.js';
import neonRunner from '../../data/charts/neon-runner.js';
import voidCathedral from '../../data/charts/void-cathedral.js';

const TRACKS = [firstLight, neonRunner, voidCathedral];

/**
 * 离线渲染必须挂在有限时间内返回。
 * 某些环境（无音频设备、受限的 headless/沙箱浏览器）里
 * OfflineAudioContext.startRendering() 可能永远不 resolve，
 * 那样会让音游卡在「正在准备音频与谱面…」——这里做最后一道保险：
 * 超时后放弃音频，用兜底时钟照常游玩（判定逻辑不依赖音频）。
 */
const PREPARE_TIMEOUT_MS = 22000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error(`${label} 超时（${ms}ms）`));
    }, ms);
    Promise.resolve(promise).then(
      (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); },
      (e) => { if (done) return; done = true; clearTimeout(timer); reject(e); }
    );
  });
}

const GRADE_BADGE_COLOR = {
  S: '#ffe066',
  A: '#4ade80',
  B: '#22d3ee',
  C: '#fb923c',
  F: '#ef4444',
};

// ---------------------------------------------------------------- 宿主访问（全部容错）

function host() {
  return (typeof window !== 'undefined' && window.Host) ? window.Host : null;
}

function storeGet() {
  const h = host();
  if (h && h.store && typeof h.store.get === 'function') {
    try { return h.store.get() || {}; } catch (err) { /* 忽略 */ }
  }
  return {};
}

function readSettings() {
  const st = storeGet();
  const s = (st && st.settings) || {};
  return {
    speed: Number.isFinite(Number(s.speed)) ? Number(s.speed) : 1,
    offsetMs: Number.isFinite(Number(s.offsetMs)) ? Number(s.offsetMs) : 0,
    volume: Number.isFinite(Number(s.volume)) ? Number(s.volume) : 0.8,
    sfx: s.sfx !== false,
    bgm: s.bgm !== false,
    renderMode: s.renderMode === 'canvas' ? 'canvas' : 'dom'
  };
}

function setPath(path, value) {
  const h = host();
  if (h && h.store && typeof h.store.set === 'function') {
    try { h.store.set(path, value); } catch (err) { /* 忽略 */ }
  }
}

function hostNotify(title, body, level) {
  const h = host();
  if (h && typeof h.notify === 'function') {
    try { h.notify(title, body, level ? { level } : undefined); } catch (err) { /* 忽略 */ }
  }
}

function achievement(id, title, desc) {
  const h = host();
  if (h && typeof h.achievement === 'function') {
    try { return h.achievement(id, title, desc); } catch (err) { /* 忽略 */ }
  }
  return false;
}

function stopBgm() {
  const h = host();
  if (h && h.audio && typeof h.audio.stopBgm === 'function') {
    try { h.audio.stopBgm(); return; } catch (err) { /* 忽略 */ }
  }
  try { AudioEngine.stopBgm(); } catch (err) { /* 忽略 */ }
}

function playLobbyBgm() {
  const h = host();
  if (h && h.audio && typeof h.audio.playBgm === 'function') {
    try { h.audio.playBgm('lobby'); return; } catch (err) { /* 忽略 */ }
  }
  try { AudioEngine.playBgm('lobby'); } catch (err) { /* 忽略 */ }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function text(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback === undefined ? '—' : fallback;
  return String(value);
}

// ---------------------------------------------------------------- DOM 小工具

function h(tag, style, content) {
  const node = document.createElement(tag);
  if (style) {
    if (typeof style === 'string') node.style.cssText = style;
    else for (const k of Object.keys(style)) node.style[k] = style[k];
  }
  if (content !== undefined && content !== null) {
    if (typeof content === 'string') node.textContent = content;
    else node.appendChild(content);
  }
  return node;
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

const VIEW_STYLE = 'position:absolute;inset:0;display:flex;flex-direction:column;';

// ---------------------------------------------------------------- 应用主体

class PhigrosApp {
  constructor(root, ctx) {
    this.root = root;
    this.ctx = ctx || {};
    this.track = null;
    this.game = null;
    this.canvas = null;
    this.phase = 'select';
    this.destroyed = false;
    this.ro = null;
    this.countdownToken = 0;
    this._listenerRecs = [];
    this.pauseMenu = null;
    this.debugState = { phase: 'select', t: 0, counts: { perfect: 0, good: 0, bad: 0, miss: 0 }, combo: 0 };
    if (typeof window !== 'undefined') window.__PHIGROS_GAME_STATE__ = this.debugState;
  }

  on(target, type, handler, opts) {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener(type, handler, opts);
    this._listenerRecs.push({ target, type, handler, opts });
  }

  /** 持久监听目标：root / document / window（视图重建时不能被清掉） */
  isPersistentTarget(target) {
    if (target === this.root) return true;
    if (typeof document !== 'undefined' && target === document) return true;
    if (typeof window !== 'undefined' && target === window) return true;
    return false;
  }

  /** 视图重建前，移除挂在已脱离文档的节点上的监听（避免重复绑定与泄漏） */
  pruneViewListeners() {
    const keep = [];
    for (const rec of this._listenerRecs) {
      const detached = rec.target && rec.target.isConnected === false;
      if (!detached) { keep.push(rec); continue; }
      try { rec.target.removeEventListener(rec.type, rec.handler, rec.opts); } catch (err) { /* 忽略 */ }
    }
    this._listenerRecs = keep;
  }

  removeAllListeners() {
    for (const rec of this._listenerRecs) {
      try { rec.target.removeEventListener(rec.type, rec.handler, rec.opts); } catch (err) { /* 忽略 */ }
    }
    this._listenerRecs = [];
  }

  async init() {
    this.root.style.cssText = 'position:relative;overflow:hidden;background:linear-gradient(160deg,#05060d,#0a1020 60%,#0d1424);color:var(--fg,#e6edf7);min-height:100%;';
    this.root.setAttribute('tabindex', '-1');

    this.viewSelect = h('div', VIEW_STYLE + 'overflow:auto;');
    this.viewDetail = h('div', VIEW_STYLE + 'overflow:auto;display:none;');
    this.viewPlay = h('div', VIEW_STYLE + 'display:none;');
    this.viewResult = h('div', VIEW_STYLE + 'overflow:auto;display:none;');
    this.root.appendChild(this.viewSelect);
    this.root.appendChild(this.viewDetail);
    this.root.appendChild(this.viewPlay);
    this.root.appendChild(this.viewResult);

    this.buildPlayView();
    this.buildSelectView();

    // Esc 暂停：同时挂在窗口容器与 document（capture），destroy 时清理
    const onKey = (ev) => {
      if (!ev) return;
      const key = ev.key || ev.code;
      if (key !== 'Escape' && key !== 'Esc') return;
      if (ev.__phigrosEscHandled) return;
      try { ev.__phigrosEscHandled = true; } catch (err) { /* 忽略 */ }
      this.togglePause();
    };
    this.on(this.root, 'keydown', onKey);
    if (typeof document !== 'undefined') this.on(document, 'keydown', onKey, true);
    this.on(this.root, 'pointerdown', () => { try { this.root.focus(); } catch (err) { /* 忽略 */ } });
    try { this.root.focus(); } catch (err) { /* 忽略 */ }
    return this;
  }

  // ---------- 选曲界面 ----------

  buildSelectView() {
    this.pruneViewListeners();
    const view = clear(this.viewSelect);
    const st = storeGet();
    const player = st.player || {};
    const wrap = h('div', 'padding:18px 20px 26px;display:flex;flex-direction:column;gap:16px;');

    const head = h('div', 'display:flex;align-items:flex-end;justify-content:space-between;gap:12px;flex-wrap:wrap;');
    const titleBox = h('div', '');
    titleBox.appendChild(h('div', 'font-size:22px;font-weight:700;letter-spacing:0.04em;', 'Phigros'));
    titleBox.appendChild(h('div', 'font-size:12px;opacity:0.62;margin-top:4px;', '内置下落式音游 · 4/5/6 轨 · 程序化合成曲目'));
    head.appendChild(titleBox);
    const statBox = h('div', 'font-size:12px;opacity:0.75;text-align:right;line-height:1.7;');
    statBox.appendChild(h('div', '', '玩家 ' + text(player.name, 'PHIGROS-PLAYER')));
    statBox.appendChild(h('div', '', 'RKS ' + (Number(player.rks) || 0).toFixed(4) + '   ·   游玩 ' + (Number(player.totalPlay) || 0) + ' 次'));
    head.appendChild(statBox);
    wrap.appendChild(head);

    const grid = h('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px;');
    const record = (player.record) || {};
    for (const track of TRACKS) {
      const rec = (record[track.id] || {})[track.difficultyName] || null;
      const card = h('div', '');
      card.className = 'ph-card';
      card.setAttribute('data-track', track.id);
      card.style.cssText = 'cursor:pointer;padding:14px 16px;border-radius:10px;background:rgba(255,255,255,0.035);' +
        'border:1px solid ' + track.color + '55;display:flex;flex-direction:column;gap:8px;transition:transform .12s ease,box-shadow .12s ease;';
      const row1 = h('div', 'display:flex;align-items:center;justify-content:space-between;gap:8px;');
      row1.appendChild(h('div', 'font-size:16px;font-weight:700;color:' + track.color + ';', track.title));
      row1.appendChild(h('span', 'font-size:11px;padding:2px 7px;border-radius:999px;background:' + track.color + '22;color:' + track.color + ';border:1px solid ' + track.color + '55;', track.difficultyName + ' ' + track.difficulty));
      card.appendChild(row1);
      card.appendChild(h('div', 'font-size:11px;opacity:0.6;', track.artist + ' · ' + track.bpm + ' BPM · ' + track.length + 's'));
      card.appendChild(h('div', 'font-size:11px;opacity:0.7;', '轨道 ' + track.chart.laneCount + ' · 音符 ' + (track.chart.notes ? track.chart.notes.length : 0)));
      const bestLine = h('div', 'font-size:12px;margin-top:2px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;');
      if (rec) {
        const g = h('span', 'font-weight:700;color:' + (GRADE_BADGE_COLOR[rec.grade] || '#fff') + ';', String(rec.grade || '—'));
        bestLine.appendChild(g);
        bestLine.appendChild(h('span', 'opacity:0.85;', '最高分 ' + Math.round(Number(rec.score) || 0)));
        bestLine.appendChild(h('span', 'opacity:0.7;', '准确 ' + ((Number(rec.acc) || 0) * 100).toFixed(2) + '%'));
        if (rec.fc) bestLine.appendChild(h('span', 'color:#4ade80;font-weight:700;', 'FC'));
        bestLine.appendChild(h('span', 'opacity:0.55;', '游玩 ' + (Number(rec.plays) || 0) + ' 次'));
      } else {
        bestLine.appendChild(h('span', 'opacity:0.5;', '尚无记录'));
      }
      card.appendChild(bestLine);
      card.appendChild(h('div', 'font-size:11px;opacity:0.55;margin-top:2px;', '点击进入 →'));
      grid.appendChild(card);
    }
    wrap.appendChild(grid);
    wrap.appendChild(this.buildSettingsBar());

    const hint = h('div', 'font-size:11px;opacity:0.5;line-height:1.7;');
    hint.appendChild(h('div', '', '4 轨：D F J K　·　5 轨：S D F J K　·　6 轨：S D F J K L　·　drag 可用鼠标按住划过'));
    hint.appendChild(h('div', '', 'Esc 暂停；判定与音频时钟同步（AudioContext），大厅音乐在开始游玩时自动停止。'));
    wrap.appendChild(hint);

    view.appendChild(wrap);

    this.on(wrap, 'click', (ev) => {
      const card = ev.target && ev.target.closest ? ev.target.closest('[data-track]') : null;
      if (!card) return;
      const id = card.getAttribute('data-track');
      const track = TRACKS.filter((t) => t.id === id)[0];
      if (track) this.openDetail(track);
    });
  }

  buildSettingsBar() {
    const s = readSettings();
    const bar = h('div', 'display:flex;gap:18px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.07);');

    const speedWrap = h('div', 'display:flex;align-items:center;gap:8px;font-size:12px;');
    speedWrap.appendChild(h('span', 'opacity:0.75;', '下落速度'));
    const speedInput = h('input', 'width:140px;');
    speedInput.type = 'range';
    speedInput.min = '0.5';
    speedInput.max = '2';
    speedInput.step = '0.05';
    speedInput.value = String(s.speed);
    speedInput.setAttribute('data-setting', 'speed');
    const speedVal = h('span', 'width:42px;opacity:0.85;', s.speed.toFixed(2) + 'x');
    speedWrap.appendChild(speedInput);
    speedWrap.appendChild(speedVal);
    bar.appendChild(speedWrap);

    const offWrap = h('div', 'display:flex;align-items:center;gap:8px;font-size:12px;');
    offWrap.appendChild(h('span', 'opacity:0.75;', '判定偏移'));
    const offInput = h('input', 'width:140px;');
    offInput.type = 'range';
    offInput.min = '-200';
    offInput.max = '200';
    offInput.step = '1';
    offInput.value = String(s.offsetMs);
    offInput.setAttribute('data-setting', 'offsetMs');
    const offVal = h('span', 'width:58px;opacity:0.85;', Math.round(s.offsetMs) + ' ms');
    offWrap.appendChild(offInput);
    offWrap.appendChild(offVal);
    bar.appendChild(offWrap);

    this.on(speedInput, 'input', () => {
      const v = Number(speedInput.value);
      speedVal.textContent = v.toFixed(2) + 'x';
      setPath('settings.speed', v);
      if (this.game && this.game.settings) this.game.settings.speed = v;
    });
    this.on(offInput, 'input', () => {
      const v = Number(offInput.value);
      offVal.textContent = Math.round(v) + ' ms';
      setPath('settings.offsetMs', v);
      if (this.game && this.game.settings) this.game.settings.offsetMs = v;
    });
    return bar;
  }

  // ---------- 曲目详情 / 准备 ----------

  openDetail(track) {
    this.pruneViewListeners();
    this.track = track;
    this.phase = 'detail';
    this.setPhase('detail');
    const view = clear(this.viewDetail);
    const st = storeGet();
    const rec = ((st.player || {}).record || {})[track.id] || {};
    const best = rec[track.difficultyName] || null;

    const wrap = h('div', 'padding:18px 20px 26px;display:flex;flex-direction:column;gap:14px;');

    const head = h('div', 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;');
    const left = h('div', '');
    left.appendChild(h('div', 'font-size:22px;font-weight:800;color:' + track.color + ';', track.title));
    left.appendChild(h('div', 'font-size:12px;opacity:0.65;margin-top:4px;', track.artist + ' · ' + track.bpm + ' BPM · 约 ' + track.length + ' 秒'));
    head.appendChild(left);
    const back = h('button', '');
    back.className = 'ph-btn';
    back.textContent = '返回选曲';
    head.appendChild(back);
    wrap.appendChild(head);

    const info = h('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;');
    const infoItems = [
      ['难度', track.difficultyName + ' ' + track.difficulty],
      ['轨道', String(track.chart.laneCount) + ' 轨'],
      ['音符', String(track.chart.notes ? track.chart.notes.length : 0)],
      ['键位', (LANE_KEYS[track.chart.laneCount] || LANE_KEYS[4]).join(' ').toUpperCase()],
      ['最高分', best ? String(Math.round(Number(best.score) || 0)) : '—'],
      ['历史评级', best ? String(best.grade || '—') + (best.fc ? ' · FC' : '') : '—'],
      ['准确率', best ? ((Number(best.acc) || 0) * 100).toFixed(2) + '%' : '—'],
      ['游玩次数', best ? String(Number(best.plays) || 0) : '0'],
    ];
    for (const [k, v] of infoItems) {
      const box = h('div', 'padding:9px 11px;border-radius:9px;background:rgba(255,255,255,0.035);border:1px solid rgba(255,255,255,0.07);');
      box.appendChild(h('div', 'font-size:11px;opacity:0.6;', k));
      box.appendChild(h('div', 'font-size:15px;font-weight:600;margin-top:3px;', v));
      info.appendChild(box);
    }
    wrap.appendChild(info);
    wrap.appendChild(this.buildSettingsBar());

    const s2 = readSettings();
    const goRow = h('div', 'display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-top:4px;');
    const startBtn = h('button', '');
    startBtn.className = 'ph-btn primary';
    startBtn.setAttribute('data-action', 'start');
    startBtn.style.cssText = 'font-size:15px;padding:10px 26px;font-weight:700;';
    startBtn.textContent = '开始游戏';
    goRow.appendChild(startBtn);
    goRow.appendChild(h('div', 'font-size:12px;opacity:0.6;', '当前速度 ' + s2.speed.toFixed(2) + 'x · 偏移 ' + Math.round(s2.offsetMs) + 'ms · 开始后会先倒计时 3 秒'));
    wrap.appendChild(goRow);

    const tip = h('div', 'font-size:11px;opacity:0.5;line-height:1.7;');
    tip.appendChild(h('div', '', '提示：开始需要一次真实点击（浏览器自动播放策略），随后才会解除音频锁定并停止大厅音乐。'));
    tip.appendChild(h('div', '', 'drag 音符可以划过去命中（固定 PERFECT）；hold 需要按住直到尾部。'));
    wrap.appendChild(tip);
    view.appendChild(wrap);

    this.on(back, 'click', () => { this.showSelect(); });
    this.on(startBtn, 'click', () => { this.beginPlay(track); });
  }

  // ---------- 游玩界面 ----------

  buildPlayView() {
    const view = clear(this.viewPlay);
    view.style.position = 'absolute';
    const stage = h('div', 'position:absolute;inset:0;overflow:hidden;background:#05060d;');
    const canvas = h('canvas', 'position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none;');
    canvas.setAttribute('data-role', 'game-canvas');
    stage.appendChild(canvas);
    this.canvas = canvas;

    const overlay = h('div', 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;flex-direction:column;gap:10px;background:rgba(3,5,12,0.72);text-align:center;padding:20px;');
    stage.appendChild(overlay);
    this.overlay = overlay;

    view.appendChild(stage);
    this.stage = stage;

    // 暂停菜单（DOM 覆层；Esc 触发）
    const menu = h('div', 'position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(3,5,12,0.8);');
    const card = h('div', 'min-width:240px;padding:20px 22px;border-radius:12px;background:rgba(16,22,38,0.98);border:1px solid rgba(255,255,255,0.12);display:flex;flex-direction:column;gap:10px;');
    card.appendChild(h('div', 'font-size:17px;font-weight:700;text-align:center;', '已暂停'));
    card.appendChild(h('div', 'font-size:12px;opacity:0.6;text-align:center;margin-bottom:4px;', 'Esc 继续 / 选择操作'));
    const btnContinue = h('button', '', '继续');
    btnContinue.className = 'ph-btn primary';
    const btnRestart = h('button', '', '重开');
    btnRestart.className = 'ph-btn';
    const btnExit = h('button', '', '退出');
    btnExit.className = 'ph-btn danger';
    card.appendChild(btnContinue);
    card.appendChild(btnRestart);
    card.appendChild(btnExit);
    menu.appendChild(card);
    stage.appendChild(menu);
    this.pauseMenu = menu;

    this.on(btnContinue, 'click', () => this.togglePause());
    this.on(btnRestart, 'click', () => {
      this.hidePauseMenu();
      this.restartGame();
    });
    this.on(btnExit, 'click', () => {
      this.hidePauseMenu();
      this.exitToSelect();
    });

    // 尺寸跟随：用 rAF 去抖，避免 ResizeObserver 与尺寸修改互相触发形成死循环
    if (typeof ResizeObserver === 'function') {
      let pending = 0;
      this.ro = new ResizeObserver(() => {
        if (pending) return;
        const raf = (typeof window !== 'undefined' && window.requestAnimationFrame)
          ? window.requestAnimationFrame.bind(window)
          : (fn) => setTimeout(fn, 16);
        pending = raf(() => {
          pending = 0;
          try { this.onResize(); } catch (err) { /* 忽略 */ }
        });
      });
      this.ro.observe(stage);
    } else if (typeof window !== 'undefined') {
      this.on(window, 'resize', () => this.onResize());
    }
  }

  setPhase(phase) {
    this.phase = phase;
    if (this.debugState) this.debugState.phase = phase;
    this.viewSelect.style.display = phase === 'select' ? 'flex' : 'none';
    this.viewDetail.style.display = phase === 'detail' ? 'flex' : 'none';
    this.viewPlay.style.display = (phase === 'play' || phase === 'countdown' || phase === 'paused') ? 'block' : 'none';
    this.viewResult.style.display = phase === 'result' ? 'flex' : 'none';
  }

  showSelect() {
    this.teardownGame();
    this.phase = 'select';
    this.setPhase('select');
    this.buildSelectView();
    playLobbyBgm();
  }

  async beginPlay(track) {
    if (this.destroyed) return;
    if (this.phase === 'countdown' || this.phase === 'play') return;
    this.track = track;
    this.setPhase('countdown');
    this.snap('beginPlay:enter');
    this.overlay.style.display = 'flex';
    this.overlay.innerHTML = '';
    const prepTitle = h('div', 'font-size:16px;font-weight:600;', '正在准备音频与谱面…');
    const prepDetail = h('div', 'font-size:12px;opacity:0.6;', '首次游玩需要离线合成整首曲目，请稍候');
    this.overlay.appendChild(prepTitle);
    this.overlay.appendChild(prepDetail);
    // 实时进度：长曲目离线合成要几百毫秒~数秒，界面必须给出反馈，否则看起来像卡死
    const t0 = Date.now();
    const tickTimer = setInterval(() => {
      if (this.destroyed) return;
      const el = (Date.now() - t0) / 1000;
      const note = this.prepNote || '正在离线合成曲目音频';
      prepDetail.textContent = `${note} · 已用 ${el.toFixed(1)}s`;
    }, 250);
    const stopTick = () => clearInterval(tickTimer);
    this._stopPrepTick = stopTick;

    // 用户手势内解除音频锁定（浏览器自动播放策略）
    // 注意：某些环境里 AudioContext.resume() 的 Promise 可能长时间不落地（音频设备被占用/
    // 受限的 headless 预览/策略拦截），因此这里必须限时，绝不能让它阻塞整条游玩链路。
    try {
      await withTimeout(Promise.resolve(AudioEngine.unlock()), 2500, 'AudioContext 解锁').catch(() => {});
    } catch (err) { /* 忽略：无音频也能玩，判定会走兜底时钟 */ }
    try { AudioEngine.setSfxEnabled(readSettings().sfx); } catch (err) { /* 忽略 */ }
    stopBgm();
    this.snap('beginPlay:audioUnlock');

    // 创建游戏实例
    this.teardownGame();
    const settings = readSettings();
    // 渲染后端：默认 DOM（CSS transform，交给合成器线程；弱 GPU / 软件渲染下
    // 也能保持连续下落，与 Sparebeat 同思路）。可在设置里切回 canvas。
    const q = (() => {
      try {
        return new URLSearchParams((window.location && window.location.search) || '');
      } catch (err) {
        return new URLSearchParams('');
      }
    })();
    const probeNoRender = q.get('norender') === '1';
    const probeCanvas = q.get('render') === 'canvas';
    const game = new PhigrosGame(this.stage, {
      canvas: this.canvas,
      noRender: probeNoRender,
      renderMode: probeCanvas ? 'canvas' : (readSettings().renderMode === 'canvas' ? 'canvas' : 'dom'),
      track,
      settings,
      raf: (fn) => {
        const h2 = host();
        if (h2 && typeof h2.raf === 'function') return h2.raf(fn);
        return this.fallbackRaf(fn);
      },
      onEvent: (name, payload) => this.onGameEvent(name, payload),
      // 掉帧守卫：万一还有东西在拖帧率（例如用户手动打开了音乐合成），
      // 立刻停用音频合成并通知，优先保住手感。
      onPerfDegrade: (info) => {
        try {
          if (AudioEngine && typeof AudioEngine.panicDisableSynthesis === 'function') {
            const changed = AudioEngine.panicDisableSynthesis(`游玩中平均 ${info.fps}fps`);
            if (changed) hostNotify('已自动关闭音乐合成', `检测到掉帧（约 ${info.fps} fps），为保证判定手感已停用音频合成`, 'warn');
          }
        } catch (err) { /* 忽略 */ }
      },
    });
    this.game = game;
    if (typeof window !== 'undefined') window.__PHIGROS_GAME__ = game;
    this.onResize();
    this.snap('beginPlay:gameCreated');

    // 渲染进度 -> 准备界面文案
    try {
      const ae = AudioEngine;
      ae.onRenderProgress = (info) => {
        if (!info) return;
        if (info.phase === 'synth') this.prepNote = `正在合成曲目音频（${info.mode === 'full' ? '完整' : info.mode === 'lite' ? '精简' : '极简'}）`;
        else if (info.phase === 'render') this.prepNote = `正在渲染音频（${info.nodes || 0} 个节点）`;
      };
    } catch (err) { /* 忽略 */ }

    // 非阻塞准备：有缓存/音频不可用时立即返回，否则音频在后台渲染。
    // 音游先跑起来（兜底时钟），绝不再因为音频子系统卡住而无法开始。
    try {
      if (typeof game.prepareAsync === 'function') {
        game.prepareAsync();
      } else {
        await withTimeout(game.prepare(), PREPARE_TIMEOUT_MS, '音频与谱面准备').catch((err) => {
          console.warn('[phigros] ' + ((err && err.message) || err) + '，将使用无音频模式游玩');
          try { game.buffer = null; game.state = 'ready'; } catch (e) { /* 忽略 */ }
        });
      }
    } catch (err) {
      try { game.buffer = null; game.state = 'ready'; } catch (e) { /* 忽略 */ }
    }
    if (this._stopPrepTick) { this._stopPrepTick(); this._stopPrepTick = null; }
    if (this.destroyed) { this.teardownGame(); return; }
    this.snap('beginPlay:prepared');

    const okGo = await this.runCountdown();
    if (!okGo || this.destroyed) return;
    this.snap('beginPlay:countdownDone');
    if (game.ended || this.phase === 'result') {
      // 倒计时期间被 finish()/seekToEnd() 提前结算：不要重新开始
      this.overlay.style.display = 'none';
      return;
    }
    this.overlay.style.display = 'none';
    this.setPhase('play');
    await game.start();
    this.snap('beginPlay:started');
    try { if (this.root.focus) this.root.focus(); } catch (err) { /* 忽略 */ }
  }

  /** 调试快照：记录 beginPlay 各阶段是否真的执行到（验收脚本读它定位卡点） */
  snap(stage) {
    if (typeof window === 'undefined') return;
    const s = (window.__PHIGROS_SNAP__ = window.__PHIGROS_SNAP__ || { stages: [] });
    s.stage = stage;
    s.at = Date.now();
    s.phase = this.phase;
    s.hasGame = Boolean(this.game);
    s.gameState = this.game ? this.game.state : null;
    s.hasBuffer = Boolean(this.game && this.game.buffer);
    s.degraded = this.game ? this.game.degraded : null;
    s.stages.push(`${stage}@${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`);
    if (s.stages.length > 40) s.stages.shift();
  }

  fallbackRaf(fn) {
    if (typeof requestAnimationFrame === 'function') {
      const id = requestAnimationFrame((ms) => fn(undefined, ms));
      return () => { try { cancelAnimationFrame(id); } catch (err) { /* 忽略 */ } };
    }
    const id = setTimeout(() => fn(16, (typeof performance !== 'undefined' ? performance.now() : Date.now())), 16);
    return () => { try { clearTimeout(id); } catch (err) { /* 忽略 */ } };
  }

  async runCountdown() {
    const token = ++this.countdownToken;
    const labels = ['3', '2', '1', 'GO'];
    for (let i = 0; i < labels.length; i++) {
      if (this.destroyed || token !== this.countdownToken) return false;
      clear(this.overlay);
      this.overlay.appendChild(h('div', 'font-size:64px;font-weight:800;letter-spacing:0.06em;color:' + (this.track ? this.track.color : '#22d3ee') + ';text-shadow:0 0 24px rgba(34,211,238,0.5);', labels[i]));
      this.overlay.appendChild(h('div', 'font-size:12px;opacity:0.6;',
        labels[i] === 'GO' ? '开始！' : '准备：' + this.track.title + ' · ' + this.track.difficultyName + ' ' + this.track.difficulty));
      await sleep(labels[i] === 'GO' ? 360 : 700);
    }
    return !this.destroyed && token === this.countdownToken;
  }

  onGameEvent(name, payload) {
    if (this.destroyed) return;
    if (name === 'tick' && payload) {
      this.debugState.t = payload.t || 0;
      this.debugState.combo = payload.combo || 0;
      this.debugState.counts = payload.counts || this.debugState.counts;
      this.debugState.phase = this.phase;
    } else if (name === 'start') {
      // 游玩中给窗口加上 perf-canvas：关掉 backdrop-filter，避免合成器每帧重新模糊整块窗口
      this.setPerfCanvas(true);
    } else if (name === 'end' && payload) {
      this.setPerfCanvas(false);
      this.showResult(payload);
    } else if (name === 'pause') {
      this.setPhase('paused');
      this.pauseMenu.style.display = 'flex';
    } else if (name === 'resume') {
      this.setPhase('play');
      this.pauseMenu.style.display = 'none';
    }
  }

  /** 运行时给承载画布的窗口开关「高性能画布」模式 */
  setPerfCanvas(on) {
    try {
      let el = this.canvas && this.canvas.parentElement;
      while (el && !(el.classList && el.classList.contains('win'))) el = el.parentElement;
      if (el && el.classList) el.classList.toggle('perf-canvas', Boolean(on));
    } catch (err) { /* 忽略 */ }
  }

  togglePause() {
    if (!this.game) {
      if (this.phase === 'detail') this.showSelect();
      return;
    }
    if (this.phase === 'play') {
      this.game.pause();               // 触发 'pause' 事件 -> 显示暂停菜单
      this.pauseMenu.style.display = 'flex';
      this.setPhase('paused');
      return;
    }
    if (this.phase === 'paused') {
      this.hidePauseMenu();
      this.game.resume();
    }
  }

  hidePauseMenu() {
    if (this.pauseMenu) this.pauseMenu.style.display = 'none';
  }

  async restartGame() {
    if (!this.game) return;
    this.hidePauseMenu();
    this.setPhase('play');
    await this.game.restart();
    this.overlay.style.display = 'none';
  }

  exitToSelect() {
    this.teardownGame();
    this.showSelect();
  }

  onResize() {
    if (!this.stage) return;
    const w = this.stage.clientWidth || 900;
    const hh = this.stage.clientHeight || 640;
    if (this.game) {
      this.game.resize(w, hh);
      return;
    }
    // 没有游戏实例时也把画布尺寸对齐，保证选曲/倒计时背景不出错
    if (this.canvas) {
      this.canvas.width = Math.max(2, Math.round(w));
      this.canvas.height = Math.max(2, Math.round(hh));
    }
  }

  // ---------- 结算 ----------

  showResult(result) {
    this.pruneViewListeners();
    this.countdownToken++;                 // 取消可能仍在进行的倒计时
    if (this.overlay) this.overlay.style.display = 'none';
    const track = this.track;
    const st = storeGet();
    const rec = ((st.player || {}).record || {})[track.id] || {};
    const old = rec[track.difficultyName] || null;
    const isNewRecord = !old || Number(result.score) > Number(old.score) || Number(result.acc) > Number(old.acc);

    this.saveRecord(result, old);
    this.setPhase('result');
    this.hidePauseMenu();

    const view = clear(this.viewResult);
    const wrap = h('div', 'padding:20px;display:flex;flex-direction:column;gap:14px;align-items:stretch;max-width:820px;margin:0 auto;width:100%;');

    const head = h('div', 'display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;');
    const l = h('div', '');
    l.appendChild(h('div', 'font-size:20px;font-weight:800;color:' + track.color + ';', track.title + ' · ' + track.difficultyName));
    l.appendChild(h('div', 'font-size:12px;opacity:0.6;margin-top:4px;', '本次成绩 · ' + (result.fc ? 'FULL COMBO' : '已结算')));
    head.appendChild(l);
    const gradeBox = h('div', 'text-align:center;min-width:96px;');
    gradeBox.appendChild(h('div', 'font-size:44px;font-weight:900;line-height:1;color:' + (GRADE_BADGE_COLOR[result.grade] || '#fff') + ';', String(result.grade)));
    gradeBox.appendChild(h('div', 'font-size:11px;opacity:0.6;margin-top:4px;', '评级'));
    head.appendChild(gradeBox);
    wrap.appendChild(head);

    const scoreRow = h('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;');
    const items = [
      ['分数', String(result.score)],
      ['准确率', (result.acc * 100).toFixed(2) + '%'],
      ['最大连击', String(result.maxCombo)],
      ['评级', String(result.grade) + (result.fc ? ' · FC' : '')],
    ];
    for (const [k, v] of items) {
      const box = h('div', 'padding:12px 14px;border-radius:10px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);');
      box.appendChild(h('div', 'font-size:11px;opacity:0.6;', k));
      box.appendChild(h('div', 'font-size:20px;font-weight:700;margin-top:4px;', v));
      scoreRow.appendChild(box);
    }
    wrap.appendChild(scoreRow);

    const countRow = h('div', 'display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px;');
    const counts = result.counts || {};
    const countItems = [
      ['PERFECT', counts.perfect || 0, GRADE_COLOR.perfect],
      ['GOOD', counts.good || 0, GRADE_COLOR.good],
      ['BAD', counts.bad || 0, GRADE_COLOR.bad],
      ['MISS', counts.miss || 0, GRADE_COLOR.miss],
    ];
    for (const [k, v, color] of countItems) {
      const box = h('div', 'padding:10px 12px;border-radius:9px;background:rgba(255,255,255,0.03);border:1px solid ' + color + '44;');
      box.appendChild(h('div', 'font-size:12px;font-weight:700;color:' + color + ';', k));
      box.appendChild(h('div', 'font-size:18px;font-weight:700;margin-top:2px;', String(v)));
      countRow.appendChild(box);
    }
    wrap.appendChild(countRow);

    const badges = h('div', 'display:flex;gap:8px;flex-wrap:wrap;');
    if (isNewRecord) badges.appendChild(h('span', 'font-size:12px;padding:4px 10px;border-radius:999px;background:rgba(255,224,102,0.16);color:#ffe066;border:1px solid rgba(255,224,102,0.4);', '刷新记录'));
    else badges.appendChild(h('span', 'font-size:12px;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,0.06);opacity:0.7;', '未刷新记录'));
    if (result.fc) badges.appendChild(h('span', 'font-size:12px;padding:4px 10px;border-radius:999px;background:rgba(74,222,128,0.16);color:#4ade80;border:1px solid rgba(74,222,128,0.4);', 'FULL COMBO'));
    if (old) badges.appendChild(h('span', 'font-size:12px;padding:4px 10px;border-radius:999px;opacity:0.7;background:rgba(255,255,255,0.06);', '历史最高分 ' + Math.round(Number(old.score) || 0)));
    badges.appendChild(h('span', 'font-size:12px;padding:4px 10px;border-radius:999px;opacity:0.7;background:rgba(255,255,255,0.06);', '总音符 ' + (result.total || 0)));
    wrap.appendChild(badges);

    const btnRow = h('div', 'display:flex;gap:10px;flex-wrap:wrap;margin-top:4px;');
    const again = h('button', '', '再来一次');
    again.className = 'ph-btn primary';
    const backSelect = h('button', '', '返回选曲');
    backSelect.className = 'ph-btn';
    const quit = h('button', '', '退出');
    quit.className = 'ph-btn danger';
    btnRow.appendChild(again);
    btnRow.appendChild(backSelect);
    btnRow.appendChild(quit);
    wrap.appendChild(btnRow);

    view.appendChild(wrap);

    this.on(again, 'click', () => {
      this.teardownGame();
      this.beginPlay(track);
    });
    this.on(backSelect, 'click', () => this.exitToSelect());
    this.on(quit, 'click', () => {
      this.teardownGame();
      const h2 = host();
      if (h2 && h2.wm && typeof h2.wm.close === 'function' && this.ctx && this.ctx.windowId) {
        try { h2.wm.close(this.ctx.windowId); return; } catch (err) { /* 忽略 */ }
      }
      this.showSelect();
    });
  }

  saveRecord(result, old) {
    const track = this.track;
    const H = host();
    if (!H || !H.store) return;
    try {
      H.store.update('player.record', (rec) => {
        rec = rec || {};
        rec[track.id] = rec[track.id] || {};
        const prev = rec[track.id][track.difficultyName] || null;
        const better = !prev || Number(result.score) > Number(prev.score)
          || (Number(result.score) === Number(prev.score) && Number(result.acc) > Number(prev.acc));
        rec[track.id][track.difficultyName] = {
          score: better ? result.score : (Number(prev.score) || 0),
          acc: better ? result.acc : (Number(prev.acc) || 0),
          grade: better ? result.grade : (prev.grade || result.grade),
          fc: !!result.fc || !!(prev && prev.fc),
          maxCombo: Math.max(Number(result.maxCombo) || 0, Number(prev && prev.maxCombo) || 0),
          plays: (Number(prev && prev.plays) || 0) + 1,
          difficulty: track.difficulty,
          updatedAt: Date.now(),
        };
        return rec;
      });
    } catch (err) { /* 忽略 */ }

    try { H.store.update('player.totalPlay', (n) => (Number(n) || 0) + 1); } catch (err) { /* 忽略 */ }

    const total = Number((storeGet().player || {}).totalPlay) || 0;
    achievement('first-play', '第一首歌', '完成第一次游玩');
    if (total >= 10) achievement('play-10', '十连击', '累计游玩 10 次');
    if (result.fc) achievement('first-fc', 'Full Combo', '完成一次全连');
    if (result.grade === 'S') achievement('grade-s', 'S 评级', '获得一次 S 评级');
    if (track.id === 'void-cathedral' && result.grade !== 'F') achievement('extra-clear', '深渊回响', '通过 Extra 难度');

    if (H && typeof H.recalcRks === 'function') {
      try { H.recalcRks(); } catch (err) { /* 忽略 */ }
    }
    if (old === null || old === undefined) hostNotify('新曲目记录', track.title + ' · ' + track.difficultyName, 'info');
  }

  // ---------- 清理 ----------

  teardownGame() {
    this.countdownToken++;
    if (this.overlay) {
      this.overlay.style.display = 'none';
      clear(this.overlay);
    }
    this.hidePauseMenu();
    if (this.game) {
      try { this.game.destroy(); } catch (err) { /* 忽略 */ }
      this.game = null;
    }
    if (typeof window !== 'undefined' && window.__PHIGROS_GAME__) window.__PHIGROS_GAME__ = null;
  }

  destroy() {
    this.destroyed = true;
    this.countdownToken++;
    if (this.ro) {
      try { this.ro.disconnect(); } catch (err) { /* 忽略 */ }
      this.ro = null;
    }
    this.teardownGame();
    this.removeAllListeners();
    if (typeof window !== 'undefined') {
      if (window.__PHIGROS_GAME__) window.__PHIGROS_GAME__ = null;
      window.__PHIGROS_GAME_STATE__ = this.debugState;
    }
    playLobbyBgm();
    try { clear(this.viewSelect); clear(this.viewDetail); clear(this.viewPlay); clear(this.viewResult); } catch (err) { /* 忽略 */ }
  }
}

export default {
  id: 'phigros',
  name: 'Phigros',
  icon: '🎵',
  desc: '内置 Phigros 风格下落式音游（4/5/6 轨，程序化合成曲目）',
  singleton: true,
  width: 900,
  height: 640,
  accent: '#22d3ee',
  async mount(root, ctx) {
    const app = new PhigrosApp(root, ctx);
    await app.init();
    return {
      destroy() { app.destroy(); },
      onFocus() {
        try { if (root && root.focus) root.focus(); } catch (err) { /* 忽略 */ }
      },
      onBlur() {
        // 失焦自动暂停，避免音频与谱面脱节
        try {
          if (app.game && app.phase === 'play') {
            app.game.pause();
            app.pauseMenu.style.display = 'flex';
            app.setPhase('paused');
          }
        } catch (err) { /* 忽略 */ }
      },
      onResize() { app.onResize(); },
    };
  },
};
