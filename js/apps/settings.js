// settings.js —— 「设置」应用：外观 / 声音 / 音游 / 数据
//
// 顶层不得触碰 window / document（node 自测会 import 纯函数）。

/** 墙纸种类（与 Host.desktop.setWallpaperKind 的取值一致） */
export const WALLPAPER_KINDS = [
  { id: 'aurora', label: '极光' },
  { id: 'grid', label: '网格' },
  { id: 'solid', label: '纯色' }
];

/** 可试听的系统音效 */
export const SFX_NAMES = ['click', 'open', 'ok', 'error'];

/** 成就标题（与 about.js 的 ACHIEVEMENTS 保持一致） */
const ACHIEVEMENT_META = { 'theme-hue': { title: '色彩调节', desc: '修改过主题色相' } };

/** 数值夹取（非数字回落到下界） */
export function clampNumber(value, lo, hi) {
  const n = Number(value);
  if (!Number.isFinite(n)) return lo;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

/** 字节数格式化 */
export function formatBytes(bytes) {
  const v = Number(bytes);
  if (!Number.isFinite(v) || v <= 0) return '0 B';
  if (v < 1024) return Math.round(v) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  const digits = x >= 100 ? 0 : x >= 10 ? 1 : 2;
  return x.toFixed(digits) + ' ' + units[i];
}

/** 估算 localStorage 占用字节数（UTF-16 近似：每字符 2 字节） */
export function estimateLocalStorageBytes(storage) {
  try {
    const ls = storage || (typeof globalThis !== 'undefined' ? globalThis.localStorage : null);
    if (!ls || typeof ls.length !== 'number') return 0;
    let bytes = 0;
    for (let i = 0; i < ls.length; i += 1) {
      const key = ls.key(i);
      if (key === null || key === undefined) continue;
      const value = ls.getItem(key);
      bytes += (String(key).length + (value ? String(value).length : 0)) * 2;
    }
    return bytes;
  } catch (err) {
    return 0;
  }
}

/** 时长/数值展示：音频音量、色相、倍率、毫秒 */
export function formatVolume(v) {
  return Math.round(clampNumber(v, 0, 1) * 100) + '%';
}
export function formatHue(v) {
  return Math.round(clampNumber(v, 0, 360)) + '°';
}
export function formatSpeed(v) {
  return clampNumber(v, 0.5, 2.0).toFixed(2) + '×';
}
export function formatOffset(v) {
  const n = Math.round(clampNumber(v, -200, 200));
  return (n > 0 ? '+' : '') + n + ' ms';
}

function makeCard(H, title, children) {
  const body = H.el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px' } });
  for (const child of children) {
    if (child) body.appendChild(child);
  }
  return H.el(
    'div',
    { className: 'ph-card', style: { padding: '12px 14px', marginBottom: '12px' } },
    H.el('div', { className: 'ph-title', style: { marginBottom: '6px' }, textContent: title }),
    body
  );
}

function toggleRow(H, opts) {
  const input = H.el('input', {
    type: 'checkbox',
    style: { flex: '0 0 auto', width: '16px', height: '16px', accentColor: 'var(--accent)' }
  });
  input.addEventListener('change', () => {
    opts.onChange(!!input.checked);
  });
  const textCol = H.el('div', { style: { display: 'flex', flexDirection: 'column', gap: '2px' } });
  textCol.appendChild(H.el('div', { className: 'ph-sub', style: { color: 'var(--fg)' }, textContent: opts.label }));
  if (opts.hint) {
    textCol.appendChild(H.el('div', { className: 'ph-sub', style: { fontSize: '11px' }, textContent: opts.hint }));
  }
  const row = H.el(
    'label',
    {
      className: 'ph-row',
      style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px', padding: '7px 0', cursor: 'pointer' }
    },
    textCol,
    input
  );
  return {
    row,
    sync() {
      input.checked = !!opts.value();
    }
  };
}

function sliderRow(H, opts) {
  const valueOut = H.el('span', { className: 'ph-mono', style: { color: 'var(--accent)' } });
  const input = H.el('input', {
    className: 'ph-range',
    type: 'range',
    min: String(opts.min),
    max: String(opts.max),
    step: String(opts.step),
    style: { width: '100%' }
  });
  input.addEventListener('input', () => {
    const v = clampNumber(Number(input.value), opts.min, opts.max);
    valueOut.textContent = opts.format(v);
    opts.onInput(v);
  });
  const head = H.el(
    'div',
    { style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '8px' } },
    H.el('div', { className: 'ph-sub', style: { color: 'var(--fg)' }, textContent: opts.label }),
    valueOut
  );
  const row = H.el('div', { style: { display: 'flex', flexDirection: 'column', gap: '4px', padding: '7px 0' } }, head, input);
  if (opts.hint) {
    row.appendChild(H.el('div', { className: 'ph-sub', style: { fontSize: '11px' }, textContent: opts.hint }));
  }
  return {
    row,
    sync() {
      const v = clampNumber(opts.value(), opts.min, opts.max);
      input.value = String(v);
      valueOut.textContent = opts.format(v);
    }
  };
}

