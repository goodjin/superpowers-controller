# Bug Fix: TUI 插件条目被当成 GitHub 仓库导致永远无 sidebar 日志

## 问题描述

- 日期: 2026-07-14
- 严重程度: High
- 影响范围: OpenCode TUI sidebar（`tui()` 从未执行，诊断日志无法写出）

用户重启 OpenCode 后仍看不到侧栏动态内容，且 `.opencode/superpowers/sidebar-debug.log` 不存在。

## 根因分析

- 问题位置: `~/.config/opencode/tui.jsonc` 的 `"plugin": ["superpowers-controller/tui"]`；安装器 `TUI_PACKAGE_ENTRY`
- 原因: OpenCode（实测 1.17.20）把形如 `owner/name` 的两段字符串解析为 GitHub shorthand，去执行：

  `git ls-remote https://github.com/superpowers-controller/tui.git`

  该仓库不存在/不可达时，界面会长时间停在「Loading plugins...」，TUI 插件模块不会加载，因此我们在 `tui()` 里写的 startup 心跳永远不会出现。
- 代码流程:
  1. `tui.jsonc` 读取 `plugin` 列表
  2. 宿主按 git/GitHub shorthand 解析 `superpowers-controller/tui`
  3. 卡在依赖安装/远程拉取
  4. `tui()` 未调用 → 无 sidebar、无诊断日志

正确写法是 npm 包名 `superpowers-controller`。官方 `opencode plugin <module>` 在检测到 `exports["./tui"]` 后，写入 tui 配置的同样是包名 `Q`，由宿主按 kind=`tui` 去加载 `./tui` export。

此前修复的 jsxDEV 导入崩溃是另一层问题；修好 dist 后仍无日志，就是被本问题挡住了。

## 修复方案

- 修改文件:
  - `src/cli/install.ts`：`TUI_PACKAGE_ENTRY` 改为包名；安装时剔除 legacy `superpowers-controller/tui`
  - `scripts/install.sh`：同上
  - `test/install.test.ts`：期望值与迁移用例
  - 用户侧 `~/.config/opencode/tui.jsonc`：改为 `"superpowers-controller"`
- 修改内容: 停止把 `/tui` 写进 tui 配置；旧配置自动迁移

## 验证步骤

1. `cat ~/.config/opencode/tui.jsonc` 应为 `"plugin": ["superpowers-controller"]`，且无 `/tui`
2. 完全退出 OpenCode 后从 `/Users/jin/vpn` 再启动
3. 进程子命令中不应再出现 `git ls-remote .../superpowers-controller/tui.git`
4. 应出现 `/Users/jin/vpn/.opencode/superpowers/sidebar-debug.log`（或全局 fallback 日志）含 `tui_plugin_startup`

## 相关文档

- `docs/bugfix/2026-07-14-tui-plugin-jsxdev-load-failure.md`（上一层：dist 含 jsxDEV 导致 import 失败）
- `docs/modules/deployment.md`
