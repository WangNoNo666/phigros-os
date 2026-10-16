# phigrOS — 模块契约（冻结版 v1）

> **所有成员必须严格遵守本文件。** 它定义了唯一的状态结构、文件系统格式、宿主 API、应用接口与谱面格式。
> 任何跨模块的额外字段/方法都可以**新增**，但**不得修改或删除**这里已声明的字段与方法。
> 项目根目录：`phigros-os/`。所有路径相对该目录。

---

## 0. 项目形态

* 纯静态、零构建、零 CDN。浏览器直接打开 `index.html` 即可运行（推荐用 `tools/dev-server.mjs` 起静态服务，ES Module 需要 http 协议）。
* 全局命名空间只允许一个：`window.PhigrOS`。宿主对象是 `window.Host`。
* 所有源码为 **ES Module**，`<script type="module" src="./boot.js">`。
* 禁止 `import` 任何第三方包；禁止 `fetch` 外部 URL；禁止 `eval`。
* 语言：界面文案中文，注释中文，代码标识符英文。

## 1. 目录与写入范围（write scope）

```
phigros-os/
  index.html             Lead
  boot.js                Lead
  styles/                Lead
  dev/                   Lead          开发服务器 / 自测脚本
  README.md              Lead
  CONTRACT.md            Lead
  js/core/state.js       Lead          唯一状态源
  js/core/kernel.js      Lead          内核：启动应用 / 通知 / 音量 / 生命周期
  js/core/host.js        Lead          宿主 API 实现（暴露 window.Host）
  js/core/compositor.js  Lead          主墙纸 / 桌面图标 / 右键菜单
  js/shell/wm.js         shell-wm      窗口管理器
  js/shell/taskbar.js    shell-wm      底部任务栏 + 时钟
  js/engine/*.js         engine        音频引擎 + 音游引擎
  js/apps/phigros.js     engine        音游应用（挂载器，调用引擎）
  js/apps/*.js           sysapps       除 phigros 与 terminal 外的系统应用
  js/apps/terminal.js    Lead          终端
  data/charts/*.js       engine        曲目与谱面数据（ES Module，export default）
  tests/*               各自作者        纯函数自测（node 运行），文件名 `test-<owner>-*.mjs`
```

**不要写别人的文件。** 需要对方改动时，发消息给 Lead 或直接给对方成员，不要自己动手。

## 2. 状态（唯一状态源）

`js/core/state.js` 由 Lead 提供，实现如下契约（其他人只读，通过方法改）：

```js
import { store } from '../core/state.js';

store.get()                       // 只读快照对象（结构见下）
store.set(path, value)            // 例：store.set('settings.volume', 0.8)
store.update(path, fn)            // 例：store.update('player.record', r => ({...r, best: 999}))
store.subscribe(path, cb)         // 返回取消函数；path 变化时 cb(value, path)
store.save()                      // 立即落盘 localStorage
store.reset()                     // 恢复默认值
```

状态结构（**不得增删顶层键**；`settings` / `achievements` 下可自由新增键，但需在一处集中声明）：

```js
{
  version: 1,
  boot: { firstRun: true, bootCount: 0, lastBootAt: 0, bootTimeMs: 0 },
  fs: { '/': { type: 'dir', children: ['/home'] }, /* 见 §3 */ },
  windows: [ { id, appId, title, x, y, w, h, z, min: false } ],
  zTop: 10,
  settings: {
    volume: 0.8,        // 0..1  主音量
    sfx: true,          // 系统音效
    bgm: true,          // 大厅背景音乐
    speed: 1.0,         // 音游常规下落速度倍率 0.5..2.0
    offsetMs: 0,        // 判定全局偏移，-200..200
    themeHue: 190,      // 主色相
    scanlines: true,    // CRT 扫描线
    showFps: false      // 右上角帧率
  },
  player: { name: 'PHIGROS-PLAYER', rks: 0, totalPlay: 0, record: {} },
  // record: { [trackId]: { [difficulty]: { score, acc, grade, fc, maxCombo, plays, updatedAt } } }
  achievements: {}      // { [id]: { unlocked: true, at: 1234567890 } }
}
```

