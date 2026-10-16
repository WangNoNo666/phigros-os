/**
 * phigrOS · tests/test-core-state.mjs
 * 不依赖浏览器：状态机 / 路径操作 / 迁移 / 订阅 的自测。
 *
 * 用法：node tests/test-core-state.mjs
 */
import {
  State,
  defaults,
  deepClone,
  deepMerge,
  getPath,
  setPath,
  migrate,
  STATE_VERSION
} from '../js/core/state.js';
import { createHost } from '../js/core/host.js';

let passed = 0;
let failed = 0;

function check(name, cond, detail = '') {
  if (cond) {
    passed += 1;
    console.log(`PASS ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL ${name}${detail ? ` :: ${detail}` : ''}`);
  }
}

function deepEq(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------- 内存 storage 桩 ----------------
function memStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, String(v)),
    removeItem: (k) => map.delete(k),
    _map: map
  };
}

// ---------------- 1. 纯函数 ----------------
check('deepClone 深拷贝且不共享引用', (() => {
  const a = { x: { y: [1, 2] } };
  const b = deepClone(a);
  b.x.y.push(3);
  return a.x.y.length === 2;
})());

check('deepClone 保留数组与原始值', deepEq(deepClone([1, 'a', null]), [1, 'a', null]));

check('deepMerge 递归合并保留未知键', (() => {
  const out = deepMerge({ a: { b: 1, c: 2 }, d: 3 }, { a: { b: 9 }, e: 4 });
  return out.a.b === 9 && out.a.c === 2 && out.d === 3 && out.e === 4;
})());

check('deepMerge 数组整体替换', deepEq(deepMerge({ a: [1, 2, 3] }, { a: [9] }).a, [9]));

check('getPath 支持点分路径', getPath({ a: { b: { c: 7 } } }, 'a.b.c') === 7);
check('getPath 越界返回 undefined', getPath({ a: 1 }, 'a.b.c') === undefined);

check('setPath 不可变更新', (() => {
  const src = { a: { b: 1 } };
  const out = setPath(src, 'a.b', 5);
  return out.a.b === 5 && src.a.b === 1;
})());

check('setPath 自动创建中间对象', getPath(setPath({}, 'x.y.z', 1), 'x.y.z') === 1);

// ---------------- 2. 迁移 ----------------
check('migrate 空值返回默认值', deepEq(migrate(null), defaults()));

check('migrate 补齐缺失顶层键', (() => {
  const m = migrate({ player: { name: 'X' } });
  return m.version === STATE_VERSION && 'settings' in m && 'fs' in m && m.player.name === 'X';
})());

check('migrate 保留用户数据与自定义 settings 键', (() => {
  const m = migrate({ settings: { volume: 0.3, wallpaper: 'grid' }, achievements: { a: { unlocked: true } } });
  return m.settings.volume === 0.3 && m.settings.wallpaper === 'grid' && m.achievements.a.unlocked === true;
})());

check('migrate 夹取非法数值', (() => {
  const m = migrate({ settings: { volume: 99, speed: -3, offsetMs: 'x' } });
  return m.settings.volume === 1 && m.settings.speed === 0.5 && m.settings.offsetMs === 0;
})());

check('migrate schema<3：默认关闭音乐合成并开启流畅模式', (() => {
  const m = migrate({ settings: { volume: 0.5 }, player: {} });
  return m.settings.musicSynth === false && m.settings.smoothMode === true && m.settings.schema === 3;
})());

check('migrate 保留用户显式打开的设置', (() => {
  const m = migrate({ settings: { schema: 3, musicSynth: true, smoothMode: false } });
  return m.settings.musicSynth === true && m.settings.smoothMode === false;
})());

check('migrate 用户已显式开启合成时升级不覆盖', (() => {
  const m = migrate({ settings: { schema: 2, musicSynth: true, smoothMode: false } });
  return m.settings.musicSynth === true && m.settings.smoothMode === false && m.settings.schema === 3;
})());

