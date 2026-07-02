# Feature: V5 Controller Runtime Implementation

## Background

v5 PRD 已确认新的控制模型：`super-agent` 负责理解需求和选择工具协议，插件不再把固定 workflow 当作唯一决策入口；插件负责持久化准备文档、校验启动配置、创建/恢复 node session、处理 `sp_report` 和把异常状态反馈给 controller。

当前代码已经有 v4 的 prepare/start/report/recovery 基础，也有一部分 controller decision 能力，但还缺少 v5 的完整协议面和运行时持久化：

- `super-agent` prompt 没有每个新会话首轮固定欢迎语。
- `sp_status` 没有返回 agent catalog、workflow schema、built-in workflow templates 和 workflow examples。
- `sp_prepare` 还以 v4 `prepare_mode` 为主，缺少 task brief、designer participation、confirmation summary 和 `documents.json`。
- `sp_start` 缺少 `prepared_task_id`、`start_config`、built-in workflow id、自定义 orchestration 和 `workflow-spec.json`。
- `sp_report` 缺少 workflow expansion 输入和 no-report fallback 的持久化证据。
- 文档仍描述 v5 是 design target，模块文档没有和本轮实现对齐。

## Goals

1. 整理 v5 PRD，使其反映本轮要实现的协议和边界。
2. 保持五个 public tools 不变：`sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
3. 扩展工具参数和返回值，兼容现有 v4 调用。
4. 增加 run-local `documents.json` 和 `workflow-spec.json`。
5. 增加内置 workflow templates：`feature`、`bugfix`、`review`、`verify-finish`、`design-only`、`plan-only`、`review-only`、`parallel-investigate`、`single-agent`。
6. 支持 controller decision 的完整 v5 动作：retry、continue、accept partial、mark blocked、request reprepare、apply workflow patch、replace orchestration。
7. 支持 `sp_report.workflow_expansion`，在 auto expansion policy 允许时自动扩展 task graph 或 workflow spec；不允许时交给 controller 决策。
8. 重启恢复时为 interrupted running node 写入 fallback summary，避免 controller 只看到模糊的 recovered state。
9. 补齐单元测试，覆盖 v5 协议、文档持久化、工作流模板、首轮欢迎语和异常路径。

## Non-Goals

- 不新增 public tool。
- 不让插件根据用户自然语言智能推荐 workflow；插件只返回能力目录和校验结果。
- 不镜像 child session 的完整 timeline 到主会话；继续使用 OpenCode 原生 child session 展示。
- 不重写 TUI，只确保状态和持久化数据能被现有 status/progress 层读取。

## Design

### Controller Prompt

`super-agent` prompt 增加硬性规则：每个新的 `super-agent` 会话第一条 assistant 回复必须以固定句子开头：

```text
欢迎使用superpowers主控插件，我将按superpowers工作流程完成您的任务。
```

同时补充 Superpowers 常用工作流示例、工具使用顺序、prepare/start/report 的边界和异常裁决原则。

### Capabilities

新增一个可复用 capability 模块，统一提供：

- agent catalog
- workflow schema
- built-in workflow templates
- common workflow examples

`sp_status(include_capabilities=true)` 返回这些能力；prompt 和测试也复用同一份定义，避免文档、提示词和工具返回分叉。

### Prepare

`sp_prepare` 支持 v5 输入：

- `task_brief`: goal、scope、constraints、acceptance_criteria、known_context、risks、controller_notes；其中 constraints、acceptance_criteria、known_context、risks 是给后续模型读取的 prose string。
- `design_participation`: `none | brainstorm | design`，用于决定 prepare 阶段是否派发 designer。
- `confirmation`: 是否需要用户确认、确认原因和确认问题。

兼容旧参数 `task/request/kind/workflow/entrypoint/prepare_mode/proposal`。

输出增加：

- `prepared_task_id`
- `confirmation_summary`
- `required_user_confirmations`
- `artifact_paths`
- `warnings`
- `documents`

### Start

`sp_start` 支持 v5 输入：

- `action="start_prepared_task"`，兼容 `start_action="start_entrypoint"`。
- `prepared_task_id`，兼容 `run_id`。
- `start_config.kind="built_in_workflow"`，用 workflow template id 启动。
- `start_config.kind="orchestration"`，用自定义节点、边和 policy 启动。
- `auto_expansion.allow` 显式覆盖 template 默认值。

启动时写入 `workflow-spec.json`，并根据 workflow spec 派发首个节点。

### Report And Expansion

`sp_report` 增加 `workflow_expansion`：

- `tasks`: 追加或替换 task graph 中的任务。
- `nodes`: 给 workflow spec 追加后续节点。
- `documents`: 声明新增或更新的 run-local artifact。
- `reason`: 说明扩展原因。

如果 `workflow_spec.auto_expansion.allow === false`，runtime 不自动应用 expansion，而是将 workflow 置为等待 controller 决策，并在 `controller_feedback` 中暴露 `apply_workflow_patch` 或 `replace_orchestration`。

### Documents

每个 run 根目录维护 `documents.json`，记录插件管理的 run-local 文档：

- `request.md`
- `task.md`
- `proposal.md`
- `spec.md`
- `plan.md`
- `task_graph.json`
- `tasks.json`
- `workflow-spec.json`
- node task/report/fallback summary

`documents.json` 是恢复和子会话 task packet 的索引，不是项目交付文档。

### Recovery

启动恢复发现 running node 不可信时：

- 标记 node 为 `interrupted`。
- 写入 `nodes/<node-id>/fallback-summary.json`。
- 更新 `documents.json`。
- `sp_status` 和 `allowed_controller_decisions` 暴露 retry、continue、accept partial、mark blocked、request reprepare 等裁决选项。

## Test Plan

- `sp_status(include_capabilities=true)` 返回 capability catalog。
- `sp_prepare(task_brief, design_participation)` 写入 `documents.json` 并按设计参与模式派发或不派发 designer。
- `sp_start(prepared_task_id, action, start_config)` 写入 `workflow-spec.json` 并启动对应节点。
- `sp_report(workflow_expansion)` 在允许时写入 task graph / workflow spec，在不允许时进入 controller decision。
- startup recovery 写入 fallback summary。
- `super-agent` prompt 包含固定首轮欢迎语和 v5 工具协议。
- 全量 `bun run test`、`bun run build`、`npm pack --dry-run` 通过。
