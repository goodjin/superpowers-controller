import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import type { MockLlmExpectation } from "../support/llm-mock/server"
import { createE2ELogger, type E2EScenarioLogger } from "../support/opencode-e2e/logging"
import { createOpencodeE2EHarness, type OpencodeE2EHarness } from "../support/opencode-e2e/harness"

const e2eLog = createE2ELogger({
  suite: "OpenCode 工作流 e2e",
  description: "运行真实 opencode，接入 mock LLM 服务，并验证工作流状态、产物、门禁和工具错误。",
})

let harness: OpencodeE2EHarness | null = null

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

describe("OpenCode 工作流 e2e", () => {
  test("通过 sp_start 和 sp_report 记录 debug 根因", async () => {
    await e2eLog.scenario(
      "debug 根因记录",
      "路由一个 debug 任务，记录 root cause 产物，并验证持久化工作流状态。",
      async (log) => {
        log.step("创建隔离 OpenCode harness", "插件从 dist 加载，项目状态只写入临时目录")
        harness = await createOpencodeE2EHarness()
        const requestId = "debug-root-cause"

        log.step("注册 mock LLM 响应", "同一个 request_id 依次驱动 sp_start、sp_report 和最终文本响应")
        await harness.mock.expect([
          startCall(requestId, {
            request: "/sp-debug 修复失败测试",
            workflow: "debug",
            entrypoint: "debug",
          }),
          {
            request_id: requestId,
            response: {
              type: "tool_call",
              name: "sp_report",
              arguments: {
                event: "debug",
                status: "passed",
                summary: "The failing test starts from an uninitialized route state.",
                gates: {
                  root_cause_found: true,
                },
                artifacts: {
                  root_cause: "The failing test starts from an uninitialized route state.",
                },
              },
            },
          },
          {
            request_id: requestId,
            response: {
              type: "text",
              content: "root cause recorded",
            },
          },
        ])

        log.step("运行 opencode", "提示词标记将 trace_id 和 request_id 绑定到 mock 响应队列")
        const result = await harness.runOpencode({
          title: "Debug root cause",
          timeoutMs: 60_000,
          message: `[e2e_trace_id:debug-root-cause] [llm_request_id:${requestId}] /sp-debug 修复失败测试`,
        })

        expect(result.code).toBe(0)
        expect(result.error).toBeUndefined()
        log.verify("OpenCode 已完成 debug tool-call 循环并成功退出")

        log.step("验证 mock 模型请求", "主请求应触发 start、report 和最终响应")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual([
          requestId,
          requestId,
          requestId,
        ])
        expect(await harness.mock.pending()).toEqual([])
        log.verify("mock LLM 已消费 debug 主链路的全部预设响应")

        log.step("验证工作流状态和产物", "debug 模式应该持久化 root_cause_found，并在根因记录后进入实现阶段")
        const state = readLoggedWorkflowState(log, harness, "debug 响应处理完成后")
        logArtifactSnapshots(log, harness, ["root_cause"])
        expect(state?.mode).toBe("debug")
        expect(state?.phase).toBe("implement")
        expect(state?.gates.root_cause_found).toBe(true)
        expect(state?.artifacts.root_cause).toBe("root_cause.md")
        expect(harness.readArtifact("root_cause")).toContain("uninitialized route state")
        log.verify("debug 状态、门禁和 root cause 产物符合预期")
      },
    )
  }, 30_000)

  test("strict debug 模式下在记录根因前阻断修复写入", async () => {
    await e2eLog.scenario(
      "strict debug 写入门禁",
      "进入 debug 模式，验证记录 root_cause_found 之前生产写入会被阻断。",
      async (log) => {
        log.step("创建 strict debug harness", "debug_gate=strict 时，缺少 root cause 应该变成阻断型工具错误")
        harness = await createOpencodeE2EHarness({
          workflowConfig: {
            debug_gate: "strict",
          },
        })
        const requestId = "strict-debug-write"

        log.step("注册 mock LLM 响应", "先启动 debug，再在 root cause 前尝试写入，最后在工具错误后结束")
        await harness.mock.expect([
          startCall(requestId, {
            request: "/sp-debug 修复失败测试",
            workflow: "debug",
            entrypoint: "debug",
          }),
          toolCall(requestId, "write", {
            filePath: "src/repair.ts",
            content: "export const repaired = true\n",
          }),
          textResponse(requestId, "repair write blocked"),
        ])

        log.step("运行 opencode", "write 工具应该被插件门禁拦截")
        const result = await harness.runOpencode({
          title: "Strict debug gate",
          message: `[e2e_trace_id:strict-debug-write] [llm_request_id:${requestId}] /sp-debug 修复失败测试`,
        })

        expect(result.code).toBe(0)
        log.verify("OpenCode 收到写入阻断结果后成功退出")

        log.step("验证工具错误返回给模型", "第四次模型请求应该包含 root_cause_found 门禁错误")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual(Array(3).fill(requestId))
        expect(JSON.stringify(requests[2]?.body)).toContain("root_cause_found gate is required before repair writes")
        expect(await harness.mock.pending()).toEqual([])
        log.verify("写入阻断错误已出现在下一轮模型上下文中")

        log.step("验证状态未被误批准", "debug workflow 存在，但 root_cause_found 和 root_cause 产物仍为空")
        const state = readLoggedWorkflowState(log, harness, "写入被阻断后")
        logArtifactSnapshots(log, harness, ["root_cause"])
        expect(state?.mode).toBe("debug")
        expect(state?.gates.root_cause_found).not.toBe(true)
        expect(harness.readArtifact("root_cause")).toBeNull()
        log.verify("strict debug 门禁阻止了 root cause 状态被伪造")
      },
    )
  }, 30_000)

  test("debug 修复 workflow 跑完根因、修复、检查和收尾", async () => {
    await e2eLog.scenario(
      "debug 修复闭环",
      "debugger 先记录根因，runtime 再派发 implementer、acceptance、verification、code review 和 finisher。",
      async (log) => {
        log.step("创建启用子节点 prompt 的 harness", "每个 runtime 派发的节点都会生成可断言的 request id 和 task.md")
        harness = await createOpencodeE2EHarness({ enableChildPrompts: true } as never)
        const requestId = "debug-repair-full-chain"

        log.step("注册 debug 修复链路 mock 响应", "子节点应该按 debug -> implement -> acceptance -> verification -> code-review -> finish 嵌套执行")
        await harness.mock.expect([
          startCall(requestId, {
            request: "/sp-debug 修复批量任务重试失败",
            workflow: "debug",
            entrypoint: "debug",
          }),
          toolCall("node-001-debug", "sp_report", {
            event: "debug",
            status: "passed",
            summary: "Retry jobs fail because stale attempt state is reused after cancellation.",
            gates: {
              root_cause_found: true,
            },
            artifacts: {
              root_cause: "Retry jobs fail because stale attempt state is reused after cancellation.",
            },
          }),
          textResponse("node-001-debug", "root cause recorded"),
          toolCall("node-002-implement", "sp_report", {
            event: "implementation",
            status: "passed",
            summary: "The retry path now resets attempt state before enqueueing a replacement job.",
            gates: {
              implementation_done: true,
            },
            artifacts: {
              patch_summary: "Reset retry attempt state before enqueueing replacement jobs and added regression coverage.",
            },
          }),
          textResponse("node-002-implement", "repair recorded"),
          toolCall("node-003-acceptance", "sp_report", {
            event: "acceptance",
            status: "passed",
            summary: "Acceptance passed for cancel-then-retry behavior.",
            gates: {
              acceptance_passed: true,
            },
            artifacts: {
              acceptance: "The repair matches the confirmed retry behavior and does not change unrelated queue states.",
            },
          }),
          textResponse("node-003-acceptance", "acceptance recorded"),
          toolCall("node-004-verification", "sp_report", {
            event: "verification",
            status: "passed",
            summary: "Fresh verification passed after the retry repair.",
            gates: {
              verification_fresh: true,
            },
            artifacts: {
              verification_log: "bun test retry-queue.test.ts passed after the final repair.",
            },
          }),
          textResponse("node-004-verification", "verification recorded"),
          toolCall("node-005-code-review", "sp_report", {
            event: "code-review",
            status: "passed",
            summary: "No blocking review issues remain in the retry state reset.",
            gates: {
              code_review_passed: true,
            },
            artifacts: {
              code_review: "Reviewed retry state reset, queue side effects, and regression coverage. No blockers.",
            },
          }),
          textResponse("node-005-code-review", "code review recorded"),
          toolCall("node-006-finish", "sp_report", {
            event: "finish",
            status: "passed",
            summary: "The debug repair workflow is ready to close.",
            artifacts: {
              finish_note: "Ready after root cause, repair, acceptance, verification, and code review.",
            },
          }),
          textResponse("node-006-finish", "finish recorded"),
          textResponse(requestId, "debug repair workflow completed"),
        ])

        log.step("运行 opencode", "sp_start 后的后续节点应由 runtime 自动派发")
        const result = await harness.runOpencode({
          title: "Debug repair full chain",
          timeoutMs: 90_000,
          message: `[e2e_trace_id:debug-repair-full-chain] [llm_request_id:${requestId}] /sp-debug 修复批量任务重试失败`,
        })

        expect(result.code).toBe(0)
        expect(result.error).toBeUndefined()

        log.step("验证嵌套请求顺序", "子节点应先一路派发到 finish，再逐层返回文本响应")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual([
          requestId,
          "node-001-debug",
          "node-002-implement",
          "node-003-acceptance",
          "node-004-verification",
          "node-005-code-review",
          "node-006-finish",
          "node-006-finish",
          "node-005-code-review",
          "node-004-verification",
          "node-003-acceptance",
          "node-002-implement",
          "node-001-debug",
          requestId,
        ])
        expect(await harness.mock.pending()).toEqual([])
        log.verify("debug 修复链路的所有 mock 响应均被消费")

        log.step("验证最终 workflow 状态", "debug 修复完成后应具备根因、实现、三类检查和 finish 证据")
        const state = readLoggedWorkflowState(log, harness, "debug 修复闭环完成后")
        expect(state?.mode).toBe("debug")
        expect(state?.phase).toBe("finished")
        expect(state?.status).toBe("passed")
        expect(state?.gates).toMatchObject({
          root_cause_found: true,
          implementation_done: true,
          acceptance_passed: true,
          verification_fresh: true,
          code_review_passed: true,
        })
        expect(state?.history.map((entry) => entry.event)).toEqual([
          "created",
          "debug",
          "implementation",
          "acceptance",
          "verification",
          "code-review",
          "finish",
        ])
        logArtifactSnapshots(log, harness, ["root_cause", "patch_summary", "acceptance", "verification_log", "code_review", "finish_note"])
        expect(harness.readArtifact("verification_log")).toContain("retry-queue.test.ts passed")

        expect(harness.listNodeIDs()).toEqual([
          "001-debug",
          "002-implement",
          "003-acceptance",
          "004-verification",
          "005-code-review",
          "006-finish",
        ])
        expect(harness.readNodeTask("002-implement")).toContain("Primary skill: superpowers-test-driven-development")
        expect(harness.readNodeRecord("006-finish")).toMatchObject({ event: "finish", status: "passed" })
        log.verify("debug 修复 workflow 已完整跑到 passed")
      },
    )
  }, 120_000)

  test("super-agent 原生 task 调用被 Controller 拦截", async () => {
    await e2eLog.scenario(
      "super-agent native task 阻断",
      "super-agent 不能绕过 Controller 直接创建子会话；原生 task 应从可用工具中移除或被硬阻断。",
      async (log) => {
        log.step("创建隔离 OpenCode harness", "以 --agent super-agent 启动，模拟 superagent 主会话")
        harness = await createOpencodeE2EHarness()
        const requestId = "super-agent-native-task-block"

        log.step("注册 mock LLM 响应", "第一轮故意调用原生 task，第二轮在工具错误返回后结束")
        await harness.mock.expect([
          toolCall(requestId, "task", {
            description: "T5 implementer: dashboard frontend",
            subagent_type: "sp-implementer",
            prompt: "Bypass Controller and implement T5.",
          }),
          textResponse(requestId, "native task blocked"),
        ])

        log.step("运行 opencode", "native task 应该不可用，或被 tool.execute.before 硬阻断")
        const result = await harness.runOpencode({
          title: "Native task block",
          agent: "super-agent",
          message: `[e2e_trace_id:super-agent-native-task-block] [llm_request_id:${requestId}] 直接派发 T5`,
        })

        expect(result.code).toBe(0)
        log.verify("OpenCode 收到 task 阻断后成功退出")

        log.step("验证工具错误返回给模型", "第二次模型请求应该说明 task 不可用")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual([requestId, requestId])
        expect(JSON.stringify(requests[1]?.body)).toContain("unavailable tool 'task'")
        expect(harness.readWorkflowState()).toBeNull()
        expect(await harness.mock.pending()).toEqual([])
        log.verify("native task 未创建 workflow state 或未登记子会话")
      },
    )
  }, 30_000)

  test("记录从 design 到 fresh verification 的完整 feature 生命周期", async () => {
    await e2eLog.scenario(
      "feature 完整生命周期",
      "在一条长 workflow 中记录 design/spec、plan、red test、implementation、review 和 fresh verification。",
      async (log) => {
        log.step("创建隔离 OpenCode harness", "默认 guided 配置应该允许长 feature 生命周期持续记录证据")
        harness = await createOpencodeE2EHarness()
        const requestId = "feature-full-lifecycle"

        log.step("注册生命周期 mock 响应", "模型请求应该完成 start、design、plan、implementation、acceptance、verification、code review 和 finish")
        await harness.mock.expect([
          startCall(requestId, {
            request: "/sp-design 增加批量任务运行视图",
            workflow: "feature",
            entrypoint: "feature",
          }),
          toolCall(requestId, "sp_report", {
            event: "design",
            status: "passed",
            summary: "The UI contract, empty states, and batch retry behavior are documented.",
            gates: {
              spec_written: true,
              design_approved: true,
            },
            artifacts: {
              spec: [
                "# Batch task run view",
                "- Shows queued, running, failed, and completed task groups.",
                "- Keeps retry and cancel controls disabled until a task is selected.",
                "- Empty state explains how to start a batch run.",
              ].join("\n"),
            },
          }),
          toolCall(requestId, "sp_report", {
            event: "plan",
            status: "passed",
            summary: "The plan splits state loading, grouped rendering, retry handling, and regression tests.",
            gates: {
              plan_written: true,
            },
            artifacts: {
              plan: [
                "# Implementation plan",
                "1. Add task grouping selector.",
                "2. Render status sections with stable keys.",
                "3. Add retry and cancel action tests.",
              ].join("\n"),
            },
          }),
          toolCall(requestId, "sp_report", {
            event: "implementation",
            status: "passed",
            summary: "The state loading task added a failing test and implementation evidence.",
            gates: {
              red_test_seen: true,
              implementation_done: true,
            },
            artifacts: {
              red_test_log: "FAIL task-run-state.test.ts: loads queued and failed groups separately.",
              patch_summary: "Implemented task run state loading.",
            },
          }),
          toolCall(requestId, "sp_report", {
            event: "implementation",
            status: "passed",
            summary: "The retry actions task added action tests and implementation evidence.",
            gates: {
              red_test_seen: true,
              implementation_done: true,
            },
            artifacts: {
              red_test_log: "FAIL task-run-actions.test.ts: retry button is disabled until task selection.",
              patch_summary: "Implemented retry and cancel actions.",
            },
          }),
          toolCall(requestId, "sp_report", {
            event: "acceptance",
            status: "passed",
            summary: "Acceptance passed for grouped rendering and retry controls.",
            gates: {
              acceptance_passed: true,
            },
            artifacts: {
              acceptance: "Acceptance passed: behavior matches the documented UI contract.",
            },
          }),
          toolCall(requestId, "sp_report", {
            event: "verification",
            status: "passed",
            summary: "The e2e verification command completed after the final change.",
            gates: {
              verification_fresh: true,
            },
            artifacts: {
              verification_log: "bun test task-run-view.test.ts && bun run test:e2e passed.",
            },
          }),
          toolCall(requestId, "sp_report", {
            event: "code-review",
            status: "passed",
            summary: "Code review passed with no blocking issues.",
            gates: {
              code_review_passed: true,
            },
            artifacts: {
              code_review: "No blocking issues found in grouped rendering, actions, or tests.",
            },
          }),
          toolCall(requestId, "sp_report", {
            event: "finish",
            status: "passed",
            summary: "The feature workflow is ready to archive.",
            artifacts: {
              finish_note: "Ready after review and verification.",
            },
          }),
          textResponse(requestId, "feature lifecycle recorded"),
        ])

        log.step("运行 opencode", "完整生命周期应该通过多次 sp_report 工具调用完成")
        const result = await harness.runOpencode({
          title: "Feature lifecycle",
          timeoutMs: 60_000,
          message: `[e2e_trace_id:feature-full-lifecycle] [llm_request_id:${requestId}] /sp-design 增加批量任务运行视图`,
        })

        expect(result.code).toBe(0)
        expect(result.error).toBeUndefined()
        log.verify("OpenCode 已完成全部生命周期轮次并成功退出")

        log.step("验证 mock 模型请求", "十轮调用应该消费同一个 request_id，且没有剩余预设响应")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual(Array(10).fill(requestId))
        expect(await harness.mock.pending()).toEqual([])
        log.verify("全部生命周期预设响应已按顺序消费")

        log.step("验证最终生命周期状态", "所有关键门禁应该为 true，history 应该保留节点顺序")
        const state = readLoggedWorkflowState(log, harness, "feature 生命周期完成后")
        log.stateSnapshot("feature 生命周期历史 run", state)
        expect(state?.mode).toBe("design")
        expect(state?.phase).toBe("finished")
        expect(state?.status).toBe("passed")
        expect(state?.gates).toMatchObject({
          spec_written: true,
          design_approved: true,
          plan_written: true,
          red_test_seen: true,
          implementation_done: true,
          acceptance_passed: true,
          code_review_passed: true,
          verification_fresh: true,
        })
        expect(state?.history.map((entry) => entry.event)).toEqual([
          "created",
          "design",
          "plan",
          "implementation",
          "implementation",
          "acceptance",
          "verification",
          "code-review",
          "finish",
        ])
        log.verify("生命周期状态的 mode、phase、gates 和 history 符合预期")

        log.step("验证生命周期产物", "spec、plan、red test log 和 verification log 应该已持久化")
        logLastArtifactSnapshots(log, harness, ["spec", "plan", "red_test_log", "verification_log"])
        expect(harness.readLastArtifact("spec")).toContain("Batch task run view")
        expect(harness.readLastArtifact("plan")).toContain("Implementation plan")
        expect(harness.readLastArtifact("red_test_log")).toContain("FAIL task-run-actions.test.ts")
        expect(harness.readLastArtifact("verification_log")).toContain("bun run test:e2e passed")
        log.verify("抽样检查的生命周期产物都包含预期证据")
      },
    )
  }, 70_000)

  test("plan-only workflow 只生成计划并结束", async () => {
    await e2eLog.scenario(
      "plan-only 计划闭环",
      "planner 写入 plan 和 task_graph 后 workflow 直接通过，不派发 implementer。",
      async (log) => {
        log.step("创建启用子节点 prompt 的 harness", "plan-only 应只创建 planner 节点")
        harness = await createOpencodeE2EHarness({ enableChildPrompts: true } as never)
        const requestId = "plan-only-full-chain"

        log.step("注册 plan-only mock 响应", "planner 提交计划和任务图后，runtime 应返回 finish decision 而不创建实现节点")
        await harness.mock.expect([
          startCall(requestId, {
            request: "/sp-plan 设计批量任务恢复方案",
            workflow: "plan-only",
            entrypoint: "plan-only",
          }),
          toolCall("node-001-plan", "sp_report", {
            event: "plan",
            status: "passed",
            summary: "The recovery plan and task graph are ready for later user-approved execution.",
            gates: {
              plan_written: true,
            },
            artifacts: {
              plan: [
                "# Batch recovery plan",
                "1. Snapshot unfinished tasks before restart.",
                "2. Reconcile runtime sessions against persisted task state.",
                "3. Ask for user confirmation before starting repair work.",
              ].join("\n"),
            },
            task_graph: {
              tasks: [
                {
                  id: "T1",
                  title: "Recovery snapshot",
                  summary: "Persist unfinished task snapshots.",
                  depends_on: [],
                  files: ["src/recovery/snapshot.ts"],
                },
                {
                  id: "T2",
                  title: "Runtime reconciliation",
                  summary: "Compare active sessions with stored tasks.",
                  depends_on: ["T1"],
                  files: ["src/recovery/reconcile.ts"],
                },
              ],
            },
          }),
          textResponse("node-001-plan", "plan-only recorded"),
          textResponse(requestId, "plan-only workflow completed"),
        ])

        log.step("运行 opencode", "plan-only 不应进入 implementer 子会话")
        const result = await harness.runOpencode({
          title: "Plan-only full chain",
          timeoutMs: 70_000,
          message: `[e2e_trace_id:plan-only-full-chain] [llm_request_id:${requestId}] /sp-plan 设计批量任务恢复方案`,
        })

        expect(result.code).toBe(0)
        expect(result.error).toBeUndefined()

        log.step("验证请求顺序", "只有 parent 和 planner 两个 request id 应出现")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual([
          requestId,
          "node-001-plan",
          "node-001-plan",
          requestId,
        ])
        expect(await harness.mock.pending()).toEqual([])
        log.verify("plan-only 未派发 implementer")

        log.step("验证计划结果", "workflow 应直接进入 passed，计划和 task_graph 都应落盘")
        const state = readLoggedWorkflowState(log, harness, "plan-only 完成后")
        expect(state?.mode).toBe("plan")
        expect(state?.workflow).toBe("plan-only")
        expect(state?.phase).toBe("plan-complete")
        expect(state?.status).toBe("passed")
        expect(state?.gates.plan_written).toBe(true)
        expect(state?.task_graph?.tasks.map((task) => task.id)).toEqual(["T1", "T2"])
        expect(state?.node_runs.map((run) => run.agent)).toEqual(["sp-planner"])
        logArtifactSnapshots(log, harness, ["plan"])
        expect(harness.readArtifact("plan")).toContain("Batch recovery plan")
        expect(harness.listNodeIDs()).toEqual(["001-plan"])
        expect(harness.readNodeRecord("001-plan")).toMatchObject({ event: "plan", status: "passed" })
        log.verify("plan-only workflow 以 planner 输出作为结果完成")
      },
    )
  }, 100_000)

  test("review workflow 依次执行 acceptance、verification、code review 和 finish", async () => {
    await e2eLog.scenario(
      "review 检查闭环",
      "独立 review workflow 应先验收，再验证，最后代码审查，通过后由 finisher 汇总。",
      async (log) => {
        log.step("创建启用子节点 prompt 的 harness", "review workflow 的三个检查节点需要稳定编号")
        harness = await createOpencodeE2EHarness({ enableChildPrompts: true } as never)
        const requestId = "review-full-chain"

        log.step("注册 review mock 响应", "runtime 应按 acceptance -> verification -> code-review -> finish 顺序派发")
        await harness.mock.expect([
          startCall(requestId, {
            request: "/sp-review 检查任务运行面板改动",
            workflow: "review",
            entrypoint: "review",
          }),
          toolCall("node-001-acceptance", "sp_report", {
            event: "acceptance",
            status: "passed",
            summary: "The delivered behavior matches the confirmed task and plan.",
            gates: {
              acceptance_passed: true,
            },
            artifacts: {
              acceptance: "The status filter and retry confirmation behavior satisfy the accepted workflow scope.",
            },
          }),
          textResponse("node-001-acceptance", "acceptance recorded"),
          toolCall("node-002-verification", "sp_report", {
            event: "verification",
            status: "passed",
            summary: "Fresh verification passed for the reviewed change.",
            gates: {
              verification_fresh: true,
            },
            artifacts: {
              verification_log: "bun test task-run-panel.test.ts passed for the reviewed change.",
            },
          }),
          textResponse("node-002-verification", "verification recorded"),
          toolCall("node-003-code-review", "sp_report", {
            event: "code-review",
            status: "passed",
            summary: "No blocking code review issues remain.",
            gates: {
              code_review_passed: true,
            },
            artifacts: {
              code_review: "Reviewed state handling, confirmation flow, and test coverage. No blockers.",
            },
          }),
          textResponse("node-003-code-review", "code review recorded"),
          toolCall("node-004-finish", "sp_report", {
            event: "finish",
            status: "passed",
            summary: "The review workflow is ready to close.",
            artifacts: {
              finish_note: "Review closed after acceptance, fresh verification, and code review passed.",
            },
          }),
          textResponse("node-004-finish", "finish recorded"),
          textResponse(requestId, "review workflow completed"),
        ])

        log.step("运行 opencode", "review workflow 应由 runtime 自动推进三个检查节点")
        const result = await harness.runOpencode({
          title: "Review full chain",
          timeoutMs: 90_000,
          message: `[e2e_trace_id:review-full-chain] [llm_request_id:${requestId}] /sp-review 检查任务运行面板改动`,
        })

        expect(result.code).toBe(0)
        expect(result.error).toBeUndefined()

        log.step("验证请求顺序", "review 的检查顺序应固定为 acceptance、verification、code review")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual([
          requestId,
          "node-001-acceptance",
          "node-002-verification",
          "node-003-code-review",
          "node-004-finish",
          "node-004-finish",
          "node-003-code-review",
          "node-002-verification",
          "node-001-acceptance",
          requestId,
        ])
        expect(await harness.mock.pending()).toEqual([])
        log.verify("review 子节点顺序符合定义")

        log.step("验证 review 结果", "三类检查门禁和 finish 产物都应完成")
        const state = readLoggedWorkflowState(log, harness, "review 完成后")
        expect(state?.mode).toBe("review")
        expect(state?.phase).toBe("finished")
        expect(state?.status).toBe("passed")
        expect(state?.gates).toMatchObject({
          acceptance_passed: true,
          verification_fresh: true,
          code_review_passed: true,
        })
        expect(state?.history.map((entry) => entry.event)).toEqual([
          "created",
          "acceptance",
          "verification",
          "code-review",
          "finish",
        ])
        logArtifactSnapshots(log, harness, ["acceptance", "verification_log", "code_review", "finish_note"])
        expect(harness.readArtifact("code_review")).toContain("No blockers")
        expect(harness.listNodeIDs()).toEqual([
          "001-acceptance",
          "002-verification",
          "003-code-review",
          "004-finish",
        ])
        log.verify("review workflow 已完整跑到 passed")
      },
    )
  }, 120_000)

  test("parallel-investigate workflow 完成调查并汇总", async () => {
    await e2eLog.scenario(
      "parallel-investigate 调查闭环",
      "单任务调查在 investigator 汇报后派发 finisher，finish 不要求 fresh verification。",
      async (log) => {
        log.step("创建启用子节点 prompt 的 harness", "调查节点和收尾节点都应生成 task.md")
        harness = await createOpencodeE2EHarness({ enableChildPrompts: true } as never)
        const requestId = "parallel-investigate-full-chain"

        log.step("注册调查 mock 响应", "investigator 提交 investigation report 后，runtime 应派发 finisher")
        await harness.mock.expect([
          startCall(requestId, {
            request: "/sp-parallel-investigate 调查会话状态恢复策略",
            workflow: "parallel-investigate",
            entrypoint: "parallel-investigate",
          }),
          toolCall("node-001-investigate", "sp_report", {
            event: "investigation",
            status: "passed",
            summary: "Runtime memory is authoritative; persisted state is a recovery snapshot.",
            artifacts: {
              investigation: [
                "# Session recovery investigation",
                "- Runtime memory should decide active sessions.",
                "- Persisted workflow files provide recovery candidates after restart.",
                "- Re-dispatch should use idempotent start semantics.",
              ].join("\n"),
            },
          }),
          textResponse("node-001-investigate", "investigation recorded"),
          toolCall("node-002-finish", "sp_report", {
            event: "finish",
            status: "passed",
            summary: "The investigation workflow has a clear recovery recommendation.",
            artifacts: {
              finish_note: "Use runtime memory as current truth and scan workflow files only when memory has no active workflow.",
            },
          }),
          textResponse("node-002-finish", "finish recorded"),
          textResponse(requestId, "parallel investigation workflow completed"),
        ])

        log.step("运行 opencode", "parallel-investigate 不应要求 verification_fresh")
        const result = await harness.runOpencode({
          title: "Parallel investigate full chain",
          timeoutMs: 90_000,
          message: `[e2e_trace_id:parallel-investigate-full-chain] [llm_request_id:${requestId}] /sp-parallel-investigate 调查会话状态恢复策略`,
        })

        expect(result.code).toBe(0)
        expect(result.error).toBeUndefined()

        log.step("验证请求顺序", "调查节点后应直接进入 finish")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual([
          requestId,
          "node-001-investigate",
          "node-002-finish",
          "node-002-finish",
          "node-001-investigate",
          requestId,
        ])
        expect(await harness.mock.pending()).toEqual([])
        log.verify("调查和汇总节点都已执行")

        log.step("验证调查结果", "workflow 应保存 investigation 和 finish_note，并进入 passed")
        const state = readLoggedWorkflowState(log, harness, "parallel-investigate 完成后")
        expect(state?.mode).toBe("parallel-investigate")
        expect(state?.phase).toBe("finished")
        expect(state?.status).toBe("passed")
        expect(state?.gates.verification_fresh).not.toBe(true)
        expect(state?.history.map((entry) => entry.event)).toEqual([
          "created",
          "investigation",
          "finish",
        ])
        logArtifactSnapshots(log, harness, ["investigation", "finish_note"])
        expect(harness.readArtifact("investigation")).toContain("Runtime memory should decide active sessions")
        expect(harness.listNodeIDs()).toEqual(["001-investigate", "002-finish"])
        expect(harness.readNodeTask("001-investigate")).toContain("event: investigation")
        expect(harness.readNodeTask("002-finish")).toContain("artifacts/investigation.md")
        expect(harness.readNodeRecord("002-finish")).toMatchObject({ event: "finish", status: "passed" })
        log.verify("parallel-investigate workflow 已完整跑到 passed")
      },
    )
  }, 120_000)

  test("暴露缺少产物的校验错误并通过有效记录恢复", async () => {
    await e2eLog.scenario(
      "sp_report 校验失败后恢复",
      "先拒绝缺少必需产物的门禁更新，再通过补充产物恢复。",
      async (log) => {
        log.step("创建隔离 OpenCode harness", "默认配置下仍应该强制执行 sp_report 产物校验")
        harness = await createOpencodeE2EHarness()
        const requestId = "record-validation-recovery"

        log.step("注册恢复流程 mock 响应", "第一次 sp_report 故意缺少 plan，第二次 sp_report 补充 plan")
        await harness.mock.expect([
          startCall(requestId, {
            request: "/sp-plan 拆解重试调度器改造",
            workflow: "plan-only",
            entrypoint: "plan-only",
          }),
          toolCall(requestId, "sp_report", {
            event: "plan",
            status: "passed",
            summary: "This intentionally omits the plan artifact so validation should fail.",
            gates: {
              plan_written: true,
            },
          }),
          toolCall(requestId, "sp_report", {
            event: "plan",
            status: "passed",
            summary: "The plan artifact is now attached with the gate update.",
            gates: {
              plan_written: true,
            },
            artifacts: {
              plan: "Plan: add retry queue fixtures, persist attempt count, then verify retry ordering.",
            },
          }),
          textResponse(requestId, "record validation recovered"),
        ])

        log.step("运行 opencode", "失败的记录结果应该先返回给模型，然后模型再提交恢复记录")
        const result = await harness.runOpencode({
          title: "Record validation recovery",
          timeoutMs: 60_000,
          message: `[e2e_trace_id:record-validation-recovery] [llm_request_id:${requestId}] /sp-plan 拆解重试调度器改造`,
        })

        expect(result.code).toBe(0)
        log.verify("OpenCode 已在校验失败恢复后成功退出")

        log.step("验证校验错误传播", "下一次模型请求应该包含缺少 plan 产物的错误")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual(Array(4).fill(requestId))
        expect(JSON.stringify(requests[2]?.body)).toContain("plan_written requires plan artifact")
        expect(await harness.mock.pending()).toEqual([])
        log.verify("缺少产物的错误已在有效重试前返回给模型")

        log.step("验证恢复后的状态", "状态历史中应该只出现成功的 plan 记录")
        const state = readLoggedWorkflowState(log, harness, "sp_report 校验失败并恢复后")
        logArtifactSnapshots(log, harness, ["plan"])
        expect(state?.mode).toBe("plan")
        expect(state?.phase).toBe("plan-complete")
        expect(state?.gates.plan_written).toBe(true)
        expect(state?.history.map((entry) => entry.event)).toEqual(["created", "plan"])
        expect(harness.readArtifact("plan")).toContain("persist attempt count")
        log.verify("有效重试后 plan 门禁和产物已持久化")
      },
    )
  }, 70_000)

  test("fresh verification 前拒绝完成记录并在验证后接受", async () => {
    await e2eLog.scenario(
      "completion verification 门禁",
      "fresh verification 前拒绝完成记录，记录 verification 证据后再接受完成记录。",
      async (log) => {
        log.step("创建隔离 OpenCode harness", "verify-finish workflow 应该强制要求完成前验证证据")
        harness = await createOpencodeE2EHarness()
        const requestId = "completion-verification-gate"

        log.step("注册 completion mock 响应", "第一次完成应该失败，verification 打开门禁后第二次完成应该通过")
        await harness.mock.expect([
          startCall(requestId, {
            request: "/sp-verify-finish 完成调度器修复",
            workflow: "verify-finish",
            entrypoint: "verify-finish",
          }),
          toolCall(requestId, "sp_report", {
            event: "finish",
            status: "passed",
            summary: "This completion should be rejected because fresh verification is missing.",
          }),
          toolCall(requestId, "sp_report", {
            event: "verification",
            status: "passed",
            summary: "The verification was rerun after the latest change.",
            gates: {
              verification_fresh: true,
            },
            artifacts: {
              verification_log: "bun test retry-scheduler.test.ts passed after the final patch.",
            },
          }),
          toolCall(requestId, "sp_report", {
            event: "finish",
            status: "passed",
            summary: "Completion is now allowed because verification_fresh is recorded.",
            artifacts: {
              finish_note: "Ready to finish after fresh verification.",
            },
          }),
          textResponse(requestId, "completion accepted after verification"),
        ])

        log.step("运行 opencode", "workflow 应该在第一次完成被拒绝后恢复")
        const result = await harness.runOpencode({
          title: "Completion verification gate",
          timeoutMs: 60_000,
          message: `[e2e_trace_id:completion-verification-gate] [llm_request_id:${requestId}] /sp-verify-finish 完成调度器修复`,
        })

        expect(result.code).toBe(0)
        log.verify("OpenCode 已在验证和完成记录后成功退出")

        log.step("验证 completion 错误传播", "失败的完成记录应该向模型返回 verification_fresh 指引")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual(Array(5).fill(requestId))
        expect(JSON.stringify(requests[2]?.body)).toContain("verification_fresh is required before completion reports")
        expect(await harness.mock.pending()).toEqual([])
        log.verify("完成拒绝错误已在 verification 重试前返回给模型")

        log.step("验证完成后的状态", "history 应该只包含成功的 verification 和 finish 记录")
        const state = readLoggedWorkflowState(log, harness, "completion verification 响应处理完成后")
        logArtifactSnapshots(log, harness, ["verification_log"])
        expect(state?.mode).toBe("verify-finish")
        expect(state?.phase).toBe("finished")
        expect(state?.gates.verification_fresh).toBe(true)
        expect(state?.history.map((entry) => entry.event)).toEqual(["created", "verification", "finish"])
        expect(harness.readArtifact("verification_log")).toContain("retry-scheduler.test.ts passed")
        log.verify("只有记录 verification_fresh 和 verification_log 后，完成记录才被接受")
      },
    )
  }, 70_000)

  test("后续请求要求不同模式时仍保持等待中的 workflow", async () => {
    await e2eLog.scenario(
      "waiting 状态重路由",
      "即使后续路由请求看起来像 feature implementation，也要保持等待中的 debug workflow。",
      async (log) => {
        log.step("创建隔离 OpenCode harness", "sp_status 应该先读取当前 waiting 状态，再由总控决定是否另起 workflow")
        harness = await createOpencodeE2EHarness()
        const requestId = "active-waiting-reroute"

        log.step("注册等待状态查询 mock 响应", "debug workflow 先记录 waiting 状态，再查询当前 workflow")
        await harness.mock.expect([
          startCall(requestId, {
            request: "/sp-debug 修复间歇性失败",
            workflow: "debug",
            entrypoint: "debug",
          }),
          toolCall(requestId, "sp_report", {
            event: "debug",
            status: "needs_user",
            summary: "The retry cache is shared across two tests and needs review before mutation.",
            gates: {
              root_cause_found: true,
            },
            artifacts: {
              root_cause: "Retry cache state leaks between tests when the fixture is reused.",
            },
            question: {
              prompt: "Review the root cause before repair writes?",
            },
          }),
          toolCall(requestId, "sp_status", {}),
          textResponse(requestId, "active workflow preserved"),
        ])

        log.step("运行 opencode", "status 应该返回 active waiting workflow，而不是启动 feature run")
        const result = await harness.runOpencode({
          title: "Active waiting reroute",
          timeoutMs: 60_000,
          message: `[e2e_trace_id:active-waiting-reroute] [llm_request_id:${requestId}] /sp-debug 修复间歇性失败`,
        })

        expect(result.code).toBe(0)
        log.verify("OpenCode 已在活动状态路由检查后成功退出")

        log.step("验证状态结果返回给模型", "最终模型请求应该包含 waiting-user workflow")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual(Array(4).fill(requestId))
        expect(JSON.stringify(requests[3]?.body)).toContain("waiting-user")
        expect(await harness.mock.pending()).toEqual([])
        log.verify("status 查询保留了等待中的 debug workflow")

        log.step("验证当前 workflow 未被覆盖", "mode 和 goal 应该仍然指向原始 debug workflow")
        const state = readLoggedWorkflowState(log, harness, "waiting 状态重路由处理完成后")
        logArtifactSnapshots(log, harness, ["root_cause"])
        expect(state?.mode).toBe("debug")
        expect(state?.phase).toBe("waiting-user")
        expect(state?.goal).toContain("/sp-debug")
        expect(state?.history.map((entry) => entry.event)).toEqual(["created", "debug"])
        expect(harness.readArtifact("root_cause")).toContain("Retry cache state leaks")
        log.verify("后续实现请求没有覆盖 debug waiting 状态和 root cause 产物")
      },
    )
  }, 70_000)

  test("强制 execute workflow 从 plan 门禁到 red-test 门禁的顺序", async () => {
    await e2eLog.scenario(
      "execute 门禁顺序",
      "strict execute 模式下，先在 plan 证据前阻断生产写入，再在 red-test 证据前阻断生产写入。",
      async (log) => {
        log.step("创建 strict execute harness", "mode=strict 和 tdd=strict 应该在两个 execute 门禁上阻断写入")
        harness = await createOpencodeE2EHarness({
          workflowConfig: {
            mode: "strict",
            tdd: "strict",
          },
        })
        const requestId = "execute-gate-order"

        log.step("注册 execute mock 响应", "plan 前写入应该失败，plan 记录应该通过，red test 前写入应该再次失败")
        await harness.mock.expect([
          startCall(requestId, {
            request: "/sp-execute 实现批量任务视图",
            workflow: "feature",
            entrypoint: "execute",
          }),
          toolCall(requestId, "write", {
            filePath: "src/batch-task-view.ts",
            content: "export const batchTaskView = true\n",
          }),
          toolCall(requestId, "sp_report", {
            event: "plan",
            status: "passed",
            summary: "A concrete execution plan is recorded after the first gate rejection.",
            gates: {
              plan_written: true,
            },
            artifacts: {
              plan: "Plan: add failing view test, implement grouped rendering, run e2e verification.",
            },
          }),
          toolCall(requestId, "write", {
            filePath: "src/batch-task-view.ts",
            content: "export const batchTaskView = true\n",
          }),
          toolCall(requestId, "sp_report", {
            event: "red-test",
            status: "passed",
            summary: "A failing test now proves the intended behavior before production writes.",
            gates: {
              red_test_seen: true,
            },
            artifacts: {
              red_test_log: "FAIL batch-task-view.test.ts: renders queued and failed groups separately.",
            },
          }),
          textResponse(requestId, "execute gates enforced"),
        ])

        log.step("运行 opencode", "工具门禁应该产生两个独立的写入阻断错误")
        const result = await harness.runOpencode({
          title: "Execute gate order",
          timeoutMs: 60_000,
          message: `[e2e_trace_id:execute-gate-order] [llm_request_id:${requestId}] /sp-execute 实现批量任务视图`,
        })

        expect(result.code).toBe(0)
        log.verify("OpenCode 已在 strict execute 门禁恢复后成功退出")

        log.step("验证门禁错误顺序", "每次写入被阻断后的模型请求都应该包含对应门禁原因")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual(Array(6).fill(requestId))
        expect(JSON.stringify(requests[2]?.body)).toContain("plan_written gate is required before executing tasks")
        expect(JSON.stringify(requests[4]?.body)).toContain("red_test_seen gate is required before production code writes")
        expect(await harness.mock.pending()).toEqual([])
        log.verify("plan 门禁先于 TDD 门禁触发，两个错误都已返回给模型")

        log.step("验证局部 execute 状态", "plan 和 red_test 门禁应该为 true，implementation_done 仍应为空")
        const state = readLoggedWorkflowState(log, harness, "execute 门禁顺序处理完成后")
        logArtifactSnapshots(log, harness, ["plan", "red_test_log"])
        expect(state?.mode).toBe("execute")
        expect(state?.phase).toBe("red-test-recorded")
        expect(state?.gates.plan_written).toBe(true)
        expect(state?.gates.red_test_seen).toBe(true)
        expect(state?.gates.implementation_done).not.toBe(true)
        expect(harness.readArtifact("plan")).toContain("add failing view test")
        expect(harness.readArtifact("red_test_log")).toContain("batch-task-view.test.ts")
        log.verify("execute 状态只记录已被证明的门禁和证据产物")
      },
    )
  }, 70_000)

  test("super-agent 严格走 prepare-review-start 和完整执行链路", async () => {
    await e2eLog.scenario(
      "prepare 到 start 的完整链路",
      "super-agent 先路由和确认，再 prepare 生成正式计划，审查通过后调用 sp_start(run_id)，随后由插件驱动实现、评审、验证和结束节点。",
      async (log) => {
        log.step("创建启用子节点 prompt 的 harness", "需要记录 planner 和后续节点的真实任务 prompt")
        harness = await createOpencodeE2EHarness({ enableChildPrompts: true } as never)
        const routeRequestId = "feature-prepare-route"

        log.step("第一轮只查询状态和确认提示", "super-agent 应先检查当前 workflow，而不是直接进入实现")
        await harness.mock.expect([
          toolCall(routeRequestId, "sp_status", {}),
          textResponse(routeRequestId, "No active workflow. I need confirmation before prepare."),
        ])

        const routeResult = await harness.runOpencode({
          agent: "super-agent",
          title: "Feature route",
          message:
            "[e2e_trace_id:feature-prepare-route] [llm_request_id:feature-prepare-route] 给任务运行面板增加按状态筛选和批量重试确认流程",
        })

        expect(routeResult.code).toBe(0)
        expect(harness.readWorkflowState()).toBeNull()
        const routeRequests = await readLoggedMockRequests(log, harness)
        expect(routeRequests.map((request) => request.request_id)).toEqual([routeRequestId, routeRequestId])
        expect(await harness.mock.pending()).toEqual([])
        log.verify("首轮只查询状态，没有提前创建 workflow run")

        log.step("第二轮确认 prepare", "prepare 应创建 draft run，但不创建节点会话")
        await harness.mock.reset()
        const prepareRequestId = "feature-prepare-confirmed"
        await harness.mock.expect([
          toolCall(prepareRequestId, "sp_prepare", {
            request: "给任务运行面板增加按状态筛选和批量重试确认流程",
            workflow: "feature",
            entrypoint: "feature",
            proposal: [
              "# Superpowers Workflow Proposal",
              "",
              "Request: 给任务运行面板增加按状态筛选和批量重试确认流程",
              "",
              "I will run the feature workflow.",
              "",
              "Entrypoint: feature",
              "",
              "Next action: confirm to prepare the planning run.",
            ].join("\n"),
          }),
          textResponse(prepareRequestId, "The plan draft is ready for review. Confirm before calling sp_start."),
        ])

        const prepareResult = await harness.runOpencode({
          agent: "super-agent",
          title: "Feature prepare",
          timeoutMs: 60_000,
          message:
            "[e2e_trace_id:feature-prepare-confirmed] [llm_request_id:feature-prepare-confirmed] 已确认需求，请先准备正式计划。",
        })

        const prepareRequests = await readLoggedMockRequests(log, harness)
        expect(prepareResult.code).toBe(0)
        const preparedState = readLoggedWorkflowState(log, harness, "prepare 完成后")
        expect(preparedState?.activation).toBe("draft")
        expect(preparedState?.current_phase).toBe("plan")
        expect(preparedState?.node_runs).toEqual([])

        expect(prepareRequests.map((request) => request.request_id)).toEqual([
          prepareRequestId,
          prepareRequestId,
        ])
        expect(await harness.mock.pending()).toEqual([])

        const preparedRunID = preparedState?.id
        expect(preparedRunID).toBeTruthy()
        const prepareNodeHarness = withNodeAccess(harness)
        expect(prepareNodeHarness.listNodeIDs()).toEqual([])
        log.verify("draft workflow 已落盘，尚未创建节点会话")

        log.step("第三轮确认 start，并由插件接管执行链路", "sp_start(run_id) 后应依次完成 design、plan、implement、acceptance、verification、code-review、finish")
        await harness.mock.reset()
        const startRequestId = "feature-start-approved"
        await harness.mock.expect([
          toolCall(startRequestId, "sp_start", {
            run_id: preparedRunID,
          }),
          toolCall("node-001-design", "sp_report", {
            event: "design",
            status: "passed",
            summary: "The UI contract and interaction states are documented.",
            gates: {
              spec_written: true,
              design_approved: true,
            },
            artifacts: {
              spec: [
                "# Task run panel contract",
                "- Filter runs by queued, running, failed, and completed status.",
                "- Bulk retry requires a confirmation dialog with selected-count context.",
              ].join("\n"),
            },
          }),
          textResponse("node-001-design", "design recorded"),
          toolCall("node-002-plan", "sp_report", {
            event: "plan",
            status: "passed",
            summary: "The planner produced a concrete implementation plan and a single executable task.",
            gates: {
              plan_written: true,
            },
            artifacts: {
              plan: [
                "# Implementation Plan",
                "1. Add a status filter for queued, running, failed, and completed runs.",
                "2. Add a bulk retry confirmation dialog with selected-count context.",
                "3. Cover the filter and confirmation flow with regression tests.",
              ].join("\n"),
            },
            task_graph: {
              tasks: [
                {
                  id: "T1",
                  title: "Task run filter and retry confirmation",
                  summary: "Implement the filter model, confirmation interaction, and regression coverage.",
                  depends_on: [],
                  files: ["src/task-run-panel.tsx", "test/task-run-panel.test.tsx"],
                  test_commands: ["bun test test/task-run-panel.test.tsx"],
                },
              ],
            },
          }),
          textResponse("node-002-plan", "planner recorded the plan"),
          toolCall("node-003-implement-T1", "sp_report", {
            event: "implementation",
            status: "passed",
            summary: "The task run panel now filters by status and requires confirmation before bulk retry.",
            gates: {
              implementation_done: true,
            },
            artifacts: {
              patch_summary: [
                "- Added a status filter model for queued, running, failed, and completed task runs.",
                "- Added a bulk retry confirmation dialog that shows the selected run count before submission.",
                "- Added regression coverage for filter persistence and the retry confirmation path.",
              ].join("\n"),
            },
          }),
          textResponse("node-003-implement-T1", "implementation recorded"),
          toolCall("node-004-acceptance-T1", "sp_report", {
            event: "acceptance",
            status: "passed",
            summary: "The implementation satisfies the requested status filter and retry confirmation behavior.",
            gates: {
              acceptance_passed: true,
            },
            artifacts: {
              acceptance: "Reviewed the task panel behavior against the request and plan; no acceptance gaps remain.",
            },
          }),
          textResponse("node-004-acceptance-T1", "acceptance recorded"),
          toolCall("node-005-verification-T1", "sp_report", {
            event: "verification",
            status: "passed",
            summary: "Fresh verification passed after the final implementation change.",
            gates: {
              verification_fresh: true,
            },
            artifacts: {
              verification_log: "bun test test/task-run-panel.test.tsx && bun run test:e2e:opencode passed.",
            },
          }),
          textResponse("node-005-verification-T1", "verification recorded"),
          toolCall("node-006-code-review-T1", "sp_report", {
            event: "code-review",
            status: "passed",
            summary: "No blocking code quality issues remain in the filter state or retry confirmation flow.",
            gates: {
              code_review_passed: true,
            },
            artifacts: {
              code_review: "Checked state transitions, dialog confirmation behavior, and regression coverage. No blockers.",
            },
          }),
          textResponse("node-006-code-review-T1", "code review recorded"),
          toolCall("node-007-finish", "sp_report", {
            event: "finish",
            status: "passed",
            summary: "The workflow is ready for delivery after fresh verification.",
            artifacts: {
              finish_note: "Ready to deliver the task panel filter and bulk retry confirmation flow.",
            },
          }),
          textResponse("node-007-finish", "finish recorded"),
          textResponse(startRequestId, "Execution has started and the workflow completed cleanly."),
        ])

        const startResult = await harness.runOpencode({
          agent: "super-agent",
          title: "Feature start",
          timeoutMs: 90_000,
          message:
            "[e2e_trace_id:feature-start-approved] [llm_request_id:feature-start-approved] 计划确认无误，现在开始执行。",
        })

        const startRequests = await readLoggedMockRequests(log, harness)
        expect(startResult.code).toBe(0)
        expect(startRequests.map((request) => request.request_id)).toEqual([
          startRequestId,
          "node-001-design",
          "node-002-plan",
          "node-003-implement-T1",
          "node-004-acceptance-T1",
          "node-005-verification-T1",
          "node-006-code-review-T1",
          "node-007-finish",
          "node-007-finish",
          "node-006-code-review-T1",
          "node-005-verification-T1",
          "node-004-acceptance-T1",
          "node-003-implement-T1",
          "node-002-plan",
          "node-001-design",
          startRequestId,
        ])
        expect(await harness.mock.pending()).toEqual([])

        const finishedState = readLoggedWorkflowState(log, harness, "完整链路完成后")
        expect(finishedState?.activation).toBe("active")
        expect(finishedState?.phase).toBe("finished")
        expect(finishedState?.status).toBe("passed")
        expect(finishedState?.history.map((entry) => entry.event)).toEqual([
          "created",
          "design",
          "plan",
          "implementation",
          "acceptance",
          "verification",
          "code-review",
          "finish",
        ])
        logArtifactSnapshots(log, harness, ["spec", "plan", "patch_summary", "acceptance", "code_review", "verification_log"])
        expect(harness.readArtifact("verification_log")).toContain("bun run test:e2e:opencode passed")

        const startedNodeHarness = withNodeAccess(harness)
        expect(startedNodeHarness.listNodeIDs()).toEqual([
          "001-design",
          "002-plan",
          "003-implement-T1",
          "004-acceptance-T1",
          "005-verification-T1",
          "006-code-review-T1",
          "007-finish",
        ])
        expect(startedNodeHarness.readNodeTask("003-implement-T1")).toContain("Execute task T1.")
        expect(startedNodeHarness.readNodeTask("003-implement-T1")).toContain("Primary skill: superpowers-test-driven-development")
        expect(startedNodeHarness.readNodeRecord("003-implement-T1")).toMatchObject({
          event: "implementation",
          status: "passed",
        })
        expect(startedNodeHarness.readNodeRecord("005-verification-T1")).toMatchObject({
          event: "verification",
          status: "passed",
        })
        log.verify("super-agent 只负责管控，prepare-review-start 之后由插件按预期节点链路完成执行")
      },
    )
  }, 120_000)
})

