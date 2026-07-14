# Bug Fix: TUI plugin silent load failure (jsxDEV)

## 问题描述
- 日期: 2026-07-14
- 严重程度: High
- 影响范围: OpenCode TUI sidebar（`sidebar_content` / `app_bottom` / `session_prompt`）

用户重启后只有会话标题，看不到工具调用等 sidebar 内容；开启调试后也始终没有 `sidebar-debug.log`。

## 根因分析
- 运行中的 OpenCode（pid / cwd=`/Users/jin/vpn`）会加载 `~/.config/opencode/tui.jsonc` 中的 `superpowers-controller/tui`，但插件的 `tui()` 从未执行。
- 本地复现：

```text
import("superpowers-controller/tui")
→ SyntaxError: Export named 'jsxDEV' not found in module
  .../@opentui/solid/jsx-runtime.d.ts
```

- `bun build src/tui.ts` 把 `src/tui/sidebar-view.tsx` 编成了对 `@opentui/solid/jsx-dev-runtime` 的 `jsxDEV` 调用。
- `@opentui/solid` 的 `jsx-dev-runtime` / `jsx-runtime` export 只指向 `.d.ts`（类型），没有运行时 JS；模块顶层 import 失败后，整包插件退出，任何启动日志都写不出。

## 修复方案
- 从 `src/tui.ts` 去掉对 `sidebar-view.tsx` 的静态导入。
- `sidebar_content` 固定走 `createTextElement` + `renderSidebarViewModelText` 文本路径。
- 启动时继续无条件写 `appendSidebarStartup` 心跳，方便确认插件已挂载。
- JSX 组件模式暂不进入默认构建链路；若恢复需用 `@opentui/solid/bun-plugin` 编译，不能依赖 bun 默认 `jsxDEV`。

## 验证步骤
1. `bun run build`
2. `cd ~/.cache/opencode/packages && bun -e 'import("superpowers-controller/tui").then(m=>console.log(typeof m.default.tui))'` 应输出 `function`
3. `bun run install:local`
4. 完全退出并重启 `opencode --agent superpowers-agent`
5. 确认存在 `/Users/jin/vpn/.opencode/superpowers/sidebar-debug.log`，且含 `startup` 行；sidebar 能显示会话动作/工具信息。

## 相关测试
- `test/tui-plugin.test.ts`
- `test/sidebar-model.test.ts`
- `test/live-activity.test.ts`
