# Host API 增补清单 v1（Lead 内核实现，全部保证可用）

本文件是 `CONTRACT.md` §4 的补充，列出**内核一定会实现**的 Host 方法。可以放心调用，不需要再确认。

## 1. 桌面与应用

```js
Host.desktop.wallpaperKind()          // -> 'aurora' | 'grid' | 'solid'
Host.desktop.setWallpaperKind(kind)   // 立即生效 + 落盘
Host.desktop.refresh()                // 重绘墙纸
Host.apps({ q } = {})                 // 应用清单 [{id,name,icon,desc,singleton}]，q 为名字/描述模糊搜索
Host.appMeta(appId)                   // -> 清单项 | null
Host.launch(appId, opts = {})         // 等价 Host.wm.launch，返回 windowId | null
Host.openFile(path)                   // -> windowId | null（按扩展名选应用，.txt/.md -> notes，其余 -> files）
Host.power('reboot')                  // 重放开机序列（会保留状态）
```

## 2. 窗口管理器（shell/wm.js 必须实现；Host.wm 是它的转发）

```js
Host.wm.launch(appId, opts)   // opts:{file,args,title,width,height}
Host.wm.close(windowId)
Host.wm.focus(windowId)
Host.wm.minimize(windowId)    // 可选
Host.wm.restore(windowId)     // 可选
Host.wm.list()                // -> [{id,appId,title,x,y,w,h,z,min}]
Host.wm.focused()             // -> windowId | null
Host.wm.on(evt, cb)           // 'open'|'close'|'focus'|'minimize'|'restore'|'resize'，返回取消函数
Host.wm.toggleApp(appId)      // 已开则最小化/聚焦，未开则启动
```

* `Host.wm.launch` 返回 `null` 表示应用模块加载失败，**必须** `Host.notify(..., level:'error')` 说明原因。

## 3. 开始菜单

```js
Host.startMenu.toggle()
Host.startMenu.open()
Host.startMenu.close()
Host.startMenu.isOpen()       // -> boolean
```

## 4. 元素辅助（Host.el 的 props 白名单）

`Host.el(tag, props, ...children)`：

* 特殊键：`className` `textContent` `innerHTML` `title` `type` `value` `placeholder` `disabled` `checked` `id`
* `style`：对象（转 cssText）或字符串
* `dataset`：对象
* `class`：`className` 的别名
* `on*`：任何以 `on` 开头的键直接 `addEventListener(键去掉 on 的小写, value)`
* 其余键 `setAttribute(k, v)`
* `children`：字符串按文本节点插入（**不解析 HTML**，需要 HTML 用 `innerHTML`），节点/节点数组正常 append，`null/undefined/false` 跳过。
* 返回值就是创建的元素。

## 5. 全局类名（styles/system.css，Lead 提供）

`.ph-btn`（+ `.primary` `.danger` `.ghost` `.sm` `.icon`）
`.ph-input` `.ph-select` `.ph-textarea` `.ph-range` `.ph-card` `.ph-row` `.ph-col`
`.ph-title` `.ph-sub` `.ph-badge`（+ `.ok` `.warn` `.err`）`.ph-progress` `.ph-progress > i`
`.ph-scroll` `.ph-mono` `.ph-grid` `.ph-toolbar` `.ph-tabs`（+ `.on`）`.ph-sep` `.ph-empty`
`.ph-kbd`

CSS 变量：`--accent` `--accent-2` `--bg-0` `--bg-1` `--bg-2` `--fg` `--fg-dim` `--line` `--win-shadow` `--radius` `--ok` `--warn` `--err` `--gold`。

## 6. 音效名（Host.audio.sfx）

`click` `open` `close` `error` `ok` `typing` `boot` `judge-perfect` `judge-good` `judge-bad` `judge-miss` `combo`

## 7. 约定

* 单例应用：`taskbar` / `start` / `wm` / `notifications` / `boot` 不是应用，由内核直接管理。
* 音游应用 `phigros` 的 `mount` 必须返回 `destroy`，内部负责 `Host.raf` 的取消与 `AudioEngine` 的释放。
* 内核会在 `window` 上挂 `window.PhigrOS = { version, ready: Promise<void>, state, kernel }`。
  `ready` resolve 后所有 Host API 均可用。**所有应用 `mount` 时 `ready` 必已 resolve。**
