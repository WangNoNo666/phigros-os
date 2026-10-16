# phigrOS

> **An OS tuned for rhythm games** —— 一个为音游而生的网页操作系统外壳，内置可玩的 Phigros 风格下落式音游。

纯静态、**零构建、零依赖、零 CDN、可离线运行**：用浏览器打开 `index.html` 就能开机。

**🎮 在线试玩**：<https://wangnono666.github.io/phigros-os/>
（GitHub Pages 托管，无需安装任何东西）

```
phigrOS/
├─ index.html            开机自检 → 桌面
├─ boot.js               启动入口（暴露 window.PhigrOS）
├─ styles/shell.css      设计令牌 + 桌面/窗口/任务栏/通知/对话框/组件类
├─ js/core/
│   ├─ state.js          唯一状态源（不可变更新 + 订阅 + localStorage 持久化 + 迁移）
│   ├─ kernel.js         内核：应用登记/启动、子系统装配、开机序列
│   ├─ host.js           宿主 API（window.Host）：DOM/工具/VFS/窗口/通知/对话框/成就/音频
│   ├─ compositor.js     桌面合成：墙纸/图标/开始菜单/右键菜单/主题/FPS
│   └─ palette.js        主题色相预设
├─ js/shell/
│   ├─ wm.js             窗口管理器（拖动/缩放/层叠/最小化/生命周期）
│   └─ taskbar.js        任务栏 + 时钟 + 音量托盘
├─ js/engine/
│   ├─ audio.js          程序化音频合成（离线渲染整曲 → 时钟与谱面天然同步）
│   ├─ phigros.js        判定引擎（纯函数）+ 渲染/输入主引擎
│   └─ chartgen.js       确定性谱面生成器（mulberry32 PRNG）
├─ js/apps/              phigros / terminal / files / notes / settings / about
├─ data/charts/          3 首曲目的曲式与谱面
├─ tests/                node 纯逻辑自测（判定/谱面/窗口/状态/应用/帧循环）
└─ dev/                  静态服务器、语法检查、浏览器验收台、帧率诊断
```

## 快速开始

### 方式一：直接在线玩

打开 <https://wangnono666.github.io/phigros-os/> 即可。

### 方式二：本地运行

ES Module 需要 http 协议（直接双击 `file://` 打开会被浏览器拦截），所以起一个静态服务：

```powershell
cd phigros-os
node dev/server.mjs          # 默认 http://127.0.0.1:4173/
```

浏览器打开 <http://127.0.0.1:4173/>，等开机自检跑完（约 1 秒）即进入桌面。

> 想直接体验音游：桌面双击 **🎵 Phigros** → 选一首 → 点「开始」。第一次点击会解锁音频（浏览器自动播放策略）。

## 怎么玩

| 操作 | 说明 |
|---|---|
| `D` `F` `J` `K` | 4 lane 曲目（First Light）键位 |
| `S` `D` `F` `J` `K` `L` | 6 lane 曲目（Void Cathedral）键位；5 lane 用中间五键 |
| 鼠标 / 触屏 | 直接点/划到音符位置（`drag` 音符划线即判定 perfect） |
| `Esc` | 暂停（继续 / 重开 / 退出） |
| `Ctrl+空格` | 开始菜单 |
| `Ctrl+F5` | 重启系统 |
| 桌面右键 | 新建文件/文件夹、换墙纸、打开终端 |

判定窗口与计分（与谱面时间同基准，时钟来自 `AudioContext`）：

| 偏差 | 判定 | 系数 |
|---|---|---|
| ≤ 45 ms | PERFECT | 1.00 |
| ≤ 90 ms | GOOD | 0.65 |
| ≤ 150 ms | BAD | 0.30 |
| > 150 ms | MISS | 0.00 |

总分 1,000,000 × 准确率；全 PERFECT 为 **S**，`acc ≥ 0.93` 为 A、`≥ 0.85` 为 B、`≥ 0.70` 为 C，否则 F。成绩写入 `player.record`，RKS 按最高 27 个成绩计算。

## 内置曲目

