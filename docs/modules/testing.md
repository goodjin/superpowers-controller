# Testing Module

## Responsibility

测试模块负责验证插件的纯函数逻辑、安装行为，以及 OpenCode 1.16.2 下的真实运行路径。新增的 LLM mock 服务用于把模型输出变成可预设、可断言的测试输入。

## Files

- `test/support/llm-mock/server.ts`：OpenAI-compatible mock LLM 服务和控制 API。
- `test/support/llm-mock.test.ts`：request_id 解析、expectation 消费、409 错误和 SSE 响应测试。
- `test/support/opencode-e2e/harness.ts`：真实 OpenCode e2e 的隔离环境、临时配置、mock LLM、child process 和 workflow state 读取工具。
- `test/support/opencode-e2e/logging.ts`：e2e 场景日志 helper，统一输出 suite goal、scenario description、step、verification 和 summary。
- `test/support/opencode-e2e/harness.test.ts`：harness smoke，以及 `node_runs` / `nodes/*` 读取能力验证。
- `test/controller-intake.test.ts`：proposal 生成、resume proposal、`sp_prepare` 创建 prepared run、v5 `task_brief/design_participation/confirmation`、source workflow 导入、`sp_start` 激活 prepared run 或直接创建 run、`sp_start(prepared_task_id, action=start_prepared_task, start_config)` 写入 workflow spec、`sp_start(run_id, resume_input)` 恢复 waiting-user child session 且不等待 child prompt 完成，以及 `entrypoint=execute` 的实现入口派发。
- `test/dispatch-transition.test.ts`：intake、plan、task-scoped implementation acceptance、串行 review、code-review 后回到 task graph、retry 和 needs_user 的 dispatch decision。
- `test/session-orchestrator.test.ts`：node task markdown 模板、session create/reuse adapter 调用。
- `test/store-node-runs.test.ts`：`node_runs` 创建、`nodes/*/task.md`、`nodes/*/record.json` 和完成状态更新。
- `test/sp-record-dispatch.test.ts`：legacy record handler 覆盖，验证 `sp_report(plan)` 语义后 dispatch implementer、`workflow_expansion` 在允许时自动扩展/派发、不允许时进入 `waiting_controller_decision`，implementation report 后派发带 task/report 上下文的 acceptance、并行 implementation report 按 child session 归属节点、检查失败后回派 implementer 并恢复 workflow running，并在 `needs_user` 时不派发且通知 parent controller session。
- `test/node-progress.test.ts`：child session 事件到节点 progress JSONL 的映射、忽略无关 session、错误摘要。
- `test/progress-panel.test.ts`：TUI progress panel view-model 和文本渲染。
- `test/plugin-progress-event.test.ts`：server plugin `event` hook 写入 child progress。
- `test/tui-plugin.test.ts`：TUI route、命令入口、resident progress slot 注册、`sidebar_content` workflow 会话运行信息渲染、home/prompt-right slot 不注册，以及无 session props 的 sidebar progress 渲染。
- `test/package-entrypoints.test.ts`：package build/export 包含 `./tui` 入口。
- `test/e2e/opencode-workflow.test.ts`：workflow e2e，覆盖 proposal/start、prepare-review-start、debug root cause、strict debug gate、完整 feature lifecycle、`sp_report` 校验恢复、completion verification、active waiting reroute 和 strict execute gate 顺序。
- `scripts/e2e-opencode-mock-llm.ts`：用临时 OpenCode 配置启动真实 `opencode run`，通过 mock provider 验证 request_id 匹配。
- `scripts/e2e-opencode-1.16.2.ts`：原有插件加载 smoke，验证 9 个动态注入 agents。

## Progress Prompt Tests

workflow progress 是 side-channel 行为，用单元测试验证，不要求 e2e 解析 OpenCode TUI toast：

