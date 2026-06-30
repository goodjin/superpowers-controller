# Bug Fix: TUI Progress Hidden By Session Filter

## 问题描述

- 日期: 2026-06-30
- 严重程度: High
- 影响范围: TUI resident progress slots `app_bottom`、`sidebar_content`、`sidebar_footer`

用户反馈：修复首页底部展示后，TUI 变成什么进度都不展示。

## 根因分析

运行时数据仍然存在：

- `current.json` 指向 `fff39908-e534-4e3f-b028-b9067e9e4ef4`
- 对应 `state.json` 状态为 `recovered_unknown`
- run 目录下仍有大量 `nodes/*/progress.jsonl`

问题不是 progress 采集丢失，而是 TUI 过滤逻辑过严：

1. `app_bottom` 被改为 `allowGlobal=false`，host 没传 `session_id` 时直接不渲染。
2. `sidebar_content` 虽然 `allowGlobal=true`，但只有当 slot 参数里能读到 `agent === "super-agent"` 时，才允许 fallback 到 latest unfinished workflow。
3. 实际 host slot 很可能只传当前 `session_id`，不传 agent。新开的主控会话 id 又不等于旧 workflow 的 `parent_session_id`，因此 `progressModel()` 把 latest workflow 过滤成 inactive model。

结果：三个常驻 surface 同时空白。

## 修复方案

- `app_bottom` 保持不在首页展示，但不能依赖 host 一定传 session props；改为通过 slot context 判断是否在 home surface。
- `sidebar_content` 和 `sidebar_footer` 在 `allowGlobal=true` 时允许 latest unfinished workflow fallback，不再依赖 `agent` 字段。
- 普通无关 session 的风险通过 slot 位置控制：只有已注册的 sidebar/bottom resident surfaces 使用 fallback；compact/session-specific path 仍按 session 绑定。
- 增加回归测试：有 `session_id` 但没有 agent、且 session 不属于 workflow 时，`sidebar_content` 仍能显示 latest unfinished workflow。

## 验证步骤

1. 运行 TUI 聚焦测试，确认 no-agent session fallback 生效。
2. 运行全量测试。
3. 运行构建和部署脚本。