function segmentedRow(H, opts) {
  const buttons = new Map();
  const box = H.el('div', { className: 'ph-row', style: { display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '6px 0' } });
  for (const item of opts.items) {
    const btn = H.el('button', {
      className: 'ph-btn',
      textContent: item.label,
      onclick: () => {
        opts.onSelect(item.id);
        opts.sync();
      }
    });
    buttons.set(item.id, btn);
    box.appendChild(btn);
  }
  const wrap = opts.label
    ? H.el(
        'div',
        { style: { padding: '7px 0', display: 'flex', flexDirection: 'column', gap: '4px' } },
        H.el('div', { className: 'ph-sub', style: { color: 'var(--fg)' }, textContent: opts.label }),
        box
      )
    : box;
  return {
    row: wrap,
    sync() {
      const current = opts.value();
      for (const [id, btn] of buttons) {
        btn.className = 'ph-btn' + (id === current ? ' primary' : '');
      }
    }
  };
}

function infoGrid(H, rows) {
  const grid = H.el('div', {
    className: 'ph-grid',
    style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: '13px' }
  });
  for (const [label, value] of rows) {
    grid.appendChild(H.el('div', { className: 'ph-sub', textContent: label }));
    grid.appendChild(
      H.el('div', { className: 'ph-mono', style: { color: 'var(--fg)', wordBreak: 'break-all', textAlign: 'right' }, textContent: value })
    );
  }
  return grid;
}

