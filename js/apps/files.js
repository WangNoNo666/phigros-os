// files.js —— 「文件管理器」应用
//
// 只通过 Host.fs（CONTRACT §3）读写虚拟文件系统，不直接改 store.fs。
// 顶层不得触碰 window / document。

/** 归一化绝对路径 */
export function normalizePath(input) {
  if (typeof input !== 'string') return '/';
  let s = input.trim().replace(/\\/g, '/');
  if (!s) return '/';
  if (!s.startsWith('/')) s = '/' + s;
  s = s.replace(/\/{2,}/g, '/');
  if (s.length > 1) s = s.replace(/\/+$/, '');
  return s || '/';
}

/** 父目录（'/' 返回 null） */
export function parentPath(path) {
  const p = normalizePath(path);
  if (p === '/') return null;
  const i = p.lastIndexOf('/');
  return i <= 0 ? '/' : p.slice(0, i);
}

/** 路径最后一段 */
export function baseName(path) {
  const p = normalizePath(path);
  if (p === '/') return '/';
  return p.slice(p.lastIndexOf('/') + 1);
}

/** 拼接子路径 */
export function joinPath(dir, name) {
  const d = normalizePath(dir);
  const n = String(name == null ? '' : name).trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!n) return d;
  return d === '/' ? '/' + n : d + '/' + n;
}

/** 小写扩展名（含点），无扩展名返回 '' */
export function extOf(name) {
  const s = String(name == null ? '' : name);
  const i = s.lastIndexOf('.');
  if (i <= 0 || i === s.length - 1) return '';
  return s.slice(i).toLowerCase();
}

/** 谱面文件（双击交给音游应用） */
export function isChartFile(name) {
  const ext = extOf(name);
  return ext === '.phigros' || ext === '.json';
}

/** 文件名是否合法（不含分隔符，非空，非 . / ..） */
export function isValidName(name) {
  const s = String(name == null ? '' : name).trim();
  if (!s) return false;
  if (s === '.' || s === '..') return false;
  if (s.indexOf('/') !== -1 || s.indexOf('\\') !== -1) return false;
  return true;
}

/** 字节数格式化 */
export function formatSize(bytes) {
  const v = Number(bytes);
  if (!Number.isFinite(v) || v <= 0) return '—';
  if (v < 1024) return v + ' B';
  if (v < 1024 * 1024) return (v / 1024).toFixed(1) + ' KB';
  return (v / 1024 / 1024).toFixed(2) + ' MB';
}

/** 修改时间格式化 */
export function formatMtime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '—';
  try {
    return new Date(n).toLocaleString('zh-CN', { hour12: false });
  } catch (err) {
    return String(n);
  }
}

/** 列表排序：目录优先，然后按中文名称 */
export function sortEntries(items) {
  const list = Array.isArray(items) ? items.slice() : [];
  list.sort((a, b) => {
    const ad = a && a.type === 'dir' ? 0 : 1;
    const bd = b && b.type === 'dir' ? 0 : 1;
    if (ad !== bd) return ad - bd;
    return String(a && a.name).localeCompare(String(b && b.name), 'zh');
  });
  return list;
}

/** 按扩展名取图标 */
export function iconFor(item) {
  if (!item) return '📄';
  if (item.type === 'dir') return '📁';
  const ext = extOf(item.name);
  if (ext === '.phigros' || ext === '.json') return '🎵';
  if (ext === '.txt' || ext === '.md' || ext === '.log') return '📝';
  if (ext === '.js' || ext === '.mjs' || ext === '.css' || ext === '.html') return '⚙️';
  if (ext === '.png' || ext === '.jpg' || ext === '.jpeg' || ext === '.gif' || ext === '.webp') return '🖼️';
  if (ext === '.wav' || ext === '.mp3' || ext === '.ogg') return '🎧';
  return '📄';
}