function toolCall(requestId: string, name: string, args: Record<string, unknown>): MockLlmExpectation {
  return {
    request_id: requestId,
    response: {
      type: "tool_call",
      name,
      arguments: args,
    },
  }
}

function startCall(
  requestId: string,
  args: { request: string; workflow: string; entrypoint: string },
): MockLlmExpectation {
  return toolCall(requestId, "sp_start", {
    ...args,
    proposal: [
      "# Superpowers Workflow Proposal",
      "",
      `Request: ${args.request}`,
      "",
      `I will run the ${args.workflow} workflow.`,
      "",
      `Entrypoint: ${args.entrypoint}`,
      "",
      "Next action: confirm to start the run.",
    ].join("\n"),
  })
}

function textResponse(requestId: string, content: string): MockLlmExpectation {
  return {
    request_id: requestId,
    response: {
      type: "text",
      content,
    },
  }
}

async function readLoggedMockRequests(log: E2EScenarioLogger, harness: OpencodeE2EHarness) {
  const requests = await harness.mock.requests()
  log.mockInteractions(requests)
  return requests
}

function readLoggedWorkflowState(log: E2EScenarioLogger, harness: OpencodeE2EHarness, label: string) {
  const state = harness.readWorkflowState()
  log.stateSnapshot(label, state)
  return state
}

function logArtifactSnapshots(log: E2EScenarioLogger, harness: OpencodeE2EHarness, names: string[]): void {
  for (const name of names) {
    log.artifactSnapshot(name, harness.readArtifact(name))
  }
}

function logLastArtifactSnapshots(log: E2EScenarioLogger, harness: OpencodeE2EHarness, names: string[]): void {
  for (const name of names) {
    log.artifactSnapshot(name, harness.readLastArtifact(name))
  }
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
