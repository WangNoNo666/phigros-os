// manifest.js —— 应用清单（集中登记）
//
// 契约：export default 应用模块对象数组；数组顺序即开始菜单顺序。
// 内核支持两种清单项：
//   1. 直接是应用模块对象（含 id/name/icon/desc）——静态 import 的四个系统应用；
//   2. 含 loader() 的惰性清单项——terminal.js / phigros.js 由其他成员交付，
//      首次启动该应用时才异步加载，缺失或加载失败不会影响开机与开始菜单。
//
// 数组顺序：终端、Phigros、文件管理器、记事本、设置、关于。

import filesApp from './files.js';
import notesApp from './notes.js';
import settingsApp from './settings.js';
import aboutApp from './about.js';

/**
 * 构造惰性清单项。
 * @param {object} meta 菜单用的元信息（id/name/icon/desc/...）
 * @param {string} spec 相对本文件的模块路径
 */
function lazyApp(meta, spec) {
  return Object.assign({}, meta, {
    loader() {
      return import(spec).then(
        (mod) => {
          const app = mod && mod.default;
          if (!app || !app.id) {
            throw new Error('应用模块缺少合法的 default 导出：' + spec);
          }
          return app;
        },
        (err) => {
          const reason = err && err.message ? err.message : String(err);
          console.warn('[manifest] 惰性加载失败 ' + spec + '：' + reason);
          throw err instanceof Error ? err : new Error(reason);
        }
      );
    }
  });
}

/** 终端（Lead 交付，可能尚未存在） */
const terminalApp = lazyApp(
  {
    id: 'terminal',
    name: '终端',
    icon: '⌨️',
    desc: 'phigrOS 命令行',
    singleton: false,
    width: 720,
    height: 440,
    accent: '#22c55e'
  },
  './terminal.js'
);

/** 音游（engine 交付，可能尚未存在） */
const phigrosApp = lazyApp(
  {
    id: 'phigros',
    name: 'Phigros',
    icon: '🎵',
    desc: '下落式音游，支持 tap / drag / hold',
    singleton: false,
    width: 900,
    height: 620,
    accent: '#22d3ee'
  },
  './phigros.js'
);

/** 应用清单（顺序即开始菜单顺序） */
const manifest = [terminalApp, phigrosApp, filesApp, notesApp, settingsApp, aboutApp];

/** 便于自测/内核校验：清单 id 列表 */
export const MANIFEST_IDS = manifest.map((app) => app.id);

/** 便于内核校验：按 id 找清单项 */
export function findApp(appId) {
  for (const app of manifest) {
    if (app && app.id === appId) return app;
  }
  return null;
}

export default manifest;
