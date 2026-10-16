/**
 * phigrOS · js/core/compositor.js
 * 桌面合成器：墙纸 / 桌面图标 / 开始菜单 / 右键菜单 / 主题 / FPS。
 */
import { HUE_PALETTES } from './palette.js';

const WALLPAPERS = ['aurora', 'grid', 'solid'];

export function createCompositor(ctx) {
  const { state, kernel } = ctx;
  const doc = kernel.document;
  let root = null;
  let unsubs = [];
  let rafCancel = null;
  let fpsTimer = null;
  let lastFrame = { t: 0, count: 0, fps: 60 };

  const api = { ctx, mount, applyTheme, startMenu: null };

  // ---------------- 主题 ----------------
  function applyTheme() {
    const s = state.raw().settings;
    const hue = Number(s.themeHue) || 190;
    const pal = pickPalette(hue);
    const cs = doc.documentElement.style;
    cs.setProperty('--accent', pal.accent);
    cs.setProperty('--accent-2', pal.accent2);
    cs.setProperty('--accent-soft', pal.soft);
    cs.setProperty('--hue', String(hue));
    doc.documentElement.classList.toggle('no-scanlines', !s.scanlines);
    // 流畅模式：关掉一切昂贵合成（弱 GPU / 远程桌面 / 省电模式）
    doc.documentElement.classList.toggle('smooth-mode', Boolean(s.smoothMode));
    applyWallpaper(s);
    if (api.desktop) api.desktop.refresh();
  }

  function pickPalette(hue) {
    // 找到最接近的预设，保证配色都好看
    let best = HUE_PALETTES[0];
    let bestDist = Infinity;
    for (const p of HUE_PALETTES) {
      const d = Math.min(Math.abs(p.h - hue), 360 - Math.abs(p.h - hue));
      if (d < bestDist) {
        bestDist = d;
        best = p;
      }
    }
    if (bestDist <= 12) return best;
    // 自定义色相：用 HSL 直接生成
    return {
      h: hue,
      accent: `hsl(${hue} 92% 62%)`,
      accent2: `hsl(${(hue + 42) % 360} 90% 66%)`,
      soft: `hsl(${hue} 80% 60% / 0.16)`
    };
  }

  function applyWallpaper(s) {
    const layer = doc.getElementById('wallpaper');
    if (!layer) return;
    const kind = (api.desktop && api.desktop.wallpaperKind()) || 'aurora';
    layer.className = `wallpaper wp-${WALLPAPERS.includes(kind) ? kind : 'aurora'}`;
    layer.style.setProperty('--wp-accent', `hsl(${Number(s.themeHue) || 190} 90% 60%)`);
  }

  // ---------------- 开始菜单 ----------------
  const startMenu = {
    open() {
      const menu = doc.getElementById('start-menu');
      if (!menu) return;
      menu.classList.add('open');
      api.startMenuEl && api.startMenuEl.classList.add('on');
      renderStartList('');
    },
    close() {
      const menu = doc.getElementById('start-menu');
      if (!menu) return;
      menu.classList.remove('open');
      api.startMenuEl && api.startMenuEl.classList.remove('on');
    },
    toggle() {
      const menu = doc.getElementById('start-menu');
      if (!menu) return;
      if (menu.classList.contains('open')) startMenu.close();
      else startMenu.open();
    },
    isOpen() {
      const menu = doc.getElementById('start-menu');
      return Boolean(menu && menu.classList.contains('open'));
    }
  };
  api.startMenu = startMenu;

  function renderStartList(query) {
    const listEl = doc.getElementById('start-list');
    if (!listEl) return;
    listEl.textContent = '';
    const list = kernel.host ? kernel.host.apps({ q: query }) : [];
    if (list.length === 0) {
      listEl.appendChild(el('div', 'start-empty', query ? '没有匹配的应用' : '没有可用的应用'));
      return;
    }
    for (const app of list) {
      const item = el('button', 'start-item');
      item.type = 'button';
      item.appendChild(el('span', 'start-item-icon', app.icon || '▢'));
      const main = el('span', 'start-item-main');
      main.appendChild(el('span', 'start-item-name', app.name));
      if (app.desc) main.appendChild(el('span', 'start-item-desc', app.desc));
      item.appendChild(main);
      item.addEventListener('click', () => {
        startMenu.close();
        kernel.host.launch(app.id);
      });
      listEl.appendChild(item);
    }
  }

  function el(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // ---------------- 桌面图标 ----------------
  const DESKTOP_APPS = ['phigros', 'terminal', 'files', 'settings', 'about'];

  function renderDesktopIcons() {
    const layer = doc.getElementById('desktop-icons');
    if (!layer) return;
    layer.textContent = '';
    const apps = kernel.host ? kernel.host.apps() : [];
    for (const id of DESKTOP_APPS) {
      const app = apps.find((a) => a.id === id);
      if (!app) continue;
      layer.appendChild(desktopIcon(app.icon || '▢', app.name, () => kernel.host.launch(app.id)));
    }
    // /home/Desktop 下的文本文件快捷方式
    const files = kernel.host ? kernel.host.fs.list('/home/Desktop') : [];
    for (const f of files) {
      layer.appendChild(desktopIcon(f.type === 'dir' ? '📁' : '📄', f.name, () => kernel.host.openFile(f.path)));
    }
  }

  function desktopIcon(icon, label, onOpen) {
    const node = el('button', 'dicon');
    node.type = 'button';
    node.appendChild(el('span', 'dicon-icon', icon));
    node.appendChild(el('span', 'dicon-label', label));
    node.title = label;
    node.addEventListener('dblclick', onOpen);
    node.addEventListener('click', () => {
      doc.querySelectorAll('.dicon.sel').forEach((n) => n.classList.remove('sel'));
      node.classList.add('sel');
    });
    return node;
  }

  // ---------------- 右键菜单 ----------------
  function closeContext() {
    const old = doc.getElementById('ctx-menu');
    if (old) old.remove();
  }

  function openContext(x, y, items) {
    closeContext();
    const menu = el('div', 'ctx-menu');
    menu.id = 'ctx-menu';
    for (const item of items) {
      if (item.sep) {
        menu.appendChild(el('div', 'ctx-sep'));
        continue;
      }
      const btn = el('button', 'ctx-item', item.label);
      btn.type = 'button';
      btn.disabled = Boolean(item.disabled);
      if (item.hint) btn.appendChild(el('span', 'ctx-hint', item.hint));
      btn.addEventListener('click', () => {
        closeContext();
        item.action && item.action();
      });
      menu.appendChild(btn);
    }
    doc.body.appendChild(menu);
    const rect = menu.getBoundingClientRect();
    menu.style.left = `${Math.min(x, win().innerWidth - rect.width - 8)}px`;
    menu.style.top = `${Math.min(y, win().innerHeight - rect.height - 8)}px`;
    return menu;
  }

  function win() {
    return doc.defaultView;
  }

  // ---------------- FPS ----------------
  function tick(dt) {
    lastFrame.t += dt;
    lastFrame.count += 1;
    if (lastFrame.t >= 500) {
      lastFrame.fps = Math.round((lastFrame.count * 1000) / lastFrame.t);
      lastFrame.t = 0;
      lastFrame.count = 0;
      const badge = doc.getElementById('tb-fps');
      if (badge && state.raw().settings.showFps) badge.textContent = `${lastFrame.fps} FPS`;
    }
  }

  // ---------------- 装配 ----------------
  function mount() {
    const desktopEl = doc.getElementById('desktop');
    root = el('div', 'desktop-layer');
    root.id = 'desktop-icons';
    const startMenuEl = doc.getElementById('start-menu');
    if (startMenuEl && !startMenuEl.dataset.built) {
      startMenuEl.dataset.built = '1';
      const head = el('div', 'start-head');
      head.appendChild(el('div', 'start-logo', 'phigrOS'));
      head.appendChild(el('div', 'start-sub', 'An OS tuned for rhythm games'));
      const search = doc.createElement('input');
      search.className = 'ph-input start-search';
      search.placeholder = '搜索应用…';
      search.id = 'start-search';
      search.addEventListener('input', () => renderStartList(search.value));
      search.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          const first = doc.querySelector('#start-list .start-item');
          if (first) first.click();
        } else if (e.key === 'Escape') {
          startMenu.close();
        }
      });
      const list = el('div', 'start-list');
      list.id = 'start-list';
      const foot = el('div', 'start-foot');
      const reboot = el('button', 'ph-btn ghost sm', '重启系统');
      reboot.type = 'button';
      reboot.addEventListener('click', () => {
        startMenu.close();
        kernel.host.power('reboot');
      });
      foot.appendChild(reboot);
      startMenuEl.append(head, search, list, foot);
    }

    desktopEl.appendChild(root);
    renderDesktopIcons();

    // 桌面右键
    desktopEl.addEventListener('contextmenu', (e) => {
      if (e.target.closest('.win') || e.target.closest('#taskbar') || e.target.closest('#start-menu')) return;
      e.preventDefault();
      openContext(e.clientX, e.clientY, [
        { label: '新建文本文件', action: createDesktopFile },
        { label: '新建文件夹', action: createDesktopFolder },
        { sep: true },
        { label: '打开文件管理器', action: () => kernel.host.launch('files') },
        { label: '打开终端', action: () => kernel.host.launch('terminal') },
        { sep: true },
        {
          label: '更换墙纸',
          action: () => {
            const cur = api.desktop.wallpaperKind();
            const idx = WALLPAPERS.indexOf(cur);
            api.desktop.setWallpaperKind(WALLPAPERS[(idx + 1) % WALLPAPERS.length]);
          }
        },
        { label: '系统设置', action: () => kernel.host.launch('settings') }
      ]);
    });

    // 点击别处关闭菜单
    doc.addEventListener('pointerdown', (e) => {
      if (!e.target.closest('#start-menu') && !e.target.closest('.tb-start')) startMenu.close();
      if (!e.target.closest('#ctx-menu')) closeContext();
    });

    // 快捷键
    doc.addEventListener('keydown', onKeyDown);

    unsubs.push(state.subscribe('settings', () => applyTheme()));
    unsubs.push(state.subscribe('fs', () => renderDesktopIcons()));
    rafCancel = kernel.host.raf((dt) => tick(dt));
    return api;
  }

  function onKeyDown(e) {
    const target = e.target;
    const typing = target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable);
    if (e.key === 'Escape') {
      startMenu.close();
      closeContext();
      return;
    }
    if (typing) return;
    if (e.key === 'Meta' || (e.ctrlKey && e.key === ' ')) {
      e.preventDefault();
      startMenu.toggle();
    }
    if (e.key === 'F5' && e.ctrlKey) {
      e.preventDefault();
      kernel.host.power('reboot');
    }
  }

  function createDesktopFile() {
    const name = `新建文本 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}.txt`;
    const path = `/home/Desktop/${name}`;
    kernel.host.fs.write(path, '');
    kernel.host.notify('已创建', path);
    kernel.host.launch('notes', { file: path });
  }

  function createDesktopFolder() {
    const name = `新建文件夹 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
    kernel.host.fs.mkdir(`/home/Desktop/${name}`);
    kernel.host.notify('已创建文件夹', `/home/Desktop/${name}`);
  }

  // ---------------- desktop 门面 ----------------
  api.desktop = {
    wallpaperKind() {
      const fs = kernel.host && kernel.host.fs;
      const raw = fs && fs.read('/system/wallpaper') ;
      const kind = (raw && raw.trim()) || state.raw().settings.wallpaper || 'aurora';
      return WALLPAPERS.includes(kind) ? kind : 'aurora';
    },
    setWallpaperKind(kind) {
      const k = WALLPAPERS.includes(kind) ? kind : 'aurora';
      state.set('settings.wallpaper', k);
      applyWallpaper(state.raw().settings);
    },
    refresh() {
      renderDesktopIcons();
      applyWallpaper(state.raw().settings);
    },
    fps() {
      return lastFrame.fps;
    }
  };

  api.destroy = function destroy() {
    for (const u of unsubs) {
      try {
        u();
      } catch (_e) {
        /* ignore */
      }
    }
    unsubs = [];
    if (rafCancel) rafCancel();
    if (fpsTimer) clearInterval(fpsTimer);
    doc.removeEventListener('keydown', onKeyDown);
    doc.removeEventListener('pointerdown', closeContext);
  };

  return api;
}

export default createCompositor;