* `store.get()` 返回**深拷贝**，改动它不会影响状态。
* 默认值与迁移逻辑写在 `state.js` 内；`version` 不匹配时做字段合并，不丢用户数据。

## 3. 文件系统（VFS）

扁平化内存对象，键是**绝对路径**，`'/'` 为根目录：

```js
fs = {
  '/':                 { type: 'dir',  children: ['/home'] },
  '/home':             { type: 'dir',  children: ['/home/README.txt'] },
  '/home/README.txt':  { type: 'dir',  children: [], text: '内容', mtime: 1700000000000 }
}
```

* 目录节点：`{ type:'dir', children:[绝对路径...] }`
* 文件节点：`{ type:'dir', children:[], text:'...' }` —— **注意**：为了简化，文件也用 `type:'dir'` 标记？**不**。
  * 正确：目录 `{ type:'dir',  children:[...] }`；文件 `{ type:'file', text:'...', mtime:number }`。
  * 目录的 `children` 必须与其子节点的父路径一致（见 `Host.fs` 的不变量）。

宿主 API（所有人通过它读写，**不要直接改 `store` 的 `fs`**）：

```js
Host.fs.list(dirPath)                 // -> [{name, path, type:'dir'|'file', size, mtime}]
Host.fs.read(filePath)                // -> string | null
Host.fs.write(filePath, text)         // 覆盖写；父目录不存在会自动创建；返回该路径
Host.fs.append(filePath, text)        // 追加
Host.fs.mkdir(dirPath)                // 幂等创建目录
Host.fs.remove(path)                  // 递归删除文件/目录
Host.fs.exists(path)
Host.fs.stat(path)                    // -> {name,path,type,size,mtime} | null
```

## 4. 宿主 API（`window.Host`）

`js/core/host.js` 提供，**只增不改**。所有应用都通过它访问系统能力。

```js
// —— DOM ——
Host.$  (sel, root = document)        // -> Element | null
Host.$$ (sel, root = document)        // -> Element[]
Host.el (tag, props = {}, ...children) // -> Element；props 支持 className/textContent/innerHTML/
                                       //    title/type/value/placeholder/style(对象或字符串)/
                                       //    dataset(对象)/onclick 等 on* 直接透传；children 可为字符串/节点/数组

// —— 工具 ——
Host.clamp(v, lo, hi)                 // 数值夹取
Host.lerp(a, b, t)
Host.sleep(ms)                        // -> Promise<void>
Host.now()                            // -> performance.now() 基准毫秒（音频时钟基准，见 §6）
Host.store                            // state 的只读门面：get/set/update/subscribe/save
Host.fs                               // 见 §3
Host.formatTime(ms)                   // -> 'mm:ss'
Host.escapeHtml(s)                    // -> 安全字符串
Host.raf(fn)                          // -> cancel()，自动暂停/恢复，vm 有 delta 参数：(dtMs, nowMs)
Host.randomId(prefix = 'id')          // -> 'id-xxxxxx'

// —— 窗口 ——
Host.wm.launch(appId, opts = {})      // opts: {file, args, title}  -> windowId | null
Host.wm.close(windowId)
Host.wm.focus(windowId)
Host.wm.list()                        // -> 窗口快照数组
Host.wm.focused()                     // -> windowId | null
Host.wm.on(evt, cb)                   // evt: 'open'|'close'|'focus'|'minimize'|'restore'|'resize'
                                      // cb(payload) 返回取消函数
// —— 通知 ——
Host.notify(title, body = '', opts = {}) // opts: {icon, timeout=3200, level:'info'|'warn'|'error'}
Host.dialog(opts)                     // -> Promise<string|null|boolean>
// opts: {title, body, input?:{label,value,placeholder}, confirm?:bool, danger?:bool}
// 无 input 且无 confirm -> 只有一个「知道了」，resolve null
// 无 input 且 confirm  -> resolve true|false
// 有 input             -> resolve string|null
Host.achievement(id, title, desc = '') // 幂等解锁，已解锁则忽略

// —— 应用/系统 ——
Host.apps()                           // -> 应用清单 [{id,name,icon,desc}]
Host.onFocus(cb)                      // 窗口获得焦点时 cb(appId, winId)，返回取消函数
Host.refreshWallpaper()               // 主墙纸/主题变化后由内核调用

// —— 音频 ——
Host.audio.unlock()                   // 用户手势后调用，恢复 AudioContext
Host.audio.setVolume(v)               // 0..1，同时联动系统音效与 BGM
Host.audio.volume()                   // -> number
Host.audio.sfx(name)                  // 'click'|'open'|'close'|'error'|'ok'|'typing'
Host.audio.playBgm(kind = 'lobby')    // 'lobby'|'none'
```

