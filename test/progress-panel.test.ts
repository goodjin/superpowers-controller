import { describe, expect, test } from "bun:test"
import {
  buildProgressPanelViewModel,
  renderCompactProgressText,
  renderProgressPanelText,
  renderRunningSessionsText,
  renderSidebarProgressText,
  renderWorkflowStatusText,
} from "../src/tui/progress-panel"
import type { NodeProgressEntry } from "../src/progress/node-progress"
import type { WorkflowState } from "../src/state/types"

describe("progress panel view model", () => {
  test("renders an empty state when no workflow is active", () => {
    const model = buildProgressPanelViewModel(null, {}, {})

    expect(model).toEqual({
      active: false,
      title: "Superpowers Progress",
      summary: "No active Superpowers workflow.",
      rows: [],
      tasks: [],
    })
    expect(renderProgressPanelText(model)).toContain("No active Superpowers workflow.")
  })

  test("summarizes active node runs with latest stored progress and live session status", () => {
    const state: WorkflowState = {
      id: "run-1",
      project: "/repo",
      session: "session-main",
      parent_session_id: "session-main",
      activation: "active",
      workflow: "feature",
      entrypoint: "execute",
      limited_context: true,
      mode: "execute",
      phase: "implement",
      current_phase: "implement",
      status: "running",
      goal: "Implement feature",
      created_at: "2026-06-19T00:00:00.000Z",
      updated_at: "2026-06-19T00:00:00.000Z",
      gates: {},
      artifacts: {},
      task_graph: {
        tasks: [
          {
            id: "T1",
            title: "Implement progress surface",
            summary: "Show progress in TUI",
            depends_on: [],
          },
          {
            id: "T2",
            title: "Document progress surface",
            summary: "Update module docs",
            depends_on: ["T1"],
          },
        ],
      },
      node_runs: [
        {
          id: "001-implement-T1",
          task_id: "T1",
          phase: "implement",
          agent: "sp-implementer",
          primary_skill: "superpowers-test-driven-development",
          session_id: "session-child",
          status: "running",
          attempts: 1,
          started_at: "2026-06-19T00:00:00.000Z",
        },
      ],
      history: [{ at: "2026-06-19T00:00:00.000Z", event: "created", to: "feature" }],
    }
    const latest: NodeProgressEntry = {
      at: "2026-06-19T00:01:00.000Z",
      kind: "tool_running",
      session_id: "session-child",
      node_id: "001-implement-T1",
      agent: "sp-implementer",
      phase: "implement",
      task_id: "T1",
      summary: "bash running",
      detail: "bun run test",
    }

    const model = buildProgressPanelViewModel(
      state,
      {
        "001-implement-T1": [latest],
      },
      {
        "session-child": "busy",
      },
      new Date("2026-06-19T00:01:05.000Z"),
    )

    expect(model).toMatchObject({
      active: true,
      title: "Superpowers Progress",
      summary: "feature run run-1 is running at implement.",
      workflow: "feature",
      status: "running",
      current_phase: "implement",
      tasks: [
        {
          task_id: "T1",
          title: "Implement progress surface",
          status: "running",
        },
        {
          task_id: "T2",
          title: "Document progress surface",
          status: "pending",
        },
      ],
      rows: [
        {
          node_id: "001-implement-T1",
          task_id: "T1",
          agent: "sp-implementer",
          phase: "implement",
          durable_status: "running",
          activity_status: "active",
          session_id: "session-child",
          live_status: "busy",
          latest_summary: "bash running",
          latest_detail: "bun run test",
          observed_age: "5s ago",
        },
      ],
    })
    const text = renderProgressPanelText(model)
    expect(text).toContain("feature run run-1 is running at implement.")
    expect(text).toContain("001-implement-T1")
    expect(text).toContain("bash running")
    expect(renderCompactProgressText(model)).toBe("SP: sp-implementer T1 running - bash running")
    expect(renderCompactProgressText(model, 44)).toBe("SP: sp-implementer T1 running - bash running")
    expect(renderWorkflowStatusText(model, 160)).toBe("SP: feature running@implement | tasks 0/2 done | sessions 1 running | sp-implementer T1 running - bash running (5s ago)")
    expect(renderRunningSessionsText(model)).toContain("sp-implementer T1: running - bash running")
    expect(renderSidebarProgressText(model)).toBe([
      "SP: feature running@implement | tasks 0/2 done | sessions 1 running | sp-implementer T1 running - bash running (5s ago)",
      "running",
      "sp-implementer T1: running - bash running (5s ago)\n  bun run test",
    ].join("\n"))
  })

  test("session idle does not hide the latest meaningful child activity", () => {
    const state: WorkflowState = {
      id: "run-1",
      project: "/repo",
      session: "session-main",
      parent_session_id: "session-main",
      activation: "active",
      workflow: "feature",
      entrypoint: "execute",
      limited_context: true,
      mode: "execute",
      phase: "implement",
      current_phase: "implement",
      status: "running",
      goal: "Implement feature",
      created_at: "2026-06-19T00:00:00.000Z",
      updated_at: "2026-06-19T00:00:00.000Z",
      gates: {},
      artifacts: {},
      node_runs: [
        {
          id: "001-implement-T1",
          task_id: "T1",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "session-child",
          status: "running",
          attempts: 1,
          started_at: "2026-06-19T00:00:00.000Z",
        },
      ],
      history: [{ at: "2026-06-19T00:00:00.000Z", event: "created", to: "feature" }],
    }
    const progress: NodeProgressEntry[] = [
      {
        at: "2026-06-19T00:00:10.000Z",
        kind: "text",
        session_id: "session-child",
        node_id: "001-implement-T1",
        agent: "sp-implementer",
        phase: "implement",
        task_id: "T1",
        summary: "assistant text updated",
        detail: "Working on database migration.",
      },
      {
        at: "2026-06-19T00:00:15.000Z",
        kind: "session_idle",
        session_id: "session-child",
        node_id: "001-implement-T1",
        agent: "sp-implementer",
        phase: "implement",
        task_id: "T1",
        summary: "session idle",
      },
    ]

    const model = buildProgressPanelViewModel(
      state,
      { "001-implement-T1": progress },
      { "session-child": "idle" },
      new Date("2026-06-19T00:00:20.000Z"),
    )

    expect(model.rows[0]?.latest_summary).toBe("assistant text updated")
    expect(model.rows[0]?.latest_detail).toBe("Working on database migration.")
    expect(model.rows[0]?.observed_age).toBe("5s ago")
    expect(renderWorkflowStatusText(model, 160)).toContain("assistant text updated (5s ago)")
    expect(renderSidebarProgressText(model)).toContain("Working on database migration.")
    expect(renderSidebarProgressText(model)).not.toContain("session idle")
  })

  test("marks stale running child progress as stalled", () => {
    const state: WorkflowState = {
      id: "run-1",
      project: "/repo",
      session: "session-main",
      parent_session_id: "session-main",
      activation: "active",
      workflow: "feature",
      entrypoint: "execute",
      limited_context: true,
      mode: "execute",
      phase: "implement",
      current_phase: "implement",
      status: "running",
      goal: "Implement feature",
      created_at: "2026-06-19T00:00:00.000Z",
      updated_at: "2026-06-19T00:00:00.000Z",
      gates: {},
      artifacts: {},
      node_runs: [
        {
          id: "030-acceptance",
          phase: "acceptance",
          agent: "sp-acceptance-reviewer",
          session_id: "session-review",
          status: "running",
          attempts: 1,
          started_at: "2026-06-19T00:00:00.000Z",
        },
      ],
      history: [{ at: "2026-06-19T00:00:00.000Z", event: "created", to: "feature" }],
    }
    const latest: NodeProgressEntry = {
      at: "2026-06-19T00:00:20.000Z",
      kind: "tool_pending",
      session_id: "session-review",
      node_id: "030-acceptance",
      agent: "sp-acceptance-reviewer",
      phase: "acceptance",
      summary: "write pending",
    }

    const model = buildProgressPanelViewModel(
      state,
      { "030-acceptance": [latest] },
      { "session-review": "busy" },
      new Date("2026-06-19T00:01:00.000Z"),
    )

    expect(model.rows[0]?.activity_status).toBe("stalled")
    expect(renderProgressPanelText(model)).toContain("status: stalled")
    expect(renderProgressPanelText(model)).toContain("live: busy")
    expect(renderCompactProgressText(model)).toBe("SP: sp-acceptance-reviewer stalled - write pending")
    expect(renderWorkflowStatusText(model, 140)).toBe("SP: feature running@implement | nodes 1 | sessions 1 stalled | sp-acceptance-reviewer stalled - write pending (40s ago)")
  })

  test("sidebar progress surfaces waiting-user questions and options", () => {
    const state: WorkflowState = {
      id: "run-1",
      project: "/repo",
      session: "session-main",
      parent_session_id: "session-main",
      activation: "active",
      workflow: "feature",
      entrypoint: "design",
      limited_context: false,
      mode: "design",
      phase: "waiting-user",
      current_phase: "waiting-user",
      status: "waiting_user",
      goal: "Design auth",
      created_at: "2026-06-19T00:00:00.000Z",
      updated_at: "2026-06-19T00:01:00.000Z",
      gates: {},
      artifacts: {},
      pending_question: {
        prompt: "确认 Section 3 后端端点设计？",
        source_node_id: "001-design",
        options: [
          { label: "认可 Section 3", description: "继续 Section 4" },
          { label: "认可但调整", description: "修改端点细节" },
        ],
      },
      node_runs: [
        {
          id: "001-design",
          phase: "design",
          agent: "sp-designer",
          session_id: "session-design",
          status: "needs_user",
          attempts: 1,
          started_at: "2026-06-19T00:00:00.000Z",
          reported_at: "2026-06-19T00:01:00.000Z",
        },
      ],
      history: [{ at: "2026-06-19T00:00:00.000Z", event: "created", to: "feature" }],
    }
    const model = buildProgressPanelViewModel(
      state,
      {
        "001-design": [{
          at: "2026-06-19T00:01:05.000Z",
          kind: "text",
          session_id: "session-design",
          node_id: "001-design",
          agent: "sp-designer",
          phase: "design",
          summary: "assistant text updated",
          detail: "Report accepted. Waiting for Section 3 confirmation.",
        }],
      },
      { "session-design": "idle" },
      new Date("2026-06-19T00:01:10.000Z"),
    )

    const sidebar = renderSidebarProgressText(model)
    expect(renderWorkflowStatusText(model, 160)).toContain("waiting user")
    expect(sidebar).toContain("waiting user")
    expect(sidebar).toContain("source: 001-design")
    expect(sidebar).toContain("question: 确认 Section 3 后端端点设计？")
    expect(sidebar).toContain("- 认可 Section 3: 继续 Section 4")
    expect(sidebar).toContain("Report accepted. Waiting for Section 3 confirmation.")
  })

  test("sidebar progress explains an active workflow before node dispatch", () => {
    const state: WorkflowState = {
      id: "run-1",
      project: "/repo",
      session: "session-main",
      parent_session_id: "session-main",
      activation: "active",
      workflow: "feature",
      entrypoint: "feature",
      limited_context: false,
      mode: "design",
      phase: "intake",
      current_phase: "intake",
      status: "intake",
      goal: "Implement feature",
      created_at: "2026-06-19T00:00:00.000Z",
      updated_at: "2026-06-19T00:00:00.000Z",
      gates: {},
      artifacts: {},
      node_runs: [],
      history: [{ at: "2026-06-19T00:00:00.000Z", event: "created", to: "feature" }],
    }

    const model = buildProgressPanelViewModel(state, {}, {})

    expect(renderSidebarProgressText(model)).toBe([
      "SP: feature intake@intake | nodes 0 | sessions 0 running",
      "waiting for node dispatch",
    ].join("\n"))
  })

  test("prefers the latest running retry node over an interrupted old node", () => {
    const state: WorkflowState = {
      id: "run-1",
      project: "/repo",
      session: "session-main",
      parent_session_id: "session-main",
      activation: "active",
      workflow: "feature",
      entrypoint: "execute",
      limited_context: true,
      mode: "execute",
      phase: "implement",
      current_phase: "implement",
      status: "running",
      goal: "Implement feature",
      created_at: "2026-06-19T00:00:00.000Z",
      updated_at: "2026-06-19T00:02:00.000Z",
      gates: {},
      artifacts: {},
      task_graph: {
        tasks: [{ id: "T3", title: "Retry implementation", summary: "Retry T3", depends_on: [] }],
      },
      node_runs: [
        {
          id: "011-implement-T3",
          task_id: "T3",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "session-old",
          status: "interrupted",
          attempts: 1,
          started_at: "2026-06-19T00:00:00.000Z",
          ended_at: "2026-06-19T00:01:00.000Z",
          closed_at: "2026-06-19T00:01:00.000Z",
        },
        {
          id: "012-implement-T3-retry-2",
          task_id: "T3",
          phase: "implement",
          agent: "sp-implementer",
          session_id: "session-new",
          status: "running",
          attempts: 2,
          started_at: "2026-06-19T00:02:00.000Z",
        },
      ],
      history: [{ at: "2026-06-19T00:00:00.000Z", event: "created", to: "feature" }],
    }
    const model = buildProgressPanelViewModel(
      state,
      {
        "011-implement-T3": [{
          at: "2026-06-19T00:01:00.000Z",
          kind: "session_error",
          session_id: "session-old",
          node_id: "011-implement-T3",
          agent: "sp-implementer",
          phase: "implement",
          task_id: "T3",
          summary: "session error: Aborted",
        }],
        "012-implement-T3-retry-2": [{
          at: "2026-06-19T00:02:05.000Z",
          kind: "tool_running",
          session_id: "session-new",
          node_id: "012-implement-T3-retry-2",
          agent: "sp-implementer",
          phase: "implement",
          task_id: "T3",
          summary: "bash running",
        }],
      },
      { "session-new": "busy" },
      new Date("2026-06-19T00:02:10.000Z"),
    )

    expect(renderCompactProgressText(model)).toBe("SP: sp-implementer T3 running - bash running")
    expect(renderSidebarProgressText(model)).toContain("sp-implementer T3: running - bash running")
    expect(renderSidebarProgressText(model)).not.toContain("session error: Aborted")
    expect(model.tasks[0]?.status).toBe("running")
  })
})
