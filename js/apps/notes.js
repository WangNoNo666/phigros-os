// notes.js —— 「记事本」应用：纯文本编辑 + 1.2s 防抖自动保存
//
// 顶层不得触碰 window / document（便于 node 自测纯函数）。

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

/** 拼接路径 */
export function joinPath(dir, name) {
  const d = normalizePath(dir);
  const n = String(name == null ? '' : name).trim().replace(/^\/+/, '').replace(/\/+$/, '');
  if (!n) return d;
  return d === '/' ? '/' + n : d + '/' + n;
}

/** 文本统计：字符数 / 行数 / 中文字符数 */
export function countText(text) {
  const s = typeof text === 'string' ? text : '';
  const lines = s.length === 0 ? 1 : s.split('\n').length;
  const cjkMatches = s.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g);
  return {
    chars: s.length,
    lines,
    cjk: cjkMatches ? cjkMatches.length : 0
  };
}

/** hh:mm:ss 时钟文本 */
export function formatClock(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return '--:--:--';
  const pad = (n) => (n < 10 ? '0' + n : String(n));
  return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

export default {
  id: 'notes',
  name: '记事本',
  icon: '📝',
  desc: '编辑纯文本与 Markdown 笔记',
  singleton: false,
  width: 640,
  height: 480,
  accent: '#34d399',

  async mount(root, ctx) {
    const H = globalThis.Host;
    const win = typeof globalThis.window !== 'undefined' ? globalThis.window : null;
    const doc = root.ownerDocument || (win ? win.document : null);
    const AUTOSAVE_DELAY = 1200;
    const DEFAULT_DIR = '/home';

    let path = null;
    let dirty = false;
    let saveTimer = null;
    let lastSavedAt = 0;

    root.style.display = 'flex';
    root.style.flexDirection = 'column';
    root.style.height = '100%';

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
    const dirtyDot = H.el('span', {
      title: '有未保存的改动',
      style: { color: 'var(--warn)', fontSize: '16px', lineHeight: '1', flex: '0 0 auto' },
      textContent: '●'
    });
    const nameInput = H.el('input', {
      className: 'ph-input',
      type: 'text',
      spellcheck: 'false',
      placeholder: '未命名.txt',
      title: '文件名（回车后作为保存目标）',
      style: { flex: '1 1 150px', minWidth: '110px' }
    });
    const saveBtn = H.el('button', { className: 'ph-btn sm primary', textContent: '保存', title: 'Ctrl+S' });
    const saveAsBtn = H.el('button', { className: 'ph-btn sm', textContent: '另存为' });
    const openBtn = H.el('button', { className: 'ph-btn sm', textContent: '打开' });
    const statusText = H.el('span', {
      className: 'ph-sub',
      style: { fontSize: '12px', flex: '0 0 auto', minWidth: '84px', textAlign: 'right' },
      textContent: '未保存'
    });
    toolbar.append(dirtyDot, nameInput, saveBtn, saveAsBtn, openBtn, statusText);
    root.appendChild(toolbar);

    // ---------- 编辑区 ----------
    const editor = H.el('textarea', {
      className: 'ph-textarea',
      spellcheck: 'false',
      placeholder: '在这里开始输入…（内容变化 1.2 秒后自动保存）',
      style: {
        flex: '1 1 auto',
        minHeight: '0',
        width: '100%',
        boxSizing: 'border-box',
        resize: 'none',
        padding: '12px 14px',
        border: 'none',
        outline: 'none',
        background: 'var(--bg-1)',
        color: 'var(--fg)',
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: '13px',
        lineHeight: '1.6'
      }
    });
    root.appendChild(editor);

    // ---------- 状态栏 ----------
    const footer = H.el('div', {
      className: 'ph-sub',
      style: {
        flex: '0 0 auto',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: '10px',
        padding: '6px 10px',
        borderTop: '1px solid var(--line)',
        fontSize: '12px',
        whiteSpace: 'nowrap',
        overflow: 'hidden'
      }
    });
    const countText2 = H.el('span', { textContent: '字符 0 · 行 1 · 中文 0' });
    const pathText = H.el('span', {
      style: { overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--fg-dim)' },
      textContent: '尚未保存到文件系统'
    });
    footer.append(countText2, pathText);
    root.appendChild(footer);

    // ---------- 内部工具 ----------
    function refreshCounts() {
      const c = countText(editor.value);
      countText2.textContent = '字符 ' + c.chars + ' · 行 ' + c.lines + ' · 中文 ' + c.cjk;
    }

    function refreshHeader(focusEditor) {
      nameInput.value = path ? baseName(path) : nameInput.value || '未命名.txt';
      pathText.textContent = path ? '路径：' + path : '尚未保存到文件系统（点「另存为」或 Ctrl+S 选择路径）';
      dirtyDot.style.visibility = dirty ? 'visible' : 'hidden';
      if (!dirty && lastSavedAt) {
        statusText.textContent = '已保存 ' + formatClock(lastSavedAt);
        statusText.style.color = 'var(--fg-dim)';
      } else if (dirty) {
        statusText.textContent = '未保存 ●';
        statusText.style.color = 'var(--warn)';
      } else {
        statusText.textContent = '未保存';
        statusText.style.color = 'var(--fg-dim)';
      }
      if (focusEditor) editor.focus();
    }

    function markDirty() {
      dirty = true;
      refreshHeader();
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (path) {
        saveTimer = setTimeout(() => {
          saveTimer = null;
          saveNow(true);
        }, AUTOSAVE_DELAY);
      }
    }

    function saveNow(silent) {
      if (!path) return false;
      try {
        H.fs.write(path, editor.value);
      } catch (err) {
        H.audio.sfx('error');
        H.notify('保存失败', err && err.message ? err.message : '写入文件系统出错', { level: 'error' });
        return false;
      }
      dirty = false;
      lastSavedAt = new Date();
      refreshHeader();
      if (!silent) H.audio.sfx('ok');
      return true;
    }

    function loadFile(filePath) {
      const p = normalizePath(filePath);
      let stat = null;
      try {
        stat = H.fs.stat(p);
      } catch (err) {
        stat = null;
      }
      if (stat && stat.type === 'file') {
        let text = '';
        try {
          text = H.fs.read(p);
        } catch (err) {
          text = '';
        }
        path = p;
        editor.value = text === null || text === undefined ? '' : String(text);
        dirty = false;
        lastSavedAt = Number.isFinite(stat.mtime) && stat.mtime > 0 ? stat.mtime : Date.now();
        refreshCounts();
        refreshHeader(true);
        return true;
      }
      if (stat && stat.type === 'dir') {
        H.notify('记事本', '这是一个目录，无法编辑：' + p, { level: 'warn' });
        return false;
      }
      // 文件不存在：作为待创建的新文件记住目标路径
      path = p;
      editor.value = '';
      dirty = false;
      lastSavedAt = 0;
      refreshCounts();
      refreshHeader(true);
      H.notify('记事本', '文件不存在，首次保存时会创建：' + p, { icon: '📝' });
      return true;
    }

    async function askPath(title, value) {
      try {
        const result = await H.dialog({
          title,
          body: '请输入文件绝对路径（父目录会自动创建）',
          input: { label: '路径', value, placeholder: '/home/笔记.txt' }
        });
        return typeof result === 'string' && result.trim() ? normalizePath(result) : null;
      } catch (err) {
        return null;
      }
    }

    async function saveAsFlow() {
      const suggested = path || joinPath(DEFAULT_DIR, nameInput.value || '未命名.txt');
      const target = await askPath('另存为', suggested);
      if (!target) return;
      path = target;
      saveNow(false);
      H.notify('记事本', '已保存到 ' + target, { icon: '💾' });
    }

    async function openFlow() {
      const target = await askPath('打开文件', path || joinPath(DEFAULT_DIR, 'README.txt'));
      if (!target) return;
      if (dirty) {
        let ok = false;
        try {
          ok = await H.dialog({
            title: '放弃未保存的改动？',
            body: '当前内容尚未保存，继续打开会丢失这些改动。',
            confirm: true,
            danger: true
          });
        } catch (err) {
          ok = false;
        }
        if (!ok) return;
      }
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (loadFile(target)) H.audio.sfx('open');
    }

    function commitFilename() {
      const raw = nameInput.value.trim();
      const current = path ? baseName(path) : '未命名.txt';
      if (!raw) {
        nameInput.value = current;
        return;
      }
      if (raw === current) return;
      if (raw.indexOf('/') !== -1 || raw.indexOf('\\') !== -1) {
        H.notify('记事本', '文件名不能包含 / 字符', { level: 'warn' });
        nameInput.value = current;
        return;
      }
      const dir = path ? parentPath(path) || '/' : DEFAULT_DIR;
      const next = joinPath(dir, raw);
      if (next === path) return;
      path = next;
      markDirty();
      H.notify('记事本', '保存目标改为 ' + next, { icon: '📝' });
    }

    // ---------- 事件 ----------
    editor.addEventListener('input', () => {
      refreshCounts();
      markDirty();
    });
    editor.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
        e.preventDefault();
        if (path) saveNow(false);
        else saveAsFlow();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const start = editor.selectionStart;
        const end = editor.selectionEnd;
        editor.value = editor.value.slice(0, start) + '\t' + editor.value.slice(end);
        editor.selectionStart = start + 1;
        editor.selectionEnd = start + 1;
        refreshCounts();
        markDirty();
      }
    });

    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        commitFilename();
      } else if (e.key === 'Escape') {
        nameInput.value = path ? baseName(path) : '未命名.txt';
      }
    });
    nameInput.addEventListener('blur', () => commitFilename());

    saveBtn.addEventListener('click', () => {
      H.audio.sfx('click');
      if (saveTimer !== null) {
        clearTimeout(saveTimer);
        saveTimer = null;
      }
      if (path) saveNow(false);
      else saveAsFlow();
    });
    saveAsBtn.addEventListener('click', () => {
      H.audio.sfx('click');
      saveAsFlow();
    });
    openBtn.addEventListener('click', () => {
      H.audio.sfx('click');
      openFlow();
    });

    // ---------- Ctrl+S 全局快捷键（仅本窗口聚焦时生效） ----------
    const onKeyDown = (e) => {
      if (!(e.ctrlKey || e.metaKey) || (e.key !== 's' && e.key !== 'S')) return;
      let focused = null;
      try {
        focused = H.wm && H.wm.focused ? H.wm.focused() : null;
      } catch (err) {
        focused = null;
      }
      if (ctx && ctx.windowId != null && focused != null && focused !== ctx.windowId) return;
      e.preventDefault();
      if (path) saveNow(false);
      else saveAsFlow();
    };
    if (doc) doc.addEventListener('keydown', onKeyDown, true);

    // ---------- 初始化 ----------
    const initialFile = ctx && (ctx.file || (ctx.args && (ctx.args.file || ctx.args.path)));
    nameInput.value = '未命名.txt';
    if (initialFile) loadFile(initialFile);
    else {
      refreshCounts();
      refreshHeader(true);
    }

    return {
      destroy() {
        if (saveTimer !== null) {
          clearTimeout(saveTimer);
          saveTimer = null;
        }
        // destroy 是同步的：不弹异步确认，但把待保存内容同步落盘，避免丢改动
        if (dirty && path) {
          try {
            H.fs.write(path, editor.value);
          } catch (err) {
            /* 落盘失败时放弃，用户仍可重新打开窗口后手动保存 */
          }
        }
        if (doc) doc.removeEventListener('keydown', onKeyDown, true);
      },
      onFocus() {
        refreshHeader();
      },
      onResize() {},
      onOpen(file) {
        if (!file) return;
        if (dirty && path) {
          try {
            H.fs.write(path, editor.value);
          } catch (err) {
            /* 忽略 */
          }
        }
        loadFile(file);
      }
    };
  }
};
