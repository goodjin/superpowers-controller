# Feature: 档 B — Live Activity 条

## 背景

原生 Task 卡片嵌在 parent transcript 里，用户扫一眼就知道子会话在跑什么。Superpowers 禁止 agent 调 `task`，档 A（plugin 代注册 task part）仍需 upstream API 调研。档 B 在 **transcript 下方** 用 `app_bottom` + `sidebar_content` 补齐同等可见性。

## 目标

1. 从 TUI `api.state.session.messages` 实时读取 child 最新 tool 活动，格式对齐原生卡片 `↳ Tool title`。
2. live 摘要优先于 `progress.jsonl` 陈旧记录（child 仍在 running 时）。
3. `app_bottom` / `sidebar_content` 订阅 `api.event.on("message.part.updated" | "session.status")`，事件触发即刷新，1s 轮询作兜底。
4. 多 running child 时，每行独立显示 live activity；`waiting_permission` 状态保持高优先级。

## 非目标

- 不向 parent transcript 写入 task part（档 A）。
- 不恢复 `parentID` 或修改 dispatch 后自动切 child（native interaction，另案）。
- 不做行点击导航（仍用 `⌘1-9` / `Ctrl+Down`）。

## 验收

- running child 行显示 `↳ Edit foo.ts` 或 `↳ N toolcalls`（与原生 Task 组件语义一致）。
- TUI 有 `api.event.on` 时，child tool 更新后 200ms 内 app_bottom 反映新摘要（单测用 mock event）。
- 无 event API 时，1s 轮询仍工作（现有行为保留）。
- 207+ 单元测试全绿，build 通过。