| 曲目 | 难度 | 定数 | BPM | 音符数 |
|---|---|---|---|---|
| First Light | Easy | 4 | 128 | ~200+ |
| Neon Runner | Hard | 9 | 150 | ~550+ |
| Void Cathedral | Extra | 13 | 175 | 1063 |

三首曲子的音频**全部由 Web Audio 程序化合成**（鼓组/贝斯/和声垫/主旋律），没有任何外部音频文件——所以整个系统可以完全离线运行。

## 内置应用

- **Phigros** — 主菜：选曲、速度/偏移调节、倒计时、判定、结算、记录与成就
- **终端** — `help` `ls` `cd` `cat` `echo >` `mkdir` `rm` `open` `apps` `launch` `ps` `kill` `volume` `theme` `sysinfo` `score` `achievements` `date` `whoami` `reboot`
- **文件管理器** — 目录树、导航、新建/重命名/删除、文件关联（`.txt`→记事本、`.json`/`.phigros`→音游）
- **记事本** — 防抖自动保存、`Ctrl+S`、字数统计
- **设置** — 外观（主题色相/墙纸/扫描线/FPS）、声音（音量/音效/BGM/试听）、音游（速度/偏移）、数据（存档导出/重置）
- **关于** — 系统信息、成就一览、重启

## 自测与验收

```powershell
cd phigros-os

# 1) 语法 + 结构 + 策略自检（ESM 解析、禁止外部 URL/eval、交付清单）
node --experimental-vm-modules dev/check.mjs

# 2) 纯逻辑单元测试
node tests/test-core-state.mjs       # 状态机 / VFS 不变量
node tests/test-engine-judge.mjs     # 判定窗口 / 计分 / 完整假时钟流程
node tests/test-engine-charts.mjs    # 三首谱面的全部不变量 + 生成确定性
node tests/test-shell-wm.mjs         # 窗口摆放/夹取/最小尺寸
node tests/test-apps-sysapps.mjs     # 初始文件系统 / 成就表 / 应用清单

# 3) 浏览器端到端验收
node dev/server.mjs
#   然后打开 http://127.0.0.1:4173/dev/verify.html
#   验收台会在同源 iframe 里加载真实 phigrOS，自动跑 19 项检查并把报告
#   回传到 dev/last-report.json
```

`dev/verify.html` 覆盖：开机 → 桌面/任务栏/时钟 → 应用清单 → VFS 读写 → 开始菜单 → 终端命令 → 主题与成就 → 音游选曲 → 进入游玩 → 真实键盘判定 → 结算 → 成绩入档 → 窗口管理 → 持久化 → 文件管理器 → 设置 → 无 console error。

`dev/smoke.mjs` 是 CDP 版本的冒烟测试（真实 Edge + 截图）。注意：部分 Windows 沙箱/企业策略环境会拦截页面级 CDP 命令（`Runtime.enable` 无响应），此时请改用 `dev/verify.html`。

## 设计要点

