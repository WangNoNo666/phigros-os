/**
 * shell-wm 纯逻辑自测（Node，无 DOM）
 *
 * 运行：node tests/test-shell-wm.mjs
 * 覆盖：窗口摆放 / 阶梯偏移 / 视口夹取 / 最小尺寸
 */

import { placeNewWindow, clampWindow, MIN_W, MIN_H, TITLEBAR_VISIBLE } from '../js/shell/wm.js';

let passed = 0;
let failed = 0;

/**
 * 执行一项断言。
 * @param {string} name 用例名
 * @param {Function} fn 返回 true 表示通过；返回字符串表示失败原因
 */
function check(name, fn) {
  try {
    const result = fn();
    if (result === true) {
      passed += 1;
      console.log('PASS ' + name);
    } else {
      failed += 1;
      console.log('FAIL ' + name + ' ' + (result || '断言未通过'));
    }
  } catch (err) {
    failed += 1;
    console.log('FAIL ' + name + ' ' + ((err && err.message) || String(err)));
  }
}

/** 窗口是否完整落在视口内 */
function fullyInside(r, vp) {
  return r.x >= 0 && r.y >= 0 && r.x + r.w <= vp.w && r.y + r.h <= vp.h;
}

/** 标题栏可见宽度（水平方向至少 80px） */
function visibleTitlebar(r, vp) {
  const left = Math.max(0, r.x);
  const right = Math.min(vp.w, r.x + r.w);
  return right - left;
}

const VP = { w: 1280, h: 720 };

/* ------------------------------------------------------------------ *
 * 1. 空桌面第一个窗口
 * ------------------------------------------------------------------ */

check('空桌面第一个窗口尺寸与位置合理', () => {
  const r = placeNewWindow([], 720, 480, VP);
  if (!fullyInside(r, VP)) return '窗口超出视口：' + JSON.stringify(r);
  if (r.w !== 720 || r.h !== 480) return '未采用默认尺寸：' + r.w + 'x' + r.h;
  if (r.x <= 0 || r.y <= 0) return '未留出边距：' + r.x + ',' + r.y;
  return true;
});

/* ------------------------------------------------------------------ *
 * 2. 连续 6 个窗口：都在视口内，且两两不完全重叠
 * ------------------------------------------------------------------ */

check('连续 6 个窗口都在视口内且不完全重叠', () => {
  const windows = [];
  for (let i = 0; i < 6; i += 1) {
    const r = placeNewWindow(windows, 720, 480, VP);
    if (!fullyInside(r, VP)) return '第 ' + (i + 1) + ' 个窗口超出视口：' + JSON.stringify(r);
    windows.push({ id: 'w' + i, appId: 'app' + i, title: 'app' + i, x: r.x, y: r.y, w: r.w, h: r.h, z: 10 + i, min: false });
  }
  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      const a = windows[i];
      const b = windows[j];
      if (a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h) {
        return '窗口 ' + (i + 1) + ' 与 ' + (j + 1) + ' 完全重叠：' + a.x + ',' + a.y;
      }
    }
  }
  return true;
});

check('阶梯偏移为 +28/+24', () => {
  const w0 = placeNewWindow([], 720, 480, VP);
  const w1 = placeNewWindow([{ id: 'a' }], 720, 480, VP);
  const w2 = placeNewWindow([{ id: 'a' }, { id: 'b' }], 720, 480, VP);
  if (w1.x - w0.x !== 28 || w1.y - w0.y !== 24) return '第 2 个窗口偏移不是 +28/+24：' + (w1.x - w0.x) + '/' + (w1.y - w0.y);
  if (w2.x - w1.x !== 28 || w2.y - w1.y !== 24) return '第 3 个窗口偏移不是 +28/+24：' + (w2.x - w1.x) + '/' + (w2.y - w1.y);
  return true;
});

/* ------------------------------------------------------------------ *
 * 3. 拖动到负坐标：至少保留 80px 标题栏可见
 * ------------------------------------------------------------------ */

check('拖到负坐标仍保留至少 80px 标题栏可见', () => {
  const r = clampWindow(-9999, -9999, 720, 480, VP);
  if (visibleTitlebar(r, VP) < TITLEBAR_VISIBLE) {
    return '可见标题栏仅 ' + visibleTitlebar(r, VP) + 'px（要求 >= ' + TITLEBAR_VISIBLE + '）';
  }
  if (r.y !== 0) return '垂直方向应把标题栏夹在视口内，实际 y=' + r.y;
  return true;
});

check('拖到右下角不会把窗口推出视口', () => {
  const r = clampWindow(99999, 99999, 720, 480, VP);
  if (r.x + TITLEBAR_VISIBLE > VP.w) return '左边界越界：x=' + r.x;
  if (r.y + 34 > VP.h) return '标题栏越界：y=' + r.y;
  return true;
});

check('每个方向都至少保留 80px 标题栏可见（多角度）', () => {
  const cases = [
    [-500, 0],
    [5000, 0],
    [0, -900],
    [0, 9000],
    [-5000, 9000],
  ];
  for (const c of cases) {
    const r = clampWindow(c[0], c[1], 720, 480, VP);
    if (visibleTitlebar(r, VP) < TITLEBAR_VISIBLE) return '坐标 ' + c.join(',') + ' 下可见标题栏不足 80px：' + JSON.stringify(r);
    if (r.y < 0) return '坐标 ' + c.join(',') + ' 下标题栏跑到视口上方：y=' + r.y;
  }
  return true;
});

/* ------------------------------------------------------------------ *
 * 4. 最小尺寸被强制
 * ------------------------------------------------------------------ */

check('最小尺寸 320x220 被强制（clampWindow）', () => {
  const r = clampWindow(10, 10, 100, 80, VP);
  if (r.w !== MIN_W || r.h !== MIN_H) return '尺寸未被夹到最小：' + r.w + 'x' + r.h;
  return true;
});

check('最小尺寸 320x220 被强制（placeNewWindow）', () => {
  const r = placeNewWindow([], 100, 80, VP);
  if (r.w < MIN_W || r.h < MIN_H) return '新窗口小于最小尺寸：' + r.w + 'x' + r.h;
  return true;
});

check('窗口尺寸不会超过视口', () => {
  const small = { w: 800, h: 600 };
  const r = placeNewWindow([], 2000, 2000, small);
  if (r.w > small.w || r.h > small.h) return '窗口大于视口：' + r.w + 'x' + r.h;
  return true;
});

check('小视口下仍能给出合法矩形', () => {
  const tiny = { w: 200, h: 150 };
  const r = placeNewWindow([], 720, 480, tiny);
  if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isFinite(r.w) || !Number.isFinite(r.h)) {
    return '出现非法数值：' + JSON.stringify(r);
  }
  if (r.w < MIN_W || r.h < MIN_H) return '尺寸小于最小值：' + r.w + 'x' + r.h;
  if (visibleTitlebar(r, tiny) < TITLEBAR_VISIBLE) return '可见标题栏不足 80px：' + JSON.stringify(r);
  return true;
});

check('非法输入不会产生 NaN', () => {
  const r = clampWindow(NaN, undefined, 'abc', null, {});
  if ([r.x, r.y, r.w, r.h].some((v) => !Number.isFinite(v))) return '出现非法数值：' + JSON.stringify(r);
  return true;
});

/* ------------------------------------------------------------------ *
 * 结果
 * ------------------------------------------------------------------ */

console.log('RESULT: ' + passed + ' passed, ' + failed + ' failed');
if (failed > 0) process.exit(1);
