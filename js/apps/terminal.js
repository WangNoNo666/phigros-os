/**
 * phigrOS · js/apps/terminal.js
 * phigrOS 终端：VFS 操作、进程查看、系统信息、成就解锁。
 */
export default {
  id: 'terminal',
  name: '终端',
  icon: '⌨️',
  desc: 'phigrOS 命令行',
  singleton: false,
  width: 760,
  height: 460,
  accent: 'hsl(148 82% 55%)',

  async mount(root, ctx) {
    const H = window.Host;
    const unsubs = [];
    let history = [];
    let histIdx = -1;
    let cwd = '/home';

    root.classList.add('terminal-app');

    const out = H.el('div', { className: 'term-out ph-scroll' });
    const prompt = H.el('span', { className: 'term-prompt' });
    const input = H.el('input', {
      className: 'term-input',
      type: 'text',
      spellcheck: 'false',
      autocomplete: 'off',
      'aria-label': '终端输入'
    });
    const inputLine = H.el('div', { className: 'term-line' }, [prompt, input]);
    root.append(out, inputLine);

    function print(text, cls) {
      const line = H.el('div', { className: `term-line-out${cls ? ' ' + cls : ''}` });
      line.textContent = text;
      out.appendChild(line);
      out.scrollTop = out.scrollHeight;
      return line;
    }

    function printRaw(node) {
      out.appendChild(node);
      out.scrollTop = out.scrollHeight;
    }

    function syncPrompt() {
      prompt.textContent = `phigrOS ${cwd === '/' ? '/' : cwd.replace('/home', '~')} ❯`;
    }

    // ---------------- 路径工具 ----------------
    function resolve(p) {
      if (!p) return cwd;
      let path = String(p);
      if (path.startsWith('~')) path = '/home' + path.slice(1);
      if (!path.startsWith('/')) path = `${cwd === '/' ? '' : cwd}/${path}`;
      return H.fs.normalize(path);
    }

    function fmtSize(n) {
      if (n < 1024) return `${n} B`;
      if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
      return `${(n / 1024 / 1024).toFixed(2)} MB`;
    }

    function tokenize(line) {
      const out = [];
      let cur = '';
      let quote = null;
      for (const ch of line) {
        if (quote) {
          if (ch === quote) quote = null;
          else cur += ch;
          continue;
        }
        if (ch === '"' || ch === "'") {
          quote = ch;
          continue;
        }
        if (ch === ' ') {
          if (cur) {
            out.push(cur);
            cur = '';
          }
          continue;
        }
        cur += ch;
      }
      if (cur) out.push(cur);
      return out;
    }

    // ---------------- 命令实现 ----------------
    const COMMANDS = {
      help() {
        print('phigrOS Shell —— 可用命令', 'ok');
        const rows = [
          ['help', '显示本帮助'],
          ['clear', '清屏'],
          ['pwd', '显示当前目录'],
          ['ls [路径]', '列出目录内容'],
          ['cd <路径>', '切换目录'],
          ['cat <文件>', '输出文件内容'],
          ['echo <文本> [> 文件]', '输出文本 / 写入文件'],
          ['mkdir <目录>', '创建目录'],
          ['rm <路径>', '删除文件或目录'],
          ['open <路径>', '用对应应用打开'],
          ['apps', '列出已登记应用'],
          ['launch <应用id>', '启动应用'],
          ['ps', '列出打开的窗口'],
          ['kill <窗口id>', '关闭窗口'],
          ['volume [0-100]', '查看 / 设置音量'],
          ['theme <0-360>', '设置主题色相'],
          ['sysinfo', '系统信息'],
          ['score', '查看音游成绩'],
          ['achievements', '查看成就'],
          ['date', '当前时间'],
          ['whoami', '当前用户'],
          ['reboot', '重启 phigrOS']
        ];
        for (const [cmd, desc] of rows) {
          const line = H.el('div', { className: 'term-table' });
          line.appendChild(H.el('span', { className: 'term-cmd', textContent: cmd }));
          line.appendChild(H.el('span', { className: 'term-desc', textContent: desc }));
          printRaw(line);
        }
      },

      clear() {
        out.textContent = '';
      },

      pwd() {
        print(cwd);
      },

      ls(args) {
        const target = args[0] ? resolve(args[0]) : cwd;
        const st = H.fs.stat(target);
        if (!st) return print(`ls: 路径不存在: ${target}`, 'err');
        if (st.type === 'file') return print(`${st.name}  ${fmtSize(st.size)}`);
        const items = H.fs.list(target);
        if (items.length === 0) return print('（空目录）', 'dim');
        for (const it of items) {
          const line = H.el('div', { className: 'term-table' });
          line.appendChild(
            H.el('span', {
              className: `term-name ${it.type === 'dir' ? 'dir' : 'file'}`,
              textContent: (it.type === 'dir' ? '📁 ' : '📄 ') + it.name
            })
          );
          line.appendChild(
            H.el('span', { className: 'term-desc', textContent: it.type === 'dir' ? '<dir>' : fmtSize(it.size) })
          );
          printRaw(line);
        }
      },

      cd(args) {
        const target = resolve(args[0] || '/home');
        const st = H.fs.stat(target);
        if (!st) return print(`cd: 路径不存在: ${target}`, 'err');
        if (st.type !== 'dir') return print(`cd: 不是目录: ${target}`, 'err');
        cwd = target;
        syncPrompt();
      },

      cat(args) {
        if (!args[0]) return print('用法: cat <文件>', 'err');
        const path = resolve(args[0]);
        const text = H.fs.read(path);
        if (text === null) return print(`cat: 无法读取: ${path}`, 'err');
        for (const line of text.split('\n')) print(line);
      },

      echo(args) {
        const gt = args.indexOf('>');
        if (gt === -1) return print(args.join(' '));
        const text = args.slice(0, gt).join(' ');
        const target = resolve(args[gt + 1]);
        if (!args[gt + 1]) return print('用法: echo <文本> > <文件>', 'err');
        H.fs.write(target, `${text}\n`);
        print(`已写入 ${target}`, 'ok');
      },

      mkdir(args) {
        if (!args[0]) return print('用法: mkdir <目录>', 'err');
        const path = resolve(args[0]);
        if (H.fs.exists(path)) return print(`mkdir: 已存在: ${path}`, 'err');
        H.fs.mkdir(path);
        print(`已创建目录 ${path}`, 'ok');
      },

      rm(args) {
        if (!args[0]) return print('用法: rm <路径>', 'err');
        const path = resolve(args[0]);
        if (!H.fs.exists(path)) return print(`rm: 路径不存在: ${path}`, 'err');
        H.fs.remove(path);
        if (cwd === path || cwd.startsWith(path + '/')) cwd = '/home';
        syncPrompt();
        print(`已删除 ${path}`, 'ok');
      },

      open(args) {
        if (!args[0]) return print('用法: open <路径>', 'err');
        const path = resolve(args[0]);
        const id = H.openFile(path);
        if (id) print(`已打开 ${path}`, 'ok');
      },

      apps() {
        for (const app of H.apps()) {
          const line = H.el('div', { className: 'term-table' });
          line.appendChild(H.el('span', { className: 'term-cmd', textContent: app.id }));
          line.appendChild(H.el('span', { className: 'term-desc', textContent: `${app.icon} ${app.name}${app.desc ? ' · ' + app.desc : ''}` }));
          printRaw(line);
        }
      },

      launch(args) {
        const id = args[0];
        if (!id) return print('用法: launch <应用id>', 'err');
        if (!H.appMeta(id)) return print(`launch: 未登记的应用: ${id}`, 'err');
        H.launch(id);
        print(`正在启动 ${id} …`, 'ok');
      },

      ps() {
        const list = H.wm.list();
        if (list.length === 0) return print('没有打开的窗口', 'dim');
        for (const w of list) {
          const line = H.el('div', { className: 'term-table' });
          line.appendChild(H.el('span', { className: 'term-cmd', textContent: w.id }));
          line.appendChild(H.el('span', { className: 'term-desc', textContent: `${w.appId} · ${w.title} · ${Math.round(w.w)}×${Math.round(w.h)}${w.min ? ' · 已最小化' : ''}` }));
          printRaw(line);
        }
      },

      kill(args) {
        const id = args[0];
        if (!id) return print('用法: kill <窗口id>', 'err');
        if (!H.wm.list().some((w) => w.id === id)) return print(`kill: 没有该窗口: ${id}`, 'err');
        H.wm.close(id);
        print(`已关闭 ${id}`, 'ok');
      },

      volume(args) {
        if (!args[0]) return print(`当前音量: ${Math.round(H.audio.volume() * 100)}%`);
        const v = H.clamp(Number(args[0]), 0, 100) / 100;
        H.audio.setVolume(v);
        H.store.set('settings.volume', v);
        print(`音量已设为 ${Math.round(v * 100)}%`, 'ok');
      },

      theme(args) {
        if (!args[0]) return print(`当前色相: ${H.store.get().settings.themeHue}`);
        const hue = H.clamp(Number(args[0]), 0, 360);
        H.store.set('settings.themeHue', hue);
        H.refreshWallpaper();
        H.achievement('theme-hue', '调色师', '更改主题色相');
        print(`主题色相已设为 ${hue}`, 'ok');
      },

      sysinfo() {
        const s = H.store.get();
        const rows = [
          ['操作系统', `phigrOS ${window.PhigrOS ? window.PhigrOS.version : '1.0.0'}`],
          ['内核', `web-kernel/${window.PhigrOS ? window.PhigrOS.version : '1.0.0'}`],
          ['启动次数', String(s.boot.bootCount)],
          ['启动耗时', `${s.boot.bootTimeMs} ms`],
          ['分辨率', `${window.innerWidth}×${window.innerHeight} @${window.devicePixelRatio}x`],
          ['已登记应用', String(H.apps().length)],
          ['打开窗口', String(H.wm.list().length)],
          ['存档占用', `${H.store.sizeBytes()} B`]
        ];
        for (const [k, v] of rows) {
          const line = H.el('div', { className: 'term-table' });
          line.appendChild(H.el('span', { className: 'term-cmd', textContent: k }));
          line.appendChild(H.el('span', { className: 'term-desc', textContent: v }));
          printRaw(line);
        }
      },

      score() {
        const rec = H.store.get().player.record || {};
        const ids = Object.keys(rec);
        if (ids.length === 0) return print('还没有游玩记录，先打开 Phigros 玩一局吧。', 'dim');
        print(`RKS: ${H.store.get().player.rks.toFixed(4)} · 总游玩 ${H.store.get().player.totalPlay} 次`, 'ok');
        for (const tid of ids) {
          for (const diff of Object.keys(rec[tid])) {
            const r = rec[tid][diff];
            print(`${tid} [${diff}]  ${String(r.score).padStart(7, ' ')}  acc ${(r.acc * 100).toFixed(2)}%  ${r.grade}${r.fc ? ' FC' : ''}`);
          }
        }
      },

      achievements() {
        const a = H.store.get().achievements || {};
        const ids = Object.keys(a).filter((k) => a[k] && a[k].unlocked);
        if (ids.length === 0) return print('尚未解锁任何成就。', 'dim');
        for (const id of ids) print(`🏆 ${a[id].title || id} —— ${a[id].desc || ''}`, 'ok');
      },

      date() {
        print(new Date().toLocaleString('zh-CN'));
      },

      whoami() {
        print(H.store.get().player.name || 'phigros-player');
      },

      async reboot() {
        print('正在重启 phigrOS …', 'warn');
        await H.sleep(400);
        H.power('reboot');
      }
    };

    // ---------------- 执行 ----------------
    function run(line) {
      const text = line.trim();
      if (!text) return;
      history.push(text);
      if (history.length > 100) history.shift();
      histIdx = history.length;
      const parts = tokenize(text);
      const cmd = parts[0];
      const args = parts.slice(1);
      const fn = COMMANDS[cmd];
      if (!fn) {
        print(`phigrOS: 未找到命令: ${cmd}（输入 help 查看可用命令）`, 'err');
        return;
      }
      try {
        const r = fn(args);
        if (r && typeof r.catch === 'function') r.catch((err) => print(String(err && err.message ? err.message : err), 'err'));
      } catch (err) {
        print(String(err && err.message ? err.message : err), 'err');
      }
    }

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        const value = input.value;
        const line = H.el('div', { className: 'term-echo' });
        line.appendChild(H.el('span', { className: 'term-prompt', textContent: prompt.textContent }));
        line.appendChild(H.el('span', { textContent: ` ${value}` }));
        printRaw(line);
        input.value = '';
        run(value);
        out.scrollTop = out.scrollHeight;
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        if (histIdx > 0) histIdx -= 1;
        input.value = history[histIdx] || '';
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        if (histIdx < history.length - 1) histIdx += 1;
        else histIdx = history.length;
        input.value = history[histIdx] || '';
      } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        out.textContent = '';
      } else if (e.key === 'c' && e.ctrlKey) {
        e.preventDefault();
        input.value = '';
        print('^C', 'dim');
      }
    });

    root.addEventListener('click', () => input.focus());

    // 首次打开解锁成就
    H.achievement('terminal-unlock', 'Enter the Shell', '第一次打开终端');

    syncPrompt();
    print('phigrOS Shell v1.0.0 —— 输入 help 查看命令', 'ok');
    print('提示：try  `ls /home`、`cat /home/README.txt`、`launch phigros`', 'dim');
    print('');

    setTimeout(() => input.focus(), 60);

    unsubs.push(
      H.store.subscribe('fs', () => {
        /* 目录可能被删除，保持 cwd 有效 */
        if (!H.fs.exists(cwd)) {
          cwd = '/home';
          syncPrompt();
        }
      })
    );

    return {
      destroy() {
        for (const u of unsubs) {
          try {
            u();
          } catch (_e) {
            /* ignore */
          }
        }
        unsubs.length = 0;
      },
      onFocus() {
        setTimeout(() => input.focus(), 30);
      },
      onBlur() {
        /* 保持输入内容 */
      }
    };
  }
};