## 5. 应用契约（App Module）

每个应用模块 `export default` 一个对象：

```js
export default {
  id: 'files',                 // 唯一，等于文件名
  name: '文件管理器',            // 窗口标题与任务栏文字
  icon: '📁',                   // 任务栏/开始菜单图标（emoji）
  desc: '浏览 phigrOS 虚拟文件系统',
  singleton: false,            // true 则同一应用只允许一个窗口
  width: 720, height: 480,     // 默认窗口尺寸（px），可选
  accent: '#22d3ee',           // 可选，窗口强调色
  async mount(root, ctx) {
    // root: 窗口内容容器（已被内核清空）；ctx: { windowId, appId, args }
    // 返回（可选）: { destroy(){}, onFocus(){}, onBlur(){}, onResize(w,h){} }
  }
}
```

* 内核负责：创建窗口 DOM、标题栏、加载模块、调用 `mount`、关闭时调用 `destroy`。
* 应用**不得**操作 `#windows` 之外或自己窗口内部的 DOM。
* 应用不得使用 `document.body` 上的全局事件监听而不清理；一律返回 `destroy` 清理。
* 应用清单在 `js/apps/manifest.js`（Lead 维护），新增应用必须在那里登记。

### 5.1 应用模块可用元素

内核已为窗口内容容器设置 `class="win-body"`，应用可自由使用以下**全局类名**（`styles/system.css` 由 Lead 提供）：

`.ph-btn` `.ph-btn.primary` `.ph-btn.danger` `.ph-input` `.ph-select` `.ph-card` `.ph-row`
`.ph-title` `.ph-sub` `.ph-progress` `.ph-badge` `.ph-scroll` `.ph-mono` `.ph-grid`

颜色一律用 CSS 变量：`var(--accent)` `var(--bg-1)` `var(--bg-2)` `var(--fg)` `var(--fg-dim)` `var(--line)`。

## 6. 音频与时间基准（重要）

* 音频引擎位于 `js/engine/audio.js`，导出 `AudioEngine`（单例 `AudioEngine.instance`）。
* **主时钟规则**：音游播放时必须使用 `AudioEngine.currentTime()`（由 `AudioContext.currentTime` 换算），
  **不得**用 `Date.now()` 或 `performance.now()` 做判定。`Host.now()` 仅用于 UI 动画。
* `AudioEngine` 必须提供：

```js
AudioEngine.instance.unlock()            // -> Promise<void>
AudioEngine.instance.ready()             // -> boolean
AudioEngine.instance.setVolume(v)        // 0..1
AudioEngine.instance.renderChartToBuffer(chart, track) // -> Promise<AudioBuffer>  离线渲染整曲
AudioEngine.instance.play(buffer, {at = 0, loop = false, gain = 1}) // -> handle
AudioEngine.instance.currentTime(handle) // -> 秒（无 handle 用最近一次播放）
AudioEngine.instance.pause(handle) / resume(handle) / stop(handle)
AudioEngine.instance.playBgm(kind) / stopBgm()
AudioEngine.instance.sfx(name)
```

* 曲目音频**必须程序化合成**（Web Audio Oscillator/Buffer 手写），不依赖任何外部音频文件。
* 谱面时间单位是**秒**（`time` / `hold` / `bpm` 段内秒数），与 `currentTime` 同基准。

## 7. 曲目与谱面数据格式

文件 `data/charts/<trackId>.js`，`export default` 一个 **track**：