- `test/tools.test.ts` 断言 public tool registry 只暴露 `sp_status`、`sp_prepare`、`sp_start`、`sp_cancel`、`sp_report`。
- `test/tools.test.ts` 断言 `sp_status(include_capabilities=true)` 返回 v5 agent catalog、workflow schema、built-in workflow templates 和 examples。
- `test/tools.test.ts` 断言 `sp_status(include_progress=true)` 返回面向主会话灰色工具结果的 `progress_digest`，包含当前 child activity、最近 progress 和按需展示策略。
- `test/agents.test.ts` 断言 `super-agent` 在用户询问进展时应调用 `sp_status` 并使用 `include_progress`，而不是向主会话注入高频进度叙述。
- `test/agents.test.ts` 断言每个新 `super-agent` 会话第一轮固定欢迎语和 v5 prepare/start/controller-decision prompt 协议存在。
- `test/controller-intake.test.ts` 断言 `sp_prepare` / `sp_start` 发送 `run_started`。
- `test/session-orchestrator.test.ts` 断言 `dispatch()`、`resumeNode()` 和 `notifyParent()` 在底层 `continueNodeSession()` 不 resolve 时仍会返回。
- `test/sp-record-dispatch.test.ts` 断言 `sp_report` 在后续 child prompt 不 resolve 时仍会返回，并且 dispatch 前已登记 `node_runs`。
- `test/session-orchestrator.test.ts` 断言 dispatch 先发送 `dispatch_started`，成功创建 session 后发送 `node_running`。
- `test/sp-record-dispatch.test.ts` 断言节点记录后发送 `node_recorded`，`needs_user` 决策额外发送 `waiting_user_input` 并调用 parent notification。

## Control-Plane Regression Expectations

控制面测试需要覆盖 public loop 的状态语义，而不只覆盖 happy path：

- 新 run 启动和已有 run 恢复应分别覆盖；已有 active run 的恢复应从 durable state 计算下一步。
- `sp_start(run_id)` 激活 prepared run 时，如果已有 `task_graph` 且 phase 为 plan 完成态，应派发 runnable implementer；如果所有 graph task 已完成检查，应进入 finish/recovery，而不是重新派 designer/planner。
- `sp_report(status: "progress")` 只更新记录和 progress，不触发 downstream dispatch。
- `sp_report(workflow_expansion)` 在 auto expansion policy 允许时应用任务/节点扩展；不允许时进入 `waiting_controller_decision` 并返回可执行 controller decision。
- 并行 running node 的 `sp_report` 必须按 child session 归属到正确 node，不能用最后一个 running node 兜底猜测。
- `needs_user` 必须写入 `pending_question`、停止派发，并向 `parent_session_id` 投递 controller prompt。
- `sp_start(run_id, resume_input)` 必须校验 `source_node_id`、清空 `pending_question`，并恢复原 waiting child session；普通 `sp_start(run_id)` 不能绕过等待用户输入。
- 检查失败应优先复用对应 task 的 implementer session；无法复用时才创建新的 implementer。
- `sp_cancel(session_id)` 后恢复时应读取 canceled/blocked node run，不应把整个 workflow 当成全新 run。
- finish node 空跑、blocked 或 canceled 后，恢复测试应断言 runtime 重新派发 finish 或进入明确 blocked recovery。

这些用例优先放在 `test/dispatch-transition.test.ts`、`test/controller-intake.test.ts` 和 `test/sp-record-dispatch.test.ts`。需要真实 OpenCode session 顺序时，再提升到 `test/e2e/opencode-workflow.test.ts`。

child session live progress 走事件归档，不靠 toast 断言：