1. **音符用 DOM + CSS `transform` 渲染（默认后端）**：每个音符是一个 `translate3d()` 定位的元素，动画交给浏览器合成器线程，JS 每帧只改样式字符串——不需要逐像素光栅化。这在软件渲染 / 关闭 GPU 合成的环境里依然能保持连续下落（Canvas 2D 会退化成一帧一屏）。同一思路参考了 [Sparebeat](https://beta.sparebeat.com/)。Canvas 后端保留，可在「设置 → 音游 → 渲染后端」切换。
   - 元素**全部复用**（对象池），实测每帧 JS 工作量 0.008ms。
2. **单一状态源**：所有状态都在 `js/core/state.js`，不可变更新 + 路径订阅 + 自动落盘；`version`/`schema` 不匹配时做字段合并迁移，不丢用户数据。
3. **判定逻辑是纯函数**：`judgeWindow` / `computeScore` / `visibleNotes` / `buildTimeline` 可在 node 下用假时钟完整驱动测试，音游手感可以被自动化验证。
4. **确定性谱面**：`chartgen.js` 用自带 mulberry32 PRNG（不用 `Math.random`），同 seed 生成完全一致，谱面全部落在 BPM 网格上，同轨最小间隔 ≥ 0.09s。
5. **默认不开音频合成**：整曲离线渲染（`OfflineAudioContext`）会把主线程占满数秒，直接毁掉判定手感，因此默认关闭。需要音乐时在「设置 → 声音 → 程序化音乐合成」打开；此时渲染有预算熔断，超时会自动降级。
6. **契约先行**：`CONTRACT.md` 冻结了状态结构、VFS 格式、宿主 API、应用接口与谱面格式，五名成员（内核/窗口/引擎/应用）按各自写入范围并行开发，只通过契约耦合。

## 性能与兼容性

### 已修复的两个关键缺陷（都会表现为「一帧一屏 / 整个页面卡死」）

1. **rAF 帧循环泄漏（最严重）**：早期 `Host.raf()` 每次调用都注册一个 `visibilitychange` 监听，而引擎每帧调用一次、又丢弃返回的取消函数——监听器以 60/秒泄漏。用户切换标签页时，成百上千个陈旧监听器会**同时把旧帧循环重新启动**，多条帧循环并发推进同一个判定核：游戏时钟跑到 **2.88 倍速**（音符跳格、看不到下落过程），最终整个页面卡死。
   现已改为：全程**只注册 1 个** `visibilitychange` 监听 + 活跃循环集合统一管理 + `resume()` 幂等；引擎侧加「单链闸门」（任何时刻只允许一个待执行的下一帧）。回归测试见 `tests/test-core-raf.mjs`。
2. **`ResizeObserver` 无限循环**：观察尺寸 → 回调改尺寸 → 再次触发，形成主线程死循环（页面无响应）。现已 `resize()` 幂等短路 + rAF 去抖。

### 如果你遇到掉帧或「音符不连续下落」

1. 「设置 → 外观 → **流畅模式**」默认已开（关闭背景模糊/动画/混合模式）。
2. 「设置 → 音游 → **渲染后端**」保持 `DOM`（默认，音符为 CSS transform，交给合成器线程）。
3. 「设置 → 外观 → 显示 FPS」可观察右上角实时帧率。
4. 关闭「程序化音乐合成」（默认已关；开启会整曲离线渲染，占主线程数秒）。
5. 浏览器若启用「效率模式 / 省电模式」，或**关闭了图形加速（软件渲染）**，都会让画面严重掉帧——这属于环境问题。引擎检测到连续 3 帧间隔 > 250ms 会自动改用定时器驱动。

### 内置遥测（可直接在控制台查看）

| 全局 | 内容 |
|---|---|
| `window.__PHIGROS_TELEMETRY__` | 平均帧、最长帧、单帧工作耗时、**帧间空档**、长任务、驱动方式、渲染后端 |
| `window.__PHIGROS_LOOP_ESCALATED__` | 是否因 rAF 节流切换为定时器驱动 |
| `window.__PHIGROS_PERF__` | 是否触发降载（关闭辉光） |
| `window.Host.rafLoopCount()` | 活跃帧循环数，**正常恒为 1**；大于 1 即为帧循环泄漏 |
| `http://127.0.0.1:4173/dev/fps-diag.html` | 一键诊断：GPU 渲染器 / 是否软件渲染 / 帧率 / 时钟倍率 / 长任务 |

## 键盘与权限说明

- 首次点击/按键会解锁 `AudioContext`（浏览器要求用户手势），此前音量类操作会安全降级。
- 存档在 `localStorage` 的 `phigros-os:state:v1`，设置页可导出为 JSON、也可一键重置。
- 不依赖网络：没有 CDN、没有远程字体、没有外部音频。

## 已知限制

- 判定线做水平移动（`chart.lines` 支持时间轴与横向位置），尚未实现 Phigros 的整线旋转与 Rotaeno 式旋转判定。
- 谱面为程序化生成 + 手工校核，不是官方谱面。
- 无音频设备的环境下会退化到 `performance.now()` 时钟，判定精度略低。