export default {
  id: 'files',
  name: '文件管理器',
  icon: '📁',
  desc: '浏览与管理 phigrOS 虚拟文件系统',
  singleton: false,
  width: 760,
  height: 500,
  accent: '#f59e0b',

  async mount(root, ctx) {
    const H = globalThis.Host;
    const win = typeof globalThis.window !== 'undefined' ? globalThis.window : null;
    const doc = root.ownerDocument || (win ? win.document : null);

    let cwd = '/';
    let selected = null;
    const expanded = new Set(['/']);

    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.height = '100%';
    root.tabIndex = 0;

    // ---------- 工具栏 ----------
    const toolbar = H.el('div', {
      className: 'ph-toolbar',
      style: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        gap: '6px',
        padding: '8px 10px',
        borderBottom: '1px solid var(--line)',
        flexWrap: 'wrap'
      }
    });
    const upBtn = H.el('button', { className: 'ph-btn sm', textContent: '← 上级', title: '返回上级目录（Backspace）' });
    const addressInput = H.el('input', {
      className: 'ph-input ph-mono',
      type: 'text',
      spellcheck: 'false',
      placeholder: '/path/to/dir',
      style: { flex: '1 1 160px', minWidth: '120px' },
      title: '输入绝对路径后回车跳转'
    });
    const mkdirBtn = H.el('button', { className: 'ph-btn sm', textContent: '新建文件夹' });
    const newFileBtn = H.el('button', { className: 'ph-btn sm', textContent: '新建文本' });
    const renameBtn = H.el('button', { className: 'ph-btn sm', textContent: '重命名' });
    const deleteBtn = H.el('button', { className: 'ph-btn sm danger', textContent: '删除' });
    const copyBtn = H.el('button', { className: 'ph-btn sm', textContent: '复制路径' });
    toolbar.append(upBtn, addressInput, mkdirBtn, newFileBtn, renameBtn, deleteBtn, copyBtn);
    root.appendChild(toolbar);

    // ---------- 主体：左树 + 右列表 ----------
    const main = H.el('div', { style: { flex: '1 1 auto', display: 'flex', minHeight: '0' } });
    const treePane = H.el('div', {
      className: 'ph-scroll',
      style: {
        flex: '0 0 auto',
        width: '200px',
        overflow: 'auto',
        borderRight: '1px solid var(--line)',
        padding: '6px 4px',
        fontSize: '13px'
      }
    });
    const listPane = H.el('div', {
      className: 'ph-scroll',
      style: { flex: '1 1 auto', overflow: 'auto', minWidth: '0' }
    });
    main.append(treePane, listPane);
    root.appendChild(main);

    // ---------- 状态栏 ----------
    const statusBar = H.el('div', {
      className: 'ph-sub',
      style: {
        flex: '0 0 auto',
        padding: '6px 10px',
        borderTop: '1px solid var(--line)',
        fontSize: '12px',
        whiteSpace: 'nowrap',
        overflow: 'hidden',
        textOverflow: 'ellipsis'
      }
    });
    root.appendChild(statusBar);

    // ---------- 数据访问 ----------
    function safeList(path) {
      try {
        const items = H.fs.list(path);
        return Array.isArray(items) ? items : [];
      } catch (err) {
        return [];
      }
    }

    function safeStat(path) {
      try {
        return H.fs.stat(path);
      } catch (err) {
        return null;
      }
    }

    function setStatus(text) {
      statusBar.textContent = text;
      statusBar.title = text;
    }

    // ---------- 导航 ----------
    function go(path, opts = {}) {
      const target = normalizePath(path);
      const stat = safeStat(target);
      if (!stat || stat.type !== 'dir') {
        H.audio.sfx('error');
        H.notify('文件管理器', '目录不存在：' + target, { level: 'warn', icon: '📁' });
        return false;
      }
      cwd = target;
      if (!opts.keepSelection) selected = null;
      expanded.add(target);
      let cur = parentPath(target);
      while (cur && cur !== '/') {
        expanded.add(cur);
        cur = parentPath(cur);
      }
      refresh();
      return true;
    }

    function revealFile(filePath) {
      const p = normalizePath(filePath);
      const stat = safeStat(p);
      if (!stat) {
        setStatus('找不到文件：' + p);
        return;
      }
      if (stat.type === 'dir') {
        go(p);
        return;
      }
      const parent = parentPath(p) || '/';
      selected = p;
      go(parent, { keepSelection: true });
      selected = p;
      renderList();
      setStatus('已定位：' + p);
    }

    function openItem(item) {
      if (!item) return;
      H.audio.sfx('open');
      if (item.type === 'dir') {
        go(item.path);
        return;
      }
      if (isChartFile(item.name)) {
        // WM 的 launch 是 async，返回值可能是 Promise<windowId|null>
        let result = null;
        try {
          result = H.launch ? H.launch('phigros', { file: item.path }) : H.wm.launch('phigros', { file: item.path });
        } catch (err) {
          result = null;
        }
        const fallback = () => {
          H.notify('音游', '无法启动音游应用，已改用默认打开方式', { level: 'warn' });
          H.openFile(item.path);
        };
        if (result && typeof result.then === 'function') {
          result.then((id) => {
            if (id === null || id === undefined) fallback();
          }, fallback);
        } else if (result === null || result === undefined) {
          fallback();
        }
        return;
      }
      H.openFile(item.path);
    }

    // ---------- 目录树 ----------
    function renderTree() {
      treePane.textContent = '';
      const rootRow = treeRow('/', '💽', depth0Name('/'), 0);
      treePane.appendChild(rootRow);
      renderTreeChildren('/', 1);
    }

    function depth0Name(path) {
      return path === '/' ? '/' : baseName(path);
    }

    function treeRow(path, icon, label, depth) {
      const isCurrent = path === cwd;
      const row = H.el('div', {
        className: 'ph-row',
        title: path,
        style: {
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          padding: '4px 8px',
          paddingLeft: 8 + depth * 12 + 'px',
          borderRadius: '6px',
          cursor: 'pointer',
          background: isCurrent ? 'var(--bg-2)' : 'transparent',
          color: isCurrent ? 'var(--accent)' : 'var(--fg)',
          userSelect: 'none'
        }
      });
      row.appendChild(H.el('span', { textContent: icon, style: { flex: '0 0 auto' } }));
      row.appendChild(
        H.el('span', { textContent: label, style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } })
      );
      row.addEventListener('click', () => {
        H.audio.sfx('click');
        go(path);
      });
      return row;
    }

    function renderTreeChildren(dir, depth) {
      if (depth > 12) return; // 防御过深层级
      if (!expanded.has(dir)) return;
      for (const item of sortEntries(safeList(dir))) {
        if (item.type !== 'dir') continue;
        const isOpen = expanded.has(item.path);
        treePane.appendChild(treeRow(item.path, isOpen ? '📂' : '📁', item.name, depth));
        if (isOpen) renderTreeChildren(item.path, depth + 1);
      }
    }

    // ---------- 列表 ----------
    const GRID = 'minmax(140px, 1fr) 70px 90px 150px';

    function listHeader() {
      const head = H.el('div', {
        style: {
          display: 'grid',
          gridTemplateColumns: GRID,
          gap: '8px',
          padding: '8px 12px',
          borderBottom: '1px solid var(--line)',
          position: 'sticky',
          top: '0',
          background: 'var(--bg-1)',
          zIndex: '1',
          fontSize: '12px',
          color: 'var(--fg-dim)'
        }
      });
      for (const text of ['名称', '类型', '大小', '修改时间']) {
        head.appendChild(H.el('div', { textContent: text }));
      }
      return head;
    }

    function renderList() {
      listPane.textContent = '';
      const items = sortEntries(safeList(cwd));

      listPane.appendChild(listHeader());
      if (cwd !== '/') {
        listPane.appendChild(listRow({ name: '..', path: parentPath(cwd) || '/', type: 'dir', size: 0, mtime: 0 }, true));
      }
      if (!items.length) {
        listPane.appendChild(
          H.el('div', {
            className: 'ph-empty',
            style: { padding: '26px 16px', textAlign: 'center', color: 'var(--fg-dim)' },
            textContent: '这个目录是空的 · 用工具栏新建文件或文件夹'
          })
        );
      } else {
        for (const item of items) listPane.appendChild(listRow(item, false));
      }
      renderTree();
      updateToolbarState();
      if (!selected) {
        setStatus(cwd + ' · ' + items.length + ' 个项目');
      }
    }

    function listRow(item, isParent) {
      const isSelected = !isParent && selected === item.path;
      const row = H.el('div', {
        className: 'ph-row',
        title: item.path,
        style: {
          display: 'grid',
          gridTemplateColumns: GRID,
          gap: '8px',
          alignItems: 'center',
          padding: '6px 12px',
          cursor: 'pointer',
          background: isSelected ? 'var(--bg-2)' : 'transparent',
          boxShadow: isSelected ? 'inset 2px 0 0 var(--accent)' : 'none',
          fontSize: '13px'
        }
      });
      const nameCell = H.el('div', {
        style: { display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0' },
        textContent: ''
      });
      nameCell.appendChild(H.el('span', { textContent: isParent ? '↩️' : iconFor(item), style: { flex: '0 0 auto' } }));
      nameCell.appendChild(
        H.el('span', {
          textContent: isParent ? '..（返回上级）' : item.name,
          style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }
        })
      );
      row.appendChild(nameCell);
      row.appendChild(H.el('div', { textContent: item.type === 'dir' ? '目录' : (extOf(item.name) || '文件'), style: { color: 'var(--fg-dim)' } }));
      row.appendChild(
        H.el('div', { className: 'ph-mono', textContent: item.type === 'dir' ? '—' : formatSize(item.size) })
      );
      row.appendChild(
        H.el('div', { className: 'ph-mono', textContent: isParent ? '—' : formatMtime(item.mtime), style: { color: 'var(--fg-dim)' } })
      );

      row.addEventListener('click', (e) => {
        e.stopPropagation();
        if (isParent) {
          selected = null;
        } else {
          selected = item.path;
        }
        renderList();
        if (isParent) setStatus('返回上级：' + (parentPath(cwd) || '/'));
        else setStatus(describe(item));
      });
      row.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        openItem(item);
      });
      return row;
    }

    function describe(item) {
      if (!item) return '';
      const typeText = item.type === 'dir' ? '目录' : '文件';
      return item.path + ' · ' + typeText + (item.type === 'file' ? ' · ' + formatSize(item.size) : '') + ' · ' + formatMtime(item.mtime);
    }

    function updateToolbarState() {
      const hasSel = !!selected;
      renameBtn.disabled = !hasSel;
      deleteBtn.disabled = !hasSel;
      copyBtn.disabled = !hasSel;
      addressInput.value = cwd;
    }

    function refresh() {
      renderList();
    }

    // ---------- 文件操作 ----------
    async function mkdirFlow() {
      const name = await askName('新建文件夹', '新文件夹', '文件夹名称');
      if (name === null) return;
      if (!isValidName(name)) {
        H.audio.sfx('error');
        H.notify('文件管理器', '名称不合法（不能包含 / 或 \\）', { level: 'error' });
        return;
      }
      const target = joinPath(cwd, name);
      if (H.fs.exists(target)) {
        H.audio.sfx('error');
        H.notify('文件管理器', '已存在同名项目：' + name, { level: 'error' });
        return;
      }
      H.fs.mkdir(target);
      selected = target;
      H.audio.sfx('ok');
      H.notify('文件管理器', '已创建文件夹 ' + name, { icon: '📁' });
      renderList();
    }

    async function newFileFlow() {
      const name = await askName('新建文本文件', '新建文本.txt', '文件名（建议 .txt / .md）');
      if (name === null) return;
      if (!isValidName(name)) {
        H.audio.sfx('error');
        H.notify('文件管理器', '名称不合法（不能包含 / 或 \\）', { level: 'error' });
        return;
      }
      const target = joinPath(cwd, name);
      if (H.fs.exists(target)) {
        H.audio.sfx('error');
        H.notify('文件管理器', '已存在同名项目：' + name, { level: 'error' });
        return;
      }
      H.fs.write(target, '');
      selected = target;
      H.audio.sfx('ok');
      H.notify('文件管理器', '已创建文件 ' + name, { icon: '📝' });
      renderList();
    }

    async function renameFlow() {
      if (!selected) return;
      const stat = safeStat(selected);
      if (!stat) return;
      if (stat.path === '/') {
        H.notify('文件管理器', '根目录不能重命名', { level: 'warn' });
        return;
      }
      const oldName = stat.name;
      const next = await askName('重命名', oldName, '新名称');
      if (next === null || next === oldName) return;
      if (!isValidName(next)) {
        H.audio.sfx('error');
        H.notify('文件管理器', '名称不合法（不能包含 / 或 \\）', { level: 'error' });
        return;
      }
      const parent = parentPath(stat.path) || '/';
      const target = joinPath(parent, next);
      if (H.fs.exists(target)) {
        H.audio.sfx('error');
        H.notify('文件管理器', '目标已存在：' + next, { level: 'error' });
        return;
      }
      try {
        copyTree(H, stat.path, target);
        H.fs.remove(stat.path);
      } catch (err) {
        H.audio.sfx('error');
        H.notify('重命名失败', err && err.message ? err.message : '未知错误', { level: 'error' });
        return;
      }
      selected = target;
      H.audio.sfx('ok');
      H.notify('文件管理器', '已重命名为 ' + next, { icon: '✏️' });
      renderList();
    }

    async function deleteFlow() {
      if (!selected) return;
      const stat = safeStat(selected);
      if (!stat) return;
      if (stat.path === '/') {
        H.notify('文件管理器', '不能删除根目录', { level: 'error' });
        return;
      }
      H.audio.sfx('click');
      const ok = await H.dialog({
        title: '删除确认',
        body: '确定要删除「' + stat.name + '」吗？' + (stat.type === 'dir' ? '目录内的所有内容会一起删除。' : '') + '此操作不可撤销。',
        confirm: true,
        danger: true
      });
      if (!ok) return;
      H.fs.remove(stat.path);
      selected = null;
      H.audio.sfx('ok');
      H.notify('文件管理器', '已删除 ' + stat.name, { icon: '🗑️' });
      renderList();
      setStatus(cwd + ' · 已删除 ' + stat.name);
    }

    async function copyPathFlow() {
      if (!selected) return;
      const path = selected;
      try {
        if (!win || !win.navigator || !win.navigator.clipboard) throw new Error('clipboard unavailable');
        await win.navigator.clipboard.writeText(path);
        H.audio.sfx('ok');
        H.notify('文件管理器', '路径已复制到剪贴板', { icon: '📋' });
      } catch (err) {
        H.audio.sfx('error');
        H.notify('无法写入剪贴板', path, { level: 'warn', icon: '📋', timeout: 6000 });
        setStatus('路径（请手动复制）：' + path);
      }
    }

    function askName(title, value, label) {
      return H.dialog({
        title,
        body: '请输入' + label + '（不能包含 / 字符）',
        input: { label, value, placeholder: label }
      });
    }

    upBtn.addEventListener('click', () => {
      const parent = parentPath(cwd);
      if (!parent) {
        H.audio.sfx('click');
        setStatus('已经在根目录');
        return;
      }
      go(parent);
    });

    addressInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const ok = go(addressInput.value);
      if (!ok) addressInput.value = cwd;
    });
    addressInput.addEventListener('blur', () => {
      addressInput.value = cwd;
    });

    mkdirBtn.addEventListener('click', () => {
      H.audio.sfx('click');
      mkdirFlow();
    });
    newFileBtn.addEventListener('click', () => {
      H.audio.sfx('click');
      newFileFlow();
    });
    renameBtn.addEventListener('click', () => renameFlow());
    deleteBtn.addEventListener('click', () => deleteFlow());
    copyBtn.addEventListener('click', () => copyPathFlow());

    listPane.addEventListener('click', () => {
      if (!selected) return;
      selected = null;
      renderList();
      setStatus(cwd + ' · 未选中项目');
    });

    let removeKeyHandler = null;

    function attachKeyHandler() {
      const onKeyDown = (e) => {
        if (!doc) return;
        let focused = null;
        try {
          focused = H.wm.focused ? H.wm.focused() : null;
        } catch (err) {
          focused = null;
        }
        if (ctx && ctx.windowId != null && focused != null && focused !== ctx.windowId) return;
        const tag = e.target && e.target.tagName ? e.target.tagName : '';
        const inField = tag === 'INPUT' || tag === 'TEXTAREA' || (e.target && e.target.isContentEditable);
        if (e.key === 'Escape') {
          if (inField) return;
          selected = null;
          renderList();
          return;
        }
        if (inField) return;
        if (e.key === '~' || e.key === '`') {
          e.preventDefault();
          go('/home');
        } else if (e.key === '/') {
          e.preventDefault();
          go('/');
        } else if (e.key === 'Backspace') {
          const parent = parentPath(cwd);
          if (parent) {
            e.preventDefault();
            go(parent);
          }
        } else if (e.key === 'F2' && selected) {
          e.preventDefault();
          renameFlow();
        } else if (e.key === 'Delete' && selected) {
          e.preventDefault();
          deleteFlow();
        } else if (e.key === 'Enter' && selected) {
          e.preventDefault();
          openItem(safeStat(selected));
        }
      };
      if (doc) doc.addEventListener('keydown', onKeyDown, true);
      return () => {
        if (doc) doc.removeEventListener('keydown', onKeyDown, true);
      };
    }

    removeKeyHandler = attachKeyHandler();

    // 首次渲染
    renderList();

    // ctx.file：内核可能带着文件路径打开此窗口
    const initialFile = ctx && (ctx.file || (ctx.args && (ctx.args.file || ctx.args.path)));
    if (initialFile) revealFile(initialFile);

    return {
      destroy() {
        if (typeof removeKeyHandler === 'function') removeKeyHandler();
      },
      onFocus() {
        renderList();
      },
      onResize() {},
      onOpen(file) {
        if (file) revealFile(file);
      }
    };
  }
};

/** 递归复制（Host.fs 没有 rename，用 读+写+删 实现） */
function copyTree(H, from, to) {
  const stat = H.fs.stat(from);
  if (!stat) throw new Error('源路径不存在：' + from);
  if (stat.type === 'dir') {
    H.fs.mkdir(to);
    for (const child of H.fs.list(from) || []) {
      copyTree(H, child.path, joinPath(to, child.name));
    }
  } else {
    const text = H.fs.read(from);
    H.fs.write(to, text === null || text === undefined ? '' : String(text));
  }
  return true;
}
