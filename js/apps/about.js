// about.js —— 「关于 phigrOS」应用
//
// 注意：本模块顶层绝对不能访问 window / document（node 自测会 import 它）。
// 所有浏览器相关读取都发生在 mount 内部或接收外部对象作参数的纯函数里。

/** 成就定义（展示用）。解锁由各应用调用 Host.achievement(id, title, desc) 完成。 */
export const ACHIEVEMENTS = [
  { id: 'boot', title: '初次开机', desc: '第一次启动 phigrOS 并进入桌面', icon: '🌅' },
  { id: 'first-play', title: '初见节奏', desc: '完成第一次音游游玩', icon: '🎵' },
  { id: 'first-fc', title: '全连达成', desc: '在一首曲目中达成 FC（零 miss）', icon: '🔗' },
  { id: 'grade-s', title: 'S 评级', desc: '任意曲目取得 S 评级', icon: '🏆' },
  { id: 'extra-clear', title: 'Extra 通关', desc: '通关一首 Extra 难度曲目', icon: '🔥' },
  { id: 'play-10', title: '十连奏', desc: '累计游玩次数达到 10 次', icon: '🎯' },
  { id: 'terminal-unlock', title: '终端大师', desc: '打开过终端应用', icon: '⌨️' },
  { id: 'theme-hue', title: '色彩调节', desc: '修改过主题色相', icon: '🎨' },
  { id: 'collector', title: '收藏家', desc: '解锁 5 个成就', icon: '💎' }
];

/** 读取系统版本，缺省 '1.0.0'（可传入任意作用域对象，便于测试） */
export function readVersion(scope) {
  const g = scope || (typeof globalThis !== 'undefined' ? globalThis : null);
  const v = g && g.PhigrOS ? g.PhigrOS.version : null;
  return v === null || v === undefined || v === '' ? '1.0.0' : String(v);
}

/** 把 state.achievements 与定义表合并成展示用列表 */
export function achievementView(achievements, defs = ACHIEVEMENTS) {
  const record = achievements && typeof achievements === 'object' ? achievements : {};
  return defs.map((def) => {
    const entry = record[def.id];
    const unlocked = !!(entry && entry.unlocked);
    return {
      id: def.id,
      title: def.title,
      desc: def.desc,
      icon: def.icon,
      unlocked,
      at: unlocked && Number.isFinite(entry.at) ? entry.at : 0
    };
  });
}

/** 已解锁成就数 */
export function unlockedCount(achievements) {
  if (!achievements || typeof achievements !== 'object') return 0;
  let n = 0;
  for (const key of Object.keys(achievements)) {
    const entry = achievements[key];
    if (entry && entry.unlocked) n += 1;
  }
  return n;
}

/** 启动耗时格式化 */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n < 1000) return Math.round(n) + ' ms';
  return (n / 1000).toFixed(2) + ' s';
}

/** 精简 UserAgent 描述 */
export function describeUA(ua) {
  const s = typeof ua === 'string' ? ua : '';
  if (!s) return '未知浏览器';
  const parts = [];
  if (/Windows NT 10\.0/.test(s)) parts.push('Windows 10/11');
  else if (/Windows/.test(s)) parts.push('Windows');
  else if (/Mac OS X|Macintosh/.test(s)) parts.push('macOS');
  else if (/Android/.test(s)) parts.push('Android');
  else if (/iPhone|iPad|iOS/.test(s)) parts.push('iOS');
  else if (/Linux/.test(s)) parts.push('Linux');
  const engine = /Edg\/([\d.]+)/.exec(s);
  const chrome = /Chrome\/([\d.]+)/.exec(s);
  const firefox = /Firefox\/([\d.]+)/.exec(s);
  const safari = /Version\/([\d.]+).*Safari/.test(s);
  if (engine) parts.push('Edge ' + engine[1].split('.')[0]);
  else if (chrome) parts.push('Chrome ' + chrome[1].split('.')[0]);
  else if (firefox) parts.push('Firefox ' + firefox[1].split('.')[0]);
  else if (safari) parts.push('Safari');
  if (/HeadlessChrome/.test(s)) parts.push('(headless)');
  if (!parts.length) return s.slice(0, 60);
  return parts.join(' · ');
}

/** localStorage 是否可用（不抛异常且能读写） */
export function storageAvailable(storage) {
  try {
    if (!storage) return false;
    const k = '__phigros_probe__';
    storage.setItem(k, '1');
    const ok = storage.getItem(k) === '1';
    storage.removeItem(k);
    return ok;
  } catch (err) {
    return false;
  }
}

