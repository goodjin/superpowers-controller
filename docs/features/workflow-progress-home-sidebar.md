# Workflow Progress In Session And Sidebar

## 背景

当前 workflow 是否进行中由 runtime state 判断：`intake`、`running`、`waiting_user`、`blocked`、`failed`、`recovered_unknown` 都属于未完成状态，`passed` 和 `canceled` 属于结束状态。`sp_status` 已按这个规则返回当前 workflow 或未完成历史。

问题出在 TUI 常驻进度面：`sidebar_content` 之前只在 slot 带 session props 时显示，部分全局 sidebar 场景会返回空。workflow 会话运行信息需要集中放在 `sidebar_content`，避免散落到 prompt/right 或首页 slot。

## 目标

- `sidebar_content` 在没有 session props 的首页/全局场景也展示当前 workflow 进度。
- `sidebar_content` 展示 workflow 总览、运行中节点和最近 activity，作为会话运行信息主承载。
- `session_prompt_right` 不注册 Superpowers progress；prompt/right 区域不承载 workflow 运行信息。
- `home_prompt` 和 `home_prompt_right` 不注册 Superpowers progress；它们属于首页区域。
- sidebar 文本包含 workflow 总览、运行中节点，以及没有节点时的明确提示。
- 保持详细进度仍在 `superpowers-progress` route 中查看。

## 实现

- 为 slot options 增加 `allowGlobal`，允许 `sidebar_content` 在没有 session props 时读取 current workflow。
- 新增 sidebar renderer：先展示 `SP: <workflow> <status>@<phase>`，再展示运行中的 node session；如果没有运行节点，则展示最近节点或等待派发提示。
- prompt/right 和 home slots 不注册 workflow progress。

## 验证

- 单元测试覆盖：
  - `sidebar_content` 无 session props 时仍显示 workflow 和运行节点。
  - `session_prompt_right` 不注册。
  - `home_prompt` / `home_prompt_right` 不注册。
  - 无 node run 的 running workflow 显示等待节点派发提示。
- 保持现有 progress route、question route 和 compact fallback 行为。
