import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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

  test("读取当前 run 的节点 task 和 record 文件", async () => {
    await e2eLog.scenario(
      "harness 节点读取",
      "直接构造一个 workflow run，验证 harness 能列出节点并读取 task.md 和 record.json。",
      async (log) => {
        log.step("创建隔离 harness", "准备临时目录并直接写入 workflow state 与节点文件")
        harness = await createOpencodeE2EHarness()
        const runID = "run-node-files"
        const runRoot = join(harness.projectDir, ".superpowers", "runs", runID)
        const nodeRoot = join(runRoot, "nodes", "001-plan")
        mkdirSync(nodeRoot, { recursive: true })
        writeFileSync(
          join(harness.projectDir, ".superpowers", "current.json"),
          `${JSON.stringify({ run: runID }, null, 2)}\n`,
        )
        writeFileSync(
          join(runRoot, "state.json"),
          `${JSON.stringify(
            {
              id: runID,
              mode: "plan",
              workflow: "feature",
              phase: "awaiting-plan-approval",
              current_phase: "awaiting-plan-approval",
              node_runs: [{ id: "001-plan", agent: "sp-planner", status: "passed" }],
            },
            null,
            2,
          )}\n`,
        )
        writeFileSync(join(nodeRoot, "task.md"), "# Planner task\n\nWrite the formal plan.\n")
        writeFileSync(
          join(nodeRoot, "record.json"),
          `${JSON.stringify({ event: "plan", status: "passed", summary: "Plan ready." }, null, 2)}\n`,
        )

        log.step("验证节点读取接口", "应该能按当前 run 读到节点 id、task.md 和 record.json")
        const nodeHarness = withNodeAccess(harness)
        expect(nodeHarness.listNodeIDs()).toEqual(["001-plan"])
        expect(nodeHarness.readNodeTask("001-plan")).toContain("Write the formal plan")
        expect(nodeHarness.readNodeRecord("001-plan")).toMatchObject({
          event: "plan",
          status: "passed",
        })
        logNoWorkflowState(log)
        log.verify("harness 节点读取接口返回了预期的 task 和 record 内容")
      },
    )
  }, 30_000)
})

function logNoWorkflowState(log: E2EScenarioLogger): void {
  log.stateSnapshot("harness 冒烟测试没有创建 workflow state", null)
}

function withNodeAccess(
  value: unknown,
): {
  listNodeIDs(runID?: string): string[]
  readNodeTask(nodeID: string, runID?: string): string | null
  readNodeRecord(nodeID: string, runID?: string): Record<string, unknown> | null
} {
  return value as {
    listNodeIDs(runID?: string): string[]
    readNodeTask(nodeID: string, runID?: string): string | null
    readNodeRecord(nodeID: string, runID?: string): Record<string, unknown> | null
  }
}