```js
export default {
  id: 'first-light',            // 必须与文件名一致、全局唯一
  title: 'First Light',
  artist: 'phigrOS Sound Team',
  bpm: 128,
  length: 96,                   // 秒
  difficulty: 4,                // 1..16 定数
  color: '#22d3ee',
  difficultyName: 'Easy',
  // 程序化曲式（供 AudioEngine 合成，字段自由，但建议包含）
  music: {
    key: 'A', scale: 'minor', mood: 'bright',
    sections: [ { at: 0, bars: 8, drums: 'light' }, { at: 32, bars: 8, drums: 'full' } ]
  },
  chart: {
    offset: 0,                  // 秒：整体提前/延后
    lines: [                    // 判定线时间轴；缺省则始终 x=0.5
      { at: 0, x: 0.5, angle: 0 },
      { at: 16, x: 0.5, angle: 0 },
      { at: 32, x: 0.35, angle: 0 },
      { at: 48, x: 0.5, angle: 0 }
    ],
    notes: [
      { time: 1.875, x: 0.25, type: 'tap' },
      { time: 3.75,  x: 0.75, type: 'drag' },
      { time: 5.625, x: 0.5,  type: 'hold', hold: 1.5 }
    ]
  }
}
```

* `time`：从曲目开头算起的秒数（不含 BPM 变化，本版本统一以秒表达）。
* `x`：0..1 横向位置。
* `type`：`'tap' | 'drag' | 'hold'`。
* `hold`：仅 `hold` 需要，持续秒数。
* 至少交付 **3 首**：`first-light`（Easy 3~4）、`neon-runner`（Hard 8~9）、`void-cathedral`（Extra 13+）。
  难度越高越密集，但**必须保证人工可验证的正确性**：所有 `time` 递增、`x∈[0,1]`、相邻同轨音符间隔 ≥ 0.09s。

## 8. 音游引擎（`js/engine/phigros.js`）

导出纯函数与主引擎类，**判定逻辑必须是纯函数**，便于 node 自测：

```js
export const JUDGE = { PERFECT: 1, GOOD: 2, BAD: 3, MISS: 4 };   // 内部常数
export function judgeWindow(diffMs)      // -> {grade:'perfect'|'good'|'bad'|'miss', score:0..1, label}
export function computeScore(counts, total) // -> {score:0..1000000, acc:0..1, grade:'S'|'A'|'B'|'C'|'F', fc:bool}
export function visibleNotes(notes, tSec, speed, hitLineY = 0.86) // -> [{note, y, alpha}]
export class PhigrosGame { /* mount 到 canvas 的主引擎，见 §5 应用契约 */ }
```

判定窗口（毫秒，绝对值）：

| 偏差 | 等级 | 单键得分系数 |
|---|---|---|
| ≤ 45 | perfect | 1.00 |
| ≤ 90 | good | 0.65 |
| ≤ 150 | bad | 0.30 |
| > 150 | miss | 0.00 |

* 总分 1,000,000：`score = 1e6 * (Σ noteScore) / total`；`acc = Σ noteScore / total`。
* 全 perfect → `grade = 'S'`，`acc ≥ 0.93` → `'A'`，`≥ 0.85` → `'B'`，`≥ 0.70` → `'C'`，否则 `'F'`。
* `fc = counts.miss === 0`；`maxCombo` 在 miss 时归零。
* 键位映射：4 lane = `d f j k`，6 lane = `s d f j k l`，同时支持鼠标/触摸点击（多点触控）。
* 下落速度：`pxPerSec = 520 * settings.speed`（以 720p 高为基准，按画布高缩放）。
* 判定线 Y 固定为 `0.86 * canvasH`。
* 暂停：`Esc` 暂停并弹出继续/重开/退出。

## 9. 验证要求

* 每个 `.js` 文件必须能通过 `node --check`（ES Module 语法）：Lead 会跑 `node dev/check.mjs`。
* 判定/计分/可见性纯函数必须有自测：`tests/test-engine-*.mjs`，`node tests/xxx.mjs` 输出 `PASS/FAIL` 并 exit code。
* 最终由 Lead 起静态服务，用真实浏览器（Chromium/Edge headless 截图 + console error 抓取）验证：
  开机动画 → 桌面 → 打开音游 → 开始 → 判定得分 → 结算 → 记录写入 `player.record`。
* **任何 console error 都视为失败。**

## 10. 沟通

* 完成后向 Lead 报告：改动的文件绝对路径、`node --check` 结果、自测命令与输出摘要、未完成项。
* 发现契约需要变更 → 先告诉 Lead，由 Lead 更新本文件后再动手。