- `test/node-progress.test.ts` 覆盖 `message.part.updated`、`session.status`、`session.error` 等事件的归档形状。
- `test/plugin-progress-event.test.ts` 覆盖 server hook 只处理 active workflow 中已登记的 child session。
- `test/tui-plugin.test.ts` 覆盖 `superpowers-progress` route、`superpowers.progress` 命令入口、`superpowers-questions` 不注册、resident progress slot 名单、`sidebar_content` 作为 workflow 会话运行信息主展示区域、`session_prompt_right` / `home_prompt` / `home_prompt_right` 不注册、`app_bottom` no-props 不渲染、`sidebar_content` no-props 全局进度/主会话运行列表、`super-agent` 新主控会话 fallback，以及 parent/child/no-props/unrelated session 下的 compact progress 行。

## Mock LLM Contract

测试 prompt 使用 marker 绑定请求：

```text
[llm_request_id:<id>]
```

mock 服务按顺序读取：

1. `metadata.request_id`
2. `x-request-id`
3. messages 里的 `[llm_request_id:<id>]`

当前 e2e 主要使用第 3 种，因为 OpenCode 一定会把 prompt 内容发送给 provider。

## Control API

- `POST /__mock/reset`
- `POST /__mock/expectations`
- `GET /__mock/requests`
- `GET /__mock/pending`

`POST /__mock/expectations` 注册的每个 expectation 用 `request_id` 匹配。命中后立即消费。没有 request_id、未注册 request_id、重复请求都会让 `/v1/chat/completions` 返回 `409`。

## OpenCode Provider Setup

mock e2e 写入临时 `opencode.jsonc`，使用 custom OpenAI-compatible provider：

```json
{
  "provider": {
    "llm-mock": {
      "npm": "@ai-sdk/openai-compatible",
      "options": {
        "baseURL": "http://127.0.0.1:<port>/v1",
        "apiKey": "mock-api-key"
      },
      "models": {
        "test-model": {
          "name": "Test Model"
        }
      }
    }
  }
}
```

脚本使用临时 `HOME`、`XDG_CONFIG_HOME` 和临时项目目录，避免写入真实 OpenCode 配置或当前仓库的 workflow state。

## OpenCode E2E Harness

`createOpencodeE2EHarness()` 提供：

- `mock.expect(...)` 注册模型响应。
- `mock.requests()` 读取 OpenCode 发给 provider 的真实请求体。
- `mock.pending()` 检查未消费 expectation。
- `runOpencode(...)` 用异步 child process 执行 `opencode run`。
- `readWorkflowState()` 读取临时项目下的 `.opencode/superpowers/current.json` 和对应 run state。
- `readLastWorkflowState()` 在 reset 清除 active pointer 后读取最近的历史 run。
- `readArtifact(name)` 读取 run artifact。
- `readLastArtifact(name)` 在 reset 后读取最近历史 run 的 artifact。
- `listNodeIDs(runID?)` 读取当前或指定 run 的节点列表。
- `readNodeTask(nodeID, runID?)` 读取 `nodes/<node-id>/task.md`。
- `readNodeRecord(nodeID, runID?)` 读取 `nodes/<node-id>/record.json`。

workflow 配置写入临时项目的 `.opencode/superpowers.jsonc`。例如 strict debug gate：

```ts
await createOpencodeE2EHarness({
  workflowConfig: {
    debug_gate: "strict",
  },
})
```

真实 OpenCode 在 tool error 后通常会继续请求模型。因此测试 gate 阻断时，需要为同一个 request_id 再注册一个文本响应，让回合自然结束；然后从下一次 provider 请求体里断言 tool error 已经返回给模型。

默认情况下，e2e harness 设置 `OPENCODE_SUPERPOWERS_DISABLE_CHILD_PROMPT=1`。这样真实插件仍会通过 SDK 创建 node session，并写入 `node_runs` 与 `nodes/*/task.md`，但不会在 e2e 中启动 child session 模型回合，避免 mock LLM 因缺少 child request marker 而卡住。session prompt 的调用契约由 `test/session-orchestrator.test.ts` 用 mock adapter 覆盖。

当测试需要验证完整节点链路时，可以显式打开 child prompt：

