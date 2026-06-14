# Testing Module

## Responsibility

测试模块负责验证插件的纯函数逻辑、安装行为，以及 OpenCode 1.16.2 下的真实运行路径。新增的 LLM mock 服务用于把模型输出变成可预设、可断言的测试输入。

## Files

- `test/support/llm-mock/server.ts`：OpenAI-compatible mock LLM 服务和控制 API。
- `test/support/llm-mock.test.ts`：request_id 解析、expectation 消费、409 错误和 SSE 响应测试。
- `test/support/opencode-e2e/harness.ts`：真实 OpenCode e2e 的隔离环境、临时配置、mock LLM、child process 和 workflow state 读取工具。
- `test/support/opencode-e2e/logging.ts`：e2e 场景日志 helper，统一输出 suite goal、scenario description、step、verification 和 summary。
- `test/support/opencode-e2e/harness.test.ts`：harness smoke，验证真实 `opencode run` 能通过 mock provider 消费 request_id expectation。
- `test/controller-intake.test.ts`：proposal 生成、resume proposal、`sp_route` 不创建 run、`sp_start` 创建 run 并写入 request/proposal/changelog。
- `test/dispatch-transition.test.ts`：intake、plan、implementation、串行 review、retry 和 needs_user 的 dispatch decision。
- `test/session-orchestrator.test.ts`：node task markdown 模板、session create/reuse adapter 调用。
- `test/store-node-runs.test.ts`：`node_runs` 创建、`nodes/*/task.md`、`nodes/*/record.json` 和完成状态更新。
- `test/sp-record-dispatch.test.ts`：`sp_record(plan)` 后 dispatch implementer，并在 `needs_user` 时不派发。
- `test/e2e/opencode-workflow.test.ts`：workflow e2e，覆盖 proposal/start、debug root cause、strict debug gate、完整 feature lifecycle、`sp_record` 校验恢复、completion verification、active waiting reroute 和 strict execute gate 顺序。
- `scripts/e2e-opencode-mock-llm.ts`：用临时 OpenCode 配置启动真实 `opencode run`，通过 mock provider 验证 request_id 匹配。
- `scripts/e2e-opencode-1.16.2.ts`：原有插件加载 smoke，验证 9 个动态注入 agents。

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

workflow 配置写入临时项目的 `.opencode/superpowers.jsonc`。例如 strict debug gate：

```ts
await createOpencodeE2EHarness({
  workflowConfig: {
    debug_gate: "strict",
  },
})
```

真实 OpenCode 在 tool error 后通常会继续请求模型。因此测试 gate 阻断时，需要为同一个 request_id 再注册一个文本响应，让回合自然结束；然后从下一次 provider 请求体里断言 tool error 已经返回给模型。

e2e harness 设置 `OPENCODE_SUPERPOWERS_DISABLE_CHILD_PROMPT=1`。这样真实插件仍会通过 SDK 创建 node session，并写入 `node_runs` 与 `nodes/*/task.md`，但不会在 e2e 中启动 child session 模型回合，避免 mock LLM 因缺少 child request marker 而卡住。session prompt 的调用契约由 `test/session-orchestrator.test.ts` 用 mock adapter 覆盖。

## Workflow E2E Coverage

`bun run test:e2e:opencode` 当前运行 8 个场景：

- harness smoke：验证真实 `opencode run` 能消费 mock LLM response。
- debug happy path：`sp_route` 返回 proposal，`sp_start` 创建 run，随后通过 `sp_record` 写入 root cause。
- strict debug gate：缺少 `root_cause_found` 时阻断修复写入。
- feature lifecycle：一条长链路覆盖 proposal、start、design、plan、两个 implementer dispatch、spec-review、code-review、verification、finish 和 reset 后历史 run 保留。
- record validation recovery：缺 artifact 的 gate 更新失败，随后附带 artifact 恢复。
- completion verification gate：fresh verification 前拒绝 `done`，验证后接受。
- active waiting reroute：等待态 workflow 保持当前 mode，不被新意图覆盖。
- execute gate order：strict execute 下依次验证 plan gate 和 red-test gate。

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