// ---------------- 3. State ----------------
{
  const storage = memStorage();
  const st = new State({ storage, persistDelay: 0 });

  check('默认状态顶层键与契约一致', deepEq(Object.keys(st.get()).sort(), Object.keys(defaults()).sort()));

  st.set('settings.volume', 0.42);
  check('set 生效', st.get().settings.volume === 0.42);

  st.update('player.record', (r) => ({ ...(r || {}), t1: { Easy: { score: 900000 } } }));
  check('update 基于当前值', st.get().player.record.t1.Easy.score === 900000);

  let got = null;
  let calls = 0;
  const off = st.subscribe('settings.volume', (v) => {
    got = v;
    calls += 1;
  });
  st.set('settings.volume', 0.9);
  check('subscribe 收到新值', got === 0.9 && calls === 1, `got=${got} calls=${calls}`);
  off();
  st.set('settings.volume', 0.5);
  check('subscribe 取消后不再回调', calls === 1, `calls=${calls}`);

  let parentCalls = 0;
  const off2 = st.subscribe('settings', () => (parentCalls += 1));
  st.set('settings.sfx', false);
  check('订阅父路径可收到子路径变化', parentCalls === 1, `calls=${parentCalls}`);
  off2();

  st.save();
  const rawSaved = JSON.parse(storage.getItem('phigros-os:state:v1'));
  check('save 落盘且可解析', rawSaved.settings.volume === 0.5 && rawSaved.player.record.t1.Easy.score === 900000);

  const st2 = new State({ storage, persistDelay: 0 });
  check('重新加载能恢复存档', st2.get().settings.volume === 0.5);

  st2.reset();
  check('reset 恢复默认', st2.get().settings.volume === 0.8 && deepEq(st2.get().achievements, {}));

  const st3 = new State({ storage: null });
  check('无 localStorage 时安全降级', st3.get().version === STATE_VERSION && st3.save() === false);
}

// ---------------- 4. VFS 不变量 ----------------
{
  const store = new State({ storage: memStorage(), persistDelay: 0 });
  // 最小 document 桩，只用于 createHost 的 DOM 部分（本测试不触发）
  const fakeDoc = {
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementById: () => null,
    createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {} }, appendChild() {}, addEventListener() {} }),
    createTextNode: (t) => ({ text: t }),
    addEventListener() {},
    removeEventListener() {},
    body: { appendChild() {} },
    defaultView: null
  };
  const host = createHost({ state: store, kernel: { apps: new Map(), manifest: [] }, audio: null, wm: {}, document: fakeDoc });
  const fs = host.fs;
  const normalize = fs.normalize;

  fs.mkdir('/home/Documents');
  fs.write('/home/Documents/a.txt', 'hello');
  fs.write('/home/Documents/b.md', '# title');
  fs.mkdir('/home/Music/Albums');

  check('write 后文件存在', fs.exists('/home/Documents/a.txt'));
  check('read 返回内容', fs.read('/home/Documents/a.txt') === 'hello');
  check('append 追加内容', (() => {
    fs.append('/home/Documents/a.txt', ' world');
    return fs.read('/home/Documents/a.txt') === 'hello world';
  })());
  check('stat 返回正确类型与大小', (() => {
    const st = fs.stat('/home/Documents/a.txt');
    return st.type === 'file' && st.size === 11 && st.name === 'a.txt';
  })());
  check('list 目录排序（目录优先）', (() => {
    fs.mkdir('/home/Documents/sub');
    const items = fs.list('/home/Documents');
    return items[0].type === 'dir' && items[0].name === 'sub';
  })());

  // 不变量：每个目录的 children 都能被 stat 到，且父子路径一致
  const data = store.raw().fs;
  let invariantOk = true;
  let brokenDetail = '';
  for (const [p, node] of Object.entries(data)) {
    if (node.type !== 'dir') continue;
    for (const child of node.children || []) {
      const cnode = data[child];
      if (!cnode) {
        invariantOk = false;
        brokenDetail = `${p} -> ${child} 缺失`;
        break;
      }
      if (fs.parentOf(child) !== p) {
        invariantOk = false;
        brokenDetail = `${p} -> ${child} 父路径不一致 (${fs.parentOf(child)})`;
        break;
      }
    }
    if (!invariantOk) break;
  }
  check('VFS 不变量：children 与节点一致', invariantOk, brokenDetail);

  check('深层 mkdir 自动创建父目录', fs.exists('/a/b/c/d') === false && (fs.mkdir('/a/b/c/d'), fs.exists('/a/b/c/d')));

  check('remove 递归删除', (() => {
    fs.remove('/home/Documents/sub');
    return !fs.exists('/home/Documents/sub');
  })());

  check('删除目录会从父 children 移除', (() => {
    fs.remove('/a');
    return !(store.raw().fs['/'].children || []).includes('/a');
  })());

  check('不能删除根目录', (() => {
    try {
      fs.remove('/');
      return false;
    } catch {
      return true;
    }
  })());

  check('normalize 处理相对/上级路径', normalize('/home/../system/./a.txt') === '/system/a.txt' && normalize('home') === '/home');
  check('normalize 处理空与根', normalize('') === '/' && normalize('/') === '/');

  let fsEvents = 0;
  const offFs = fs.onChange(() => (fsEvents += 1));
  fs.write('/tmp-x.txt', 'x');
  await new Promise((r) => setTimeout(r, 0));
  check('fs.onChange 触发一次', fsEvents === 1, `events=${fsEvents}`);
  offFs();
  fs.write('/tmp-y.txt', 'y');
  await new Promise((r) => setTimeout(r, 0));
  check('fs.onChange 取消后不再触发', fsEvents === 1, `events=${fsEvents}`);
}

console.log(`\nRESULT: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