```ts
await createOpencodeE2EHarness({
  enableChildPrompts: true,
})
```

这时 harness 会关闭 `OPENCODE_SUPERPOWERS_DISABLE_CHILD_PROMPT`，并打开 `OPENCODE_SUPERPOWERS_E2E_CHILD_REQUEST_MARKERS=1`，让每个子节点 prompt 带稳定的 `[llm_request_id:node-...]` marker，便于逐节点断言请求顺序和返回内容。

## Workflow E2E Coverage

`bun run test:e2e:opencode` 当前覆盖这些场景：

- harness smoke：验证真实 `opencode run` 能消费 mock LLM response。
- debug happy path：workflow 创建后通过 `sp_report` 写入 root cause。
- debug repair full chain：debugger 记录根因后，runtime 派发 implementer、acceptance、verification、code review 和 finisher，最终进入 `passed`。
- strict debug gate：缺少 `root_cause_found` 时阻断修复写入。
- feature lifecycle：一条父会话长链路覆盖 proposal、start、design、plan、implementation、acceptance、verification、code review、finish 和历史 run 保留。
- plan-only full chain：planner 写入计划和 task graph 后 workflow 直接通过，不启动 implementer。
- review full chain：独立 review workflow 依次执行 acceptance、verification、code review 和 finish。
- parallel-investigate full chain：investigator 写入调查报告后由 finisher 汇总，非编程流程不要求 `verification_fresh`。
- record validation recovery：缺 artifact 的 gate 更新失败，随后附带 artifact 恢复。
- completion verification gate：fresh verification 前拒绝 `done`，验证后接受。
- active waiting reroute：等待态 workflow 保持当前 mode，不被新意图覆盖。
- execute gate order：strict execute 下依次验证 plan gate 和 red-test gate。
- prepare-review-start chain：先由 `sp_prepare` 创建 prepared run，用户确认后 `sp_start` 从 durable state 恢复，进入 task-scoped implement -> acceptance -> verification -> code review -> finish 的完整节点链路，并断言检查节点 request_id 携带 task id。

## E2E Logging Contract

OpenCode e2e 用 `createE2ELogger()` 包裹每个场景。日志按固定顺序输出：

1. suite 名称和目标。
2. scenario 名称和描述。
3. 每个环节的 `步骤`，说明当前准备做什么，以及这一环节要测试什么。
4. mock-server 交互记录，逐次用格式化 JSON 打印请求摘要和实际返回摘要。请求摘要包含 `request_id`、model、stream、消息数量、最近消息和可用工具；返回摘要包含状态码、stream、文本或 tool call 名称及参数。
5. 响应后的处理流程快照，用格式化 JSON 打印 workflow state 的 mode、phase、已打开 gates、artifacts、history，以及关键 artifact 的存在状态、大小和内容预览。
6. 每组断言通过后的 `验证 ... 通过`，说明刚验证完的结果。
7. 单个 `场景结果`，包含通过/失败、步骤数、验证数和耗时。
8. `总结`，汇总场景数量、通过/失败数量、总步骤数和总验证数。

如果某个断言失败，logger 会输出当前场景的失败总结和错误信息，然后继续把原始错误抛给 Bun test。

## Notes

- mock server 和 `opencode run` 不能放在同一个同步阻塞流程里运行。e2e 脚本使用异步 child process，保证 Bun server 可以响应 provider 请求。
- OpenCode 会以 streaming 模式调用 provider。mock 服务返回 OpenAI Chat Completions SSE，并在 `[DONE]` 前发送 usage chunk，兼容 `stream_options.include_usage`。
- 同一个 user turn 的多次 provider 请求会携带同一个 prompt marker。mock expectation 支持同一 `request_id` FIFO 消费，用来覆盖 tool call 后的连续 LLM 请求。
- 第一版覆盖 text 和 tool call 响应。复杂场景可以继续扩展 status、delay、malformed tool args、429/500 和多请求序列。