function writeSaveFile(H, root, urls, timers) {
  const state = H.store.get();
  const payload = { app: 'phigrOS', kind: 'save', exportedAt: Date.now(), state };
  const text = JSON.stringify(payload, null, 2);
  const doc = root.ownerDocument;
  const blob = new Blob([text], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  urls.push(url);
  const a = doc.createElement('a');
  a.href = url;
  a.download = 'phigros-os-save.json';
  a.style.display = 'none';
  a.textContent = 'phigros-os-save.json';
  root.appendChild(a);
  a.click();
  if (a.parentNode) a.parentNode.removeChild(a);
  const timer = setTimeout(() => {
    try {
      URL.revokeObjectURL(url);
    } catch (err) {
      /* 忽略 */
    }
    const idx = urls.indexOf(url);
    if (idx !== -1) urls.splice(idx, 1);
  }, 4000);
  timers.push(timer);
  return text.length;
}

export default {
  id: 'settings',
  name: '设置',
  icon: '⚙️',
  desc: '外观、声音、音游参数与数据管理',
  singleton: true,
  width: 620,
  height: 520,
  accent: '#22d3ee',

  async mount(root, ctx) {
    const H = globalThis.Host;
    const win = typeof globalThis.window !== 'undefined' ? globalThis.window : null;
    const doc = root.ownerDocument || (win ? win.document : null);
    const store = H.store;
    const unsubs = [];
    const timers = [];
    const objectUrls = [];
    const syncers = [];

    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.height = '100%';

    // CRT 扫描线：进入时按状态应用；销毁时重新与当前状态对齐
    // （内核 compositor 也在 settings 变化时切换该 class，所以这里不以“进入前的快照”覆盖，
    //   否则用户在窗口内改过开关后关闭窗口会留下与状态不一致的 DOM）
    const htmlEl = doc ? doc.documentElement : null;

    function applyScanlineClass(on) {
      if (!htmlEl) return;
      if (on) htmlEl.classList.remove('no-scanlines');
      else htmlEl.classList.add('no-scanlines');
    }

    // —— 标签栏 ——
    const panelDefs = [
      { id: 'appearance', label: '外观' },
      { id: 'sound', label: '声音' },
      { id: 'rhythm', label: '音游' },
      { id: 'data', label: '数据' }
    ];
    const tabsBar = H.el('div', {
      className: 'ph-tabs',
      style: { flex: '0 0 auto', display: 'flex', gap: '4px', padding: '10px 12px 0' }
    });
    const panels = new Map();
    const tabButtons = new Map();

    const body = H.el('div', {
      className: 'ph-scroll',
      style: { flex: '1 1 auto', overflowY: 'auto', padding: '12px 14px' }
    });

    function showPanel(id) {
      for (const [pid, panel] of panels) {
        panel.style.display = pid === id ? 'block' : 'none';
      }
      for (const [tid, btn] of tabButtons) {
        btn.className = 'ph-tab' + (tid === id ? ' on active' : '');
        btn.setAttribute('aria-selected', tid === id ? 'true' : 'false');
      }
      for (const fn of (panels.get(id) ? panels.get(id).__sync || [] : [])) fn();
    }

    function addPanel(id, children, syncFns) {
      const panel = H.el('div', { style: { display: 'none' } });
      for (const child of children) if (child) panel.appendChild(child);
      panel.__sync = syncFns || [];
      panels.set(id, panel);
      body.appendChild(panel);
    }

    for (const def of panelDefs) {
      const btn = H.el('button', {
        className: 'ph-tab',
        textContent: def.label,
        onclick: () => {
          H.audio.sfx('click');
          showPanel(def.id);
        }
      });
      tabButtons.set(def.id, btn);
      tabsBar.appendChild(btn);
    }
    root.appendChild(tabsBar);
    root.appendChild(body);

    const getSettings = () => store.get().settings || {};

    function safeLocalStorage() {
      try {
        return win ? win.localStorage : null;
      } catch (err) {
        return null;
      }
    }

    /**
     * 刷新桌面墙纸。
     * 优先走 Host.desktop.refresh()；内核未回填 desktop 时回落到 Host.refreshWallpaper()。
     */
    function refreshDesktop() {
      try {
        if (H.desktop && typeof H.desktop.refresh === 'function') H.desktop.refresh();
      } catch (err) {
        /* 忽略 */
      }
      try {
        if (typeof H.refreshWallpaper === 'function') H.refreshWallpaper();
      } catch (err) {
        /* 忽略 */
      }
    }

    /** 当前墙纸种类：Host.desktop 缺失时回落到 state.settings.wallpaper */
    function currentWallpaperKind() {
      try {
        if (H.desktop && typeof H.desktop.wallpaperKind === 'function') {
          const k = H.desktop.wallpaperKind();
          if (k) return k;
        }
      } catch (err) {
        /* 回落到状态值 */
      }
      const s = getSettings();
      const hit = WALLPAPER_KINDS.some((item) => item.id === s.wallpaper);
      return hit ? s.wallpaper : 'aurora';
    }

    /** 切换墙纸：优先 Host.desktop.setWallpaperKind，否则写状态 + 刷新墙纸 */
    function applyWallpaperKind(kind) {
      if (!WALLPAPER_KINDS.some((item) => item.id === kind)) return;
      try {
        if (H.desktop && typeof H.desktop.setWallpaperKind === 'function') {
          H.desktop.setWallpaperKind(kind);
          refreshDesktop();
          return;
        }
      } catch (err) {
        /* 回落到状态写入 */
      }
      store.set('settings.wallpaper', kind);
      refreshDesktop();
    }

    // ================= 外观 =================
    const hueSlider = sliderRow(H, {
      label: '主题色相',
      min: 0,
      max: 360,
      step: 1,
      format: formatHue,
      value: () => getSettings().themeHue,
      onInput: (v) => {
        store.set('settings.themeHue', Math.round(v));
        refreshDesktop();
        if (v !== 190) {
          const meta = ACHIEVEMENT_META['theme-hue'];
          try {
            H.achievement('theme-hue', meta.title, meta.desc);
          } catch (err) {
            /* 成就失败不影响设置 */
          }
        }
      }
    });

    const wallpaperRow = segmentedRow(H, {
      label: '墙纸',
      items: WALLPAPER_KINDS,
      value: currentWallpaperKind,
      onSelect: (kind) => {
        applyWallpaperKind(kind);
      },
      sync: () => wallpaperRow.sync()
    });

    const scanlineToggle = toggleRow(H, {
      label: 'CRT 扫描线',
      hint: '关闭后屏幕更锐利（只影响视觉）',
      value: () => getSettings().scanlines !== false,
      onChange: (on) => {
        store.set('settings.scanlines', on);
        applyScanlineClass(on);
      }
    });

    const smoothToggle = toggleRow(H, {
      label: '流畅模式',
      hint: '关闭背景模糊、动画与重特效。弱显卡 / 远程桌面 / 省电模式下能显著提升帧率',
      value: () => getSettings().smoothMode !== false,
      onChange: (on) => {
        store.set('settings.smoothMode', on);
        try {
          document.documentElement.classList.toggle('smooth-mode', !!on);
        } catch (err) { /* 忽略 */ }
      }
    });

    const fpsToggle = toggleRow(H, {
      label: '显示 FPS',
      hint: '在右上角显示实时帧率',
      value: () => !!getSettings().showFps,
      onChange: (on) => store.set('settings.showFps', on)
    });

    addPanel(
      'appearance',
      [
        makeCard(H, '主题与墙纸', [
          hueSlider.row,
          H.el('div', { className: 'ph-sep', style: { height: '1px', background: 'var(--line)', margin: '6px 0' } }),
          wallpaperRow.row,
          H.el('div', { className: 'ph-sep', style: { height: '1px', background: 'var(--line)', margin: '6px 0' } }),
          scanlineToggle.row,
          H.el('div', { className: 'ph-sep', style: { height: '1px', background: 'var(--line)', margin: '6px 0' } }),
          smoothToggle.row,
          fpsToggle.row
        ])
      ],
      [hueSlider.sync, wallpaperRow.sync, scanlineToggle.sync, smoothToggle.sync, fpsToggle.sync]
    );

    // ================= 声音 =================
    function currentVolume() {
      const s = getSettings();
      try {
        const v = H.audio && H.audio.volume ? H.audio.volume() : null;
        if (Number.isFinite(v)) return clampNumber(v, 0, 1);
      } catch (err) {
        /* 回落到状态值 */
      }
      return clampNumber(s.volume == null ? 0.8 : s.volume, 0, 1);
    }

    const volumeSlider = sliderRow(H, {
      label: '主音量',
      min: 0,
      max: 1,
      step: 0.05,
      format: formatVolume,
      value: currentVolume,
      onInput: (v) => {
        store.set('settings.volume', v);
        try {
          H.audio.setVolume(v);
        } catch (err) {
          /* 音频未就绪时忽略 */
        }
      }
    });

    const sfxToggle = toggleRow(H, {
      label: '系统音效',
      hint: '按钮点击、通知、判定提示音',
      value: () => getSettings().sfx !== false,
      onChange: (on) => store.set('settings.sfx', on)
    });

    const bgmToggle = toggleRow(H, {
      label: '大厅 BGM',
      hint: '桌面与大厅的背景音乐',
      value: () => getSettings().bgm !== false,
      onChange: (on) => {
        store.set('settings.bgm', on);
        try {
          if (on) H.audio.playBgm('lobby');
          else H.audio.stopBgm();
        } catch (err) {
          /* 音频未就绪时忽略 */
        }
      }
    });

    const synthToggle = toggleRow(H, {
      label: '程序化音乐合成',
      hint: '用 Web Audio 离线渲染整曲（关闭后音游无音乐，但更省资源、启动更快）',
      value: () => getSettings().musicSynth !== false,
      onChange: (on) => {
        store.set('settings.musicSynth', on);
        try {
          if (H.audio.engine && typeof H.audio.engine.setMusicSynthEnabled === 'function') {
            H.audio.engine.setMusicSynthEnabled(on);
          }
        } catch (err) {
          /* 忽略 */
        }
        H.notify(on ? '已开启音乐合成' : '已关闭音乐合成', on ? '下次游玩会重新合成曲目音频' : '音游将以无音乐模式运行（判定不受影响）');
      }
    });

    const previewBox = H.el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '4px 0' } });
    for (const name of SFX_NAMES) {
      previewBox.appendChild(
        H.el('button', {
          className: 'ph-btn sm',
          textContent: '试听 ' + name,
          onclick: () => {
            try {
              H.audio.sfx(name);
            } catch (err) {
              H.notify('设置', '音效播放失败', { level: 'warn' });
            }
          }
        })
      );
    }

    addPanel(
      'sound',
      [
        makeCard(H, '音量与开关', [volumeSlider.row, sfxToggle.row, bgmToggle.row, synthToggle.row]),
        makeCard(H, '音效试听', [previewBox])
      ],
      [volumeSlider.sync, sfxToggle.sync, bgmToggle.sync, synthToggle.sync]
    );

    // ================= 音游 =================
    const renderModeRow = (() => {
      const wrap = H.el('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '12px' } });
      const left = H.el('div', { style: { display: 'flex', flexDirection: 'column' } });
      left.appendChild(H.el('div', { className: 'ph-sub', style: { color: 'var(--fg)' }, textContent: '渲染后端' }));
      left.appendChild(
        H.el('div', {
          className: 'ph-sub',
          style: { fontSize: '11px' },
          textContent: 'DOM：音符用 CSS transform 交给合成器（默认，最流畅，弱显卡也不会掉帧）；Canvas：传统 2D 逐像素绘制'
        })
      );
      const sel = H.el('select', { className: 'ph-select', style: { minWidth: '130px' } });
      sel.appendChild(H.el('option', { value: 'dom', textContent: 'DOM（推荐）' }));
      sel.appendChild(H.el('option', { value: 'canvas', textContent: 'Canvas 2D' }));
      sel.value = getSettings().renderMode === 'canvas' ? 'canvas' : 'dom';
      sel.addEventListener('change', () => {
        store.set('settings.renderMode', sel.value === 'canvas' ? 'canvas' : 'dom');
        H.notify('已切换渲染后端', sel.value === 'canvas' ? '下一局使用 Canvas 2D 渲染' : '下一局使用 DOM + CSS transform 渲染');
      });
      wrap.appendChild(left);
      wrap.appendChild(sel);
      return { row: wrap, sync: () => { sel.value = getSettings().renderMode === 'canvas' ? 'canvas' : 'dom'; } };
    })();

    const speedSlider = sliderRow(H, {
      label: '常规下落速度',
      min: 0.5,
      max: 2.0,
      step: 0.05,
      format: formatSpeed,
      hint: '1.00× 为标准速度；谱面下落像素速度 = 520 × 该倍率（按画布高度缩放）。',
      value: () => getSettings().speed,
      onInput: (v) => store.set('settings.speed', Math.round(v * 100) / 100)
    });

    const offsetSlider = sliderRow(H, {
      label: '判定偏移',
      min: -200,
      max: 200,
      step: 5,
      format: formatOffset,
      hint: '正值表示「音游判定整体延后」，负值表示「整体提前」。默念节奏总差半拍时按 10~30ms 微调。',
      value: () => getSettings().offsetMs,
      onInput: (v) => store.set('settings.offsetMs', Math.round(v))
    });

    const presetBox = H.el('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', padding: '4px 0' } });
    const SPEED_PRESETS = [0.75, 1.0, 1.25, 1.5, 2.0];
    for (const preset of SPEED_PRESETS) {
      presetBox.appendChild(
        H.el('button', {
          className: 'ph-btn sm',
          textContent: preset.toFixed(2) + '×',
          onclick: () => {
            store.set('settings.speed', preset);
            H.audio.sfx('click');
          }
        })
      );
    }

    const offsetResetBtn = H.el('button', {
      className: 'ph-btn sm',
      textContent: '偏移归零',
      onclick: () => {
        store.set('settings.offsetMs', 0);
        H.audio.sfx('click');
      }
    });

    addPanel(
      'rhythm',
      [
        makeCard(H, '渲染与性能', [renderModeRow.row]),
        makeCard(H, '下落速度', [speedSlider.row, presetBox]),
        makeCard(H, '判定与延迟', [offsetSlider.row, H.el('div', { style: { paddingTop: '4px' } }, offsetResetBtn)])
      ],
      [renderModeRow.sync, speedSlider.sync, offsetSlider.sync]
    );

    // ================= 数据 =================
    const dataGrid = infoGrid(H, []);
    const storageLine = H.el('div', { className: 'ph-sub', style: { fontSize: '12px', paddingTop: '6px' } });

    function refreshData() {
      const state = store.get();
      const player = state.player || {};
      const achievements = state.achievements || {};
      let unlocked = 0;
      for (const key of Object.keys(achievements)) {
        if (achievements[key] && achievements[key].unlocked) unlocked += 1;
      }
      let appCount = 0;
      try {
        const list = H.apps();
        appCount = Array.isArray(list) ? list.length : 0;
      } catch (err) {
        appCount = 0;
      }
      const bytes = estimateLocalStorageBytes(safeLocalStorage());
      const rows = [
        ['RKS', (Number.isFinite(Number(player.rks)) ? Number(player.rks) : 0).toFixed(4)],
        ['累计游玩', String(player.totalPlay == null ? 0 : player.totalPlay) + ' 次'],
        ['已解锁成就', String(unlocked) + ' 个'],
        ['曲目记录', String(Object.keys(player.record || {}).length) + ' 首'],
        ['文件数', String(Object.keys(state.fs || {}).length) + ' 个节点'],
        ['窗口数', String((state.windows || []).length)],
        ['已登记应用', String(appCount) + ' 个'],
        ['localStorage 占用', formatBytes(bytes)]
      ];
      dataGrid.textContent = '';
      const rebuilt = infoGrid(H, rows);
      for (const child of Array.from(rebuilt.children)) dataGrid.appendChild(child);
      storageLine.textContent =
        '占用为估算值（UTF-16，每字符 2 字节），包含所有 localhost 同源键；浏览器通常限额约 5 MB。';
    }

    const exportBtn = H.el('button', {
      className: 'ph-btn primary',
      textContent: '导出存档',
      onclick: () => {
        try {
          const size = writeSaveFile(H, root, objectUrls, timers);
          H.audio.sfx('ok');
          H.notify('导出存档', '已生成 phigros-os-save.json（约 ' + formatBytes(size) + '）', { icon: '💾' });
        } catch (err) {
          H.notify('导出失败', err && err.message ? err.message : '浏览器不支持 Blob 下载', { level: 'error' });
        }
      }
    });

    const resetBtn = H.el('button', {
      className: 'ph-btn danger',
      textContent: '重置全部数据',
      onclick: async () => {
        H.audio.sfx('click');
        let ok = false;
        try {
          ok = await H.dialog({
            title: '重置全部数据',
            body: '将清除存档、成绩、成就、设置与虚拟文件系统的全部内容，且无法撤销。确定继续吗？',
            confirm: true,
            danger: true
          });
        } catch (err) {
          ok = false;
        }
        if (!ok) return;
        try {
          store.reset();
          store.save();
        } catch (err) {
          H.notify('重置失败', '无法写入本地存储', { level: 'error' });
          return;
        }
        H.notify('phigrOS', '数据已重置，正在重新加载…', { icon: '♻️' });
        try {
          if (win && win.location && typeof win.location.reload === 'function') win.location.reload();
        } catch (err) {
          /* 无法自动刷新时保持当前界面 */
        }
      }
    });

    addPanel(
      'data',
      [
        makeCard(H, '存档概览', [dataGrid, storageLine]),
        makeCard(H, '操作', [
          H.el('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', padding: '4px 0' } }, exportBtn, resetBtn),
          H.el('div', {
            className: 'ph-sub',
            style: { fontSize: '11px' },
            textContent: '导出的 JSON 含完整状态快照，可用于备份或排查问题。'
          })
        ])
      ],
      [refreshData]
    );

    // ================= 双向同步 =================
    function syncAll() {
      for (const fn of syncers) {
        try {
          fn();
        } catch (err) {
          /* 单个控件同步失败不影响其他控件 */
        }
      }
    }
    syncers.push(
      hueSlider.sync,
      wallpaperRow.sync,
      scanlineToggle.sync,
      smoothToggle.sync,
      fpsToggle.sync,
      renderModeRow.sync,
      volumeSlider.sync,
      sfxToggle.sync,
      bgmToggle.sync,
      synthToggle.sync,
      speedSlider.sync,
      offsetSlider.sync,
      refreshData
    );

    unsubs.push(
      store.subscribe('settings', () => {
        syncAll();
      })
    );
    unsubs.push(
      store.subscribe('player', () => {
        refreshData();
      })
    );
    unsubs.push(
      store.subscribe('achievements', () => {
        refreshData();
      })
    );
    unsubs.push(
      store.subscribe('windows', () => {
        refreshData();
      })
    );

    // 首次进入：把当前状态应用到界面（含扫描线 class）
    applyScanlineClass(getSettings().scanlines !== false);
    showPanel('appearance');
    syncAll();

    return {
      destroy() {
        while (unsubs.length) {
          const off = unsubs.pop();
          try {
            if (typeof off === 'function') off();
          } catch (err) {
            /* 忽略 */
          }
        }
        while (timers.length) {
          clearTimeout(timers.pop());
        }
        while (objectUrls.length) {
          try {
            URL.revokeObjectURL(objectUrls.pop());
          } catch (err) {
            /* 忽略 */
          }
        }
        // 与当前 settings.scanlines 对齐（而不是恢复进入前的旧快照，避免与持久化状态矛盾）
        applyScanlineClass(getSettings().scanlines !== false);
      },
      onFocus() {
        syncAll();
      },
      onResize() {
        refreshData();
      }
    };
  }
};
