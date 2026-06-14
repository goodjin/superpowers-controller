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
  test("通过 sp_route 和 sp_record 记录 debug 根因", async () => {
    await e2eLog.scenario(
      "debug 根因记录",
      "路由一个 debug 任务，记录 root cause 产物，并验证持久化工作流状态。",
      async (log) => {
        log.step("创建隔离 OpenCode harness", "插件从 dist 加载，项目状态只写入临时目录")
        harness = await createOpencodeE2EHarness()
        const requestId = "debug-root-cause"

        log.step("注册 mock LLM 响应", "同一个 request_id 依次驱动 sp_route、sp_record 和最终文本响应")
        await harness.mock.expect([
          {
            request_id: requestId,
            response: {
              type: "tool_call",
              name: "sp_route",
              arguments: {
                request: "/sp-debug 修复失败测试",
                command: "/sp-debug",
              },
            },
          },
          startCall(requestId, {
            request: "/sp-debug 修复失败测试",
            workflow: "debug",
            entrypoint: "debug",
          }),
          {
            request_id: requestId,
            response: {
              type: "tool_call",
              name: "sp_record",
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
          message: `[e2e_trace_id:debug-root-cause] [llm_request_id:${requestId}] /sp-debug 修复失败测试`,
        })

        expect(result.code).toBe(0)
        expect(result.error).toBeUndefined()
        log.verify("OpenCode 已完成 debug tool-call 循环并成功退出")

        log.step("验证 mock 模型请求", "四次模型调用应该按 FIFO 消费同一个 request_id 队列")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual(Array(4).fill(requestId))
        expect(await harness.mock.pending()).toEqual([])
        log.verify("mock LLM 已消费全部 debug 预设响应，且没有剩余响应")

        log.step("验证工作流状态和产物", "debug 模式应该持久化 root_cause_found 和 root_cause.md")
        const state = readLoggedWorkflowState(log, harness, "debug 响应处理完成后")
        logArtifactSnapshots(log, harness, ["root_cause"])
        expect(state?.mode).toBe("debug")
        expect(state?.phase).toBe("root-cause-found")
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

        log.step("注册 mock LLM 响应", "先路由 debug，再在 root cause 前尝试写入，最后在工具错误后结束")
        await harness.mock.expect([
          toolCall(requestId, "sp_route", {
            request: "/sp-debug 修复失败测试",
            command: "/sp-debug",
          }),
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
        expect(requests.map((request) => request.request_id)).toEqual(Array(4).fill(requestId))
        expect(JSON.stringify(requests[3]?.body)).toContain("root_cause_found gate is required before repair writes")
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

  test("记录从 design 到 fresh verification 的完整 feature 生命周期", async () => {
    await e2eLog.scenario(
      "feature 完整生命周期",
      "在一条长 workflow 中记录 design/spec、plan、red test、implementation、review 和 fresh verification。",
      async (log) => {
        log.step("创建隔离 OpenCode harness", "默认 guided 配置应该允许长 feature 生命周期持续记录证据")
        harness = await createOpencodeE2EHarness()
        const requestId = "feature-full-lifecycle"

        log.step("注册生命周期 mock 响应", "模型请求应该完成 proposal、start、两个 implementer、串行 review、verification、finish 和 reset")
        await harness.mock.expect([
          toolCall(requestId, "sp_route", {
            request: "/sp-design 增加批量任务运行视图",
            command: "/sp-design",
          }),
          startCall(requestId, {
            request: "/sp-design 增加批量任务运行视图",
            workflow: "feature",
            entrypoint: "feature",
          }),
          toolCall(requestId, "sp_record", {
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
          toolCall(requestId, "sp_record", {
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
            task_graph: {
              tasks: [
                { id: "task-state", title: "State loading", summary: "Load task run state.", depends_on: [], files: ["src/task-run-state.ts"] },
                { id: "task-actions", title: "Retry actions", summary: "Add retry and cancel actions.", depends_on: [], files: ["src/task-run-actions.ts"] },
              ],
            },
          }),
          toolCall(requestId, "sp_record", {
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
          toolCall(requestId, "sp_record", {
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
          toolCall(requestId, "sp_record", {
            event: "spec-review",
            status: "passed",
            summary: "Spec review passed for grouped rendering and retry controls.",
            gates: {
              spec_review_passed: true,
            },
            artifacts: {
              spec_review: "Spec review passed: behavior matches the documented UI contract.",
            },
          }),
          toolCall(requestId, "sp_record", {
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
          toolCall(requestId, "sp_record", {
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
          toolCall(requestId, "sp_record", {
            event: "finish",
            status: "passed",
            summary: "The feature workflow is ready to archive.",
            artifacts: {
              finish_note: "Ready after review and verification.",
            },
          }),
          toolCall(requestId, "sp_reset", {}),
          textResponse(requestId, "feature lifecycle recorded"),
        ])

        log.step("运行 opencode", "完整生命周期应该通过多次 sp_record 工具调用完成")
        const result = await harness.runOpencode({
          title: "Feature lifecycle",
          timeoutMs: 60_000,
          message: `[e2e_trace_id:feature-full-lifecycle] [llm_request_id:${requestId}] /sp-design 增加批量任务运行视图`,
        })

        expect(result.code).toBe(0)
        expect(result.error).toBeUndefined()
        log.verify("OpenCode 已完成全部生命周期轮次并成功退出")

        log.step("验证 mock 模型请求", "十二轮调用应该消费同一个 request_id，且没有剩余预设响应")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual(Array(12).fill(requestId))
        expect(await harness.mock.pending()).toEqual([])
        log.verify("全部生命周期预设响应已按顺序消费")

        log.step("验证最终生命周期状态", "所有关键门禁应该为 true，history 应该保留节点顺序")
        const currentAfterReset = readLoggedWorkflowState(log, harness, "feature 生命周期 reset 后")
        expect(currentAfterReset).toBeNull()
        const state = harness.readLastWorkflowState()
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
          spec_review_passed: true,
          code_review_passed: true,
          verification_fresh: true,
        })
        expect(state?.history.map((entry) => entry.event)).toEqual([
          "created",
          "design",
          "plan",
          "implementation",
          "implementation",
          "spec-review",
          "code-review",
          "verification",
          "finish",
        ])
        expect(state?.node_runs.filter((node) => node.agent === "sp-implementer")).toHaveLength(2)
        expect(state?.node_runs.some((node) => node.agent === "sp-spec-reviewer")).toBe(true)
        expect(state?.node_runs.some((node) => node.agent === "sp-code-reviewer")).toBe(true)
        expect(state?.node_runs.some((node) => node.agent === "sp-verifier")).toBe(true)
        expect(state?.node_runs.some((node) => node.agent === "sp-finisher")).toBe(true)
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

  test("暴露缺少产物的校验错误并通过有效记录恢复", async () => {
    await e2eLog.scenario(
      "sp_record 校验失败后恢复",
      "先拒绝缺少必需产物的门禁更新，再通过补充产物恢复。",
      async (log) => {
        log.step("创建隔离 OpenCode harness", "默认配置下仍应该强制执行 sp_record 产物校验")
        harness = await createOpencodeE2EHarness()
        const requestId = "record-validation-recovery"

        log.step("注册恢复流程 mock 响应", "第一次 sp_record 故意缺少 plan，第二次 sp_record 补充 plan")
        await harness.mock.expect([
          toolCall(requestId, "sp_route", {
            request: "/sp-plan 拆解重试调度器改造",
            command: "/sp-plan",
          }),
          startCall(requestId, {
            request: "/sp-plan 拆解重试调度器改造",
            workflow: "plan-only",
            entrypoint: "plan-only",
          }),
          toolCall(requestId, "sp_record", {
            event: "plan",
            status: "passed",
            summary: "This intentionally omits the plan artifact so validation should fail.",
            gates: {
              plan_written: true,
            },
          }),
          toolCall(requestId, "sp_record", {
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
        expect(requests.map((request) => request.request_id)).toEqual(Array(5).fill(requestId))
        expect(JSON.stringify(requests[3]?.body)).toContain("plan_written requires plan artifact")
        expect(await harness.mock.pending()).toEqual([])
        log.verify("缺少产物的错误已在有效重试前返回给模型")

        log.step("验证恢复后的状态", "状态历史中应该只出现成功的 plan 记录")
        const state = readLoggedWorkflowState(log, harness, "sp_record 校验失败并恢复后")
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
          toolCall(requestId, "sp_route", {
            request: "/sp-verify-finish 完成调度器修复",
            command: "/sp-verify-finish",
          }),
          startCall(requestId, {
            request: "/sp-verify-finish 完成调度器修复",
            workflow: "verify-finish",
            entrypoint: "verify-finish",
          }),
          toolCall(requestId, "sp_record", {
            event: "finish",
            status: "passed",
            summary: "This completion should be rejected because fresh verification is missing.",
          }),
          toolCall(requestId, "sp_record", {
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
          toolCall(requestId, "sp_record", {
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
        expect(requests.map((request) => request.request_id)).toEqual(Array(6).fill(requestId))
        expect(JSON.stringify(requests[3]?.body)).toContain("verification_fresh is required before completion records")
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
        log.step("创建隔离 OpenCode harness", "routeWorkflow 应该先读取当前 waiting 状态，再分类新请求")
        harness = await createOpencodeE2EHarness()
        const requestId = "active-waiting-reroute"

        log.step("注册重路由 mock 响应", "debug 路由先记录 waiting 状态，再用偏实现的新请求调用 sp_route")
        await harness.mock.expect([
          toolCall(requestId, "sp_route", {
            request: "/sp-debug 修复间歇性失败",
            command: "/sp-debug",
          }),
          startCall(requestId, {
            request: "/sp-debug 修复间歇性失败",
            workflow: "debug",
            entrypoint: "debug",
          }),
          toolCall(requestId, "sp_record", {
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
          toolCall(requestId, "sp_route", {
            request: "现在直接实现一个新的批量运行功能",
          }),
          textResponse(requestId, "active workflow preserved"),
        ])

        log.step("运行 opencode", "第二次 route 应该返回 active waiting workflow，而不是启动 feature run")
        const result = await harness.runOpencode({
          title: "Active waiting reroute",
          timeoutMs: 60_000,
          message: `[e2e_trace_id:active-waiting-reroute] [llm_request_id:${requestId}] /sp-debug 修复间歇性失败`,
        })

        expect(result.code).toBe(0)
        log.verify("OpenCode 已在活动状态路由检查后成功退出")

        log.step("验证路由结果返回给模型", "最终模型请求应该包含 active workflow is waiting")
        const requests = await readLoggedMockRequests(log, harness)
        expect(requests.map((request) => request.request_id)).toEqual(Array(5).fill(requestId))
        expect(JSON.stringify(requests[4]?.body)).toContain("confirm_resume")
        expect(JSON.stringify(requests[4]?.body)).toContain("waiting-user")
        expect(await harness.mock.pending()).toEqual([])
        log.verify("第二次 route 保留了等待中的 debug workflow")

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
          toolCall(requestId, "sp_route", {
            request: "/sp-execute 实现批量任务视图",
            command: "/sp-execute",
          }),
          startCall(requestId, {
            request: "/sp-execute 实现批量任务视图",
            workflow: "feature",
            entrypoint: "execute",
          }),
          toolCall(requestId, "write", {
            filePath: "src/batch-task-view.ts",
            content: "export const batchTaskView = true\n",
          }),
          toolCall(requestId, "sp_record", {
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
          toolCall(requestId, "sp_record", {
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
        expect(requests.map((request) => request.request_id)).toEqual(Array(7).fill(requestId))
        expect(JSON.stringify(requests[3]?.body)).toContain("plan_written gate is required before executing tasks")
        expect(JSON.stringify(requests[5]?.body)).toContain("red_test_seen gate is required before production code writes")
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
