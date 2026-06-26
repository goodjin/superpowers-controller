# Check Failure Retry And Main Progress

## 背景

检查环节失败时，runtime 已经有回派 implementer 的 transition，但 state store 在追加 retry node run 时不会把 workflow 从 `failed` 恢复成 `running`。结果是 workflow 已经派发了修复会话，界面仍可能显示失败态，看起来像卡在 acceptance、verification 或 code review。

TUI 常驻进度也缺少主会话区域入口。workflow 会话运行信息应展示在 `sidebar_content`，不放在 prompt/right 区域。`home_prompt` / `home_prompt_right` 属于首页区域，也不能用来解决主会话区域展示。

## 目标

- 任意检查环节 `failed` 后，transition 复用对应 task 的 implementer session 或创建新的 implementer session。
- retry node run 写入后，workflow 状态恢复为 `running`，`current_phase` 更新为 retry phase。
- retry prompt 包含失败检查的 summary / findings，方便 implementer 修复。
- `sidebar_content` 展示当前 workflow 会话运行信息。
- `session_prompt_right` 不注册 Superpowers resident progress。
- `home_prompt` 和 `home_prompt_right` 不注册 Superpowers resident progress。
- `sidebar_content` 继续支持无 session props 的全局读取。

## 非目标

- 不在这次改动里重构独立 task/check state。
- 不改变 public tool surface。
- 不把 progress 注入模型上下文；它仍然是 TUI side-channel。

## 验收

- Acceptance failed 后，runtime 派发 `reuse_session` 到同一 task 的 implementer。
- Retry node run 创建后，workflow status 为 `running`。
- Retry prompt 包含失败检查上下文。
- TUI slot 列表包含 `sidebar_content`，不包含 `session_prompt_right`、`home_prompt` 和 `home_prompt_right`。
- `sidebar_content` 能显示当前 running node，例如 `sp-implementer T1: running - ...`。
