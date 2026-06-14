import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { createOpencodeE2EHarness } from "./harness"
import { createE2ELogger, type E2EScenarioLogger } from "./logging"

let harness: Awaited<ReturnType<typeof createOpencodeE2EHarness>> | null = null
const e2eLog = createE2ELogger({
  suite: "OpenCode e2e 基础设施",
  description: "验证可复用 harness 能启动真实 opencode，并通过 mock LLM 服务完成一次请求。",
})

beforeAll(() => {
  e2eLog.suiteStart()
})

afterAll(() => {
  e2eLog.suiteSummary()
})

afterEach(async () => {
  await harness?.close()
  harness = null
})

describe("createOpencodeE2EHarness", () => {
  test("通过 mock LLM 服务运行 opencode 并记录请求", async () => {
    await e2eLog.scenario(
      "harness 冒烟测试",
      "启动临时 OpenCode 项目，让一个提示词经过 mock LLM 服务，并验证请求被正确记录。",
      async (log) => {
        log.step("创建隔离 harness", "准备临时 HOME、配置、项目目录、插件入口和 mock LLM 服务")
        harness = await createOpencodeE2EHarness()

        log.step("注册 mock 响应", "真实模型调用应该消费一个 request_id 预设响应")
        await harness.mock.expect([
          {
            request_id: "harness-smoke",
            response: {
              type: "text",
              content: "harness response",
            },
          },
        ])

        log.step("运行 opencode", "提示词标记应该命中已注册的 mock 响应")
        const result = await harness.runOpencode({
          title: "Harness smoke",
          message: "[e2e_trace_id:harness-smoke] [llm_request_id:harness-smoke] say hello",
        })

        expect(result.code).toBe(0)
        expect(result.error).toBeUndefined()
        log.verify("OpenCode 已使用 mock 模型响应并成功退出")

        log.step("验证模型请求记录", "mock server 应该只记录一个 request_id=harness-smoke 的模型请求")
        const requests = await harness.mock.requests()
        log.mockInteractions(requests)
        expect(requests).toHaveLength(1)
        expect(requests[0]?.request_id).toBe("harness-smoke")

        const pending = await harness.mock.pending()
        expect(pending).toEqual([])
        logNoWorkflowState(log)
        log.verify("mock server 记录了一个请求，并且没有剩余预设响应")
      },
    )
  }, 30_000)
})

function logNoWorkflowState(log: E2EScenarioLogger): void {
  log.stateSnapshot("harness 冒烟测试没有创建 workflow state", null)
}
