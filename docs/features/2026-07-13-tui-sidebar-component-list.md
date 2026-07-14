# Feature: TUI Sidebar 组件化列表渲染

## 背景

Superpowers `sidebar_content` 原先使用单个 OpenTUI `<text>` 节点拼接多行字符串。OpenCode 原生 TodoWrite sidebar（`internal:sidebar-todo`）则用 SolidJS + `<For>` 逐行渲染，每行独立 `<box>` + `<text>` 节点，数据来自 `api.state.session.todo()` 响应式 API。

用户反馈重启后 sidebar 往往只显示会话标题，动作行和 workflow 列表不稳定。根因是对比官方实现后的渲染模式差异，而非数据源本身。

## 目标

1. 将 `sidebar_content` 改为与 OpenCode TodoWrite 同类的 **JSX 组件树 + `<For>` 列表** 渲染。
2. 保留现有 workflow / host session 数据逻辑，仅替换展示层。
3. 导出结构化 `SidebarViewModel`，测试与文本 fallback 仍可断言内容。
4. 在 README 记录 TUI sidebar 实现经验，供后续插件开发参考。

## 方案

### 数据层

- 新增 `src/tui/sidebar-model.ts`：从现有 `composeSidebarContentText` 逻辑抽出 `SidebarViewModel`。
- 同步构建 `buildSidebarViewModel()`，异步刷新 `loadSidebarViewModel()`（保留 250ms defer + event 订阅）。
- `renderSidebarViewModelText()` 将 model 转回多行字符串，供单测复用。

### 展示层

- 新增 `src/tui/sidebar-view.tsx`：
  - `SidebarView` 根组件：`flexDirection="column"` 容器。
  - workflow 区块：`<For each={workflowLines}>` 每行一个 `<text>`。
  - host 区块按 mode 分支：
    - `single-focus`：标题行 + 动作行 + 可选 detail 行（各独立 `<text>`）。
    - `workflow-list` / `overview`：标题 + summary + `<For each={rows}>` 的 `SessionListRow`。
  - `SessionListRow`：`<box flexDirection="row">` + marker/status/title 分色（对齐 TodoItem 模式）。
- slot 注册增加 `order: 600`，排在内置 todo(400) 与 files(500) 之后。

### 接入

- `createSidebarProgressSlot` 返回 `<SidebarView api session_id allowGlobal refreshMs />`。
- 测试注入自定义 `renderText` 时仍走文本路径（`refreshMs: 0` 单测兼容）。

## 验收

- [x] sidebar 单会话 focus、workflow 列表、route fallback 等现有单测通过。
- [x] `bun run build` 成功（含 `.tsx` 编译）。
- [x] `bun run install:local` 通过。
- [x] README 新增「TUI Sidebar 实现说明」章节。

## 参考

- OpenCode `packages/tui/src/feature-plugins/sidebar/todo.tsx`
- OpenCode `packages/tui/src/component/todo-item.tsx`
- OpenCode `packages/opencode/specs/tui-plugins.md`