function makeSection(H, title, body) {
  return H.el(
    'div',
    { className: 'ph-card', style: { padding: '12px 14px', marginBottom: '12px' } },
    H.el('div', { className: 'ph-title', style: { marginBottom: '8px' }, textContent: title }),
    body
  );
}

function makeInfoGrid(H, rows) {
  const grid = H.el('div', {
    className: 'ph-grid',
    style: { display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '6px 14px', fontSize: '13px' }
  });
  for (const [label, value] of rows) {
    grid.appendChild(H.el('div', { className: 'ph-sub', textContent: label }));
    grid.appendChild(
      H.el('div', { className: 'ph-mono', style: { color: 'var(--fg)', wordBreak: 'break-all' }, textContent: value })
    );
  }
  return grid;
}

export default {
  id: 'about',
  name: '关于 phigrOS',
  icon: '💠',
  desc: '系统信息、版本与成就一览',
  singleton: true,
  width: 520,
  height: 420,
  accent: '#a78bfa',

  async mount(root, ctx) {
    const H = globalThis.Host;
    const win = typeof globalThis.window !== 'undefined' ? globalThis.window : null;
    const store = H.store;
    const unsubs = [];

    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.height = '100%';

    const scroll = H.el('div', {
      className: 'ph-scroll',
      style: { flex: '1 1 auto', overflowY: 'auto', padding: '16px' }
    });
    root.appendChild(scroll);

    // —— 头部 logo ——
    const header = H.el('div', { style: { textAlign: 'center', marginBottom: '14px' } });
    header.appendChild(
      H.el('div', {
        textContent: 'phigrOS',
        style: {
          fontSize: '34px',
          fontWeight: '700',
          letterSpacing: '1px',
          color: 'var(--accent)',
          textShadow: '0 0 18px var(--accent)'
        }
      })
    );
    const versionLine = H.el('div', {
      className: 'ph-sub',
      style: { marginTop: '2px' },
      textContent: 'v' + readVersion(win)
    });
    header.appendChild(versionLine);
    header.appendChild(
      H.el('div', {
        className: 'ph-sub',
        style: { marginTop: '4px', fontStyle: 'italic' },
        textContent: 'An OS tuned for rhythm games'
      })
    );
    scroll.appendChild(header);

    // —— 系统信息 ——
    const infoGrid = makeInfoGrid(H, []);
    const achievementBox = H.el('div', {});
    const achievementSummary = H.el('div', {
      className: 'ph-sub',
      style: { marginBottom: '8px' }
    });
    scroll.appendChild(makeSection(H, '系统信息', infoGrid));
    scroll.appendChild(
      makeSection(
        H,
        '成就',
        H.el('div', {}, achievementSummary, achievementBox)
      )
    );

    // —— 底部操作栏 ——
    const footer = H.el('div', {
      className: 'ph-toolbar',
      style: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '8px',
        padding: '10px 14px',
        borderTop: '1px solid var(--line)'
      }
    });
    const hint = H.el('span', { className: 'ph-sub', textContent: '所有数据保存在本机 localStorage' });
    const rebootBtn = H.el('button', {
      className: 'ph-btn primary',
      textContent: '重启系统',
      onclick: () => {
        H.audio.sfx('click');
        H.notify('phigrOS', '正在重新启动…', { icon: '🔁', timeout: 1600 });
        Promise.resolve(H.power('reboot')).catch(() => {});
      }
    });
    footer.appendChild(hint);
    footer.appendChild(rebootBtn);
    root.appendChild(footer);

    function refreshInfo() {
      const state = store.get();
      const boot = state.boot || {};
      const settings = state.settings || {};
      let appCount = 0;
      try {
        const list = H.apps();
        appCount = Array.isArray(list) ? list.length : 0;
      } catch (err) {
        appCount = 0;
      }
      const viewW = win ? win.innerWidth : 0;
      const viewH = win ? win.innerHeight : 0;
      const screenW = win && win.screen ? win.screen.width : 0;
      const screenH = win && win.screen ? win.screen.height : 0;
      const dpr = win && win.devicePixelRatio ? win.devicePixelRatio : 1;
      const ua = win && win.navigator ? win.navigator.userAgent : '';
      const storageOk = storageAvailable(win ? win.localStorage : null);
      const storageBytes = (() => {
        try {
          const ls = win && win.localStorage;
          if (!ls) return 0;
          let bytes = 0;
          for (let i = 0; i < ls.length; i += 1) {
            const k = ls.key(i);
            if (k === null) continue;
            const v = ls.getItem(k);
            bytes += (k.length + (v ? v.length : 0)) * 2;
          }
          return bytes;
        } catch (err) {
          return 0;
        }
      })();

      const rows = [
        ['内核版本', 'phigrOS ' + readVersion(win)],
        ['启动耗时', formatDuration(boot.bootTimeMs)],
        ['启动次数', String(boot.bootCount == null ? 0 : boot.bootCount)],
        ['启动时间', boot.lastBootAt ? new Date(boot.lastBootAt).toLocaleString('zh-CN') : '—'],
        ['屏幕分辨率', screenW && screenH ? screenW + ' × ' + screenH + ' px' : '未知'],
        ['视口尺寸', viewW + ' × ' + viewH + ' px'],
        ['设备像素比', 'devicePixelRatio = ' + dpr],
        ['浏览器', describeUA(ua)],
        ['localStorage', storageOk ? '可用（约 ' + bytesText(storageBytes) + '）' : '不可用'],
        ['打开窗口数', String((state.windows || []).length)],
        ['已登记应用', String(appCount) + ' 个'],
        ['主题色相', String(settings.themeHue == null ? 190 : settings.themeHue) + '°']
      ];
      infoGrid.textContent = '';
      const rebuilt = makeInfoGrid(H, rows);
      for (const child of Array.from(rebuilt.children)) infoGrid.appendChild(child);
    }

    function bytesText(n) {
      if (n < 1024) return n + ' B';
      if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
      return (n / 1024 / 1024).toFixed(2) + ' MB';
    }

    function refreshAchievements() {
      const state = store.get();
      const list = achievementView(state.achievements);
      const unlocked = list.filter((a) => a.unlocked).length;
      achievementSummary.textContent = '已解锁 ' + unlocked + ' / ' + list.length;
      achievementBox.textContent = '';
      const grid = H.el('div', {
        style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: '8px' }
      });
      for (const item of list) {
        const row = H.el('div', {
          title: item.unlocked ? item.desc : '尚未解锁',
          style: {
            display: 'flex',
            alignItems: 'center',
            gap: '8px',
            padding: '8px 10px',
            borderRadius: 'var(--radius)',
            border: '1px solid var(--line)',
            background: item.unlocked ? 'var(--bg-2)' : 'transparent',
            opacity: item.unlocked ? '1' : '0.42',
            filter: item.unlocked ? 'none' : 'grayscale(1)'
          }
        });
        row.appendChild(
          H.el('span', {
            textContent: item.unlocked ? item.icon : '❔',
            style: { fontSize: '18px', lineHeight: '1' }
          })
        );
        const textCol = H.el('div', { style: { minWidth: '0' } });
        textCol.appendChild(
          H.el('div', {
            className: 'ph-sub',
            style: { color: 'var(--fg)', fontWeight: '600' },
            textContent: item.unlocked ? item.title : '？？？'
          })
        );
        textCol.appendChild(
          H.el('div', {
            className: 'ph-sub',
            style: { fontSize: '11px', opacity: '0.8' },
            textContent: item.unlocked ? item.desc : '未解锁'
          })
        );
        row.appendChild(textCol);
        grid.appendChild(row);
      }
      achievementBox.appendChild(grid);
    }

    function refreshAll() {
      refreshInfo();
      refreshAchievements();
    }

    refreshAll();
    unsubs.push(store.subscribe('boot', refreshInfo));
    unsubs.push(store.subscribe('windows', refreshInfo));
    unsubs.push(store.subscribe('settings', refreshInfo));
    unsubs.push(store.subscribe('achievements', refreshAchievements));
    unsubs.push(
      H.wm.on('open', () => refreshInfo())
    );
    unsubs.push(
      H.wm.on('close', () => refreshInfo())
    );

    return {
      destroy() {
        while (unsubs.length) {
          const off = unsubs.pop();
          try {
            if (typeof off === 'function') off();
          } catch (err) {
            /* 忽略取消订阅异常 */
          }
        }
      },
      onFocus() {
        refreshAll();
      },
      onResize() {
        refreshInfo();
      },
      onOpen() {
        refreshAll();
      }
    };
  }
};
