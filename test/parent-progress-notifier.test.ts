import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createNodeProgressStore } from "../src/progress/node-progress"
import { createParentProgressNotifier } from "../src/session/parent-progress-notifier"
import type { ProgressUpdate } from "../src/progress/reporter"
import type { SessionAdapter } from "../src/session/adapter"
import type { WorkflowState } from "../src/state/types"

describe("parent progress notifier", () => {
  test("publishes progress without appending a parent-session prompt", async () => {
    const project = tempProject()
    try {
      const state = runningState(project)
      createNodeProgressStore(project).append(state.id, {
        at: "2026-07-02T00:00:10.000Z",
        kind: "tool_running",
        session_id: "session-child",
        node_id: "001-implement-T1",
        agent: "sp-implementer",
        phase: "implement",
        task_id: "T1",
        summary: "bash running",
        detail: "bun test test/session-orchestrator.test.ts",
      })
      const timer = createManualTimer()
      const prompts: Array<{ sessionID: string; agent: string; prompt: string }> = []
      const progress: ProgressUpdate[] = []
      const notifier = createParentProgressNotifier(adapterWithPrompts(prompts, progress), {
        timer,
        now: () => new Date("2026-07-02T00:00:30.000Z"),
      })

      notifier.start({
        project,
        runID: state.id,
        readState: () => state,
      })
      expect(timer.intervals()).toEqual([10_000])
      await timer.tick()

      expect(prompts).toEqual([])
      expect(progress).toHaveLength(1)
      expect(progress[0]).toMatchObject({
        stage: "parent_progress",
        title: "Superpowers workflow",
        variant: "info",
      })
      expect(progress[0]?.message).toContain("tasks 0/1 done")
      expect(progress[0]?.message).toContain("sp-implementer T1 running - bash running")
      expect(progress[0]?.message).toContain("bun test test/session-orchestrator.test.ts")
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("does not create duplicate timers for the same run", async () => {
    const project = tempProject()
    try {
      const state = runningState(project)
      const timer = createManualTimer()
      const prompts: Array<{ sessionID: string; agent: string; prompt: string }> = []
      const progress: ProgressUpdate[] = []
      const notifier = createParentProgressNotifier(adapterWithPrompts(prompts, progress), { timer })

      notifier.start({ project, runID: state.id, readState: () => state })
      notifier.start({ project, runID: state.id, readState: () => state })
      await timer.tick()

      expect(timer.activeCount()).toBe(1)
      expect(prompts).toEqual([])
      expect(progress).toHaveLength(1)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("does not republish unchanged progress on later ticks", async () => {
    const project = tempProject()
    try {
      const state = runningState(project)
      createNodeProgressStore(project).append(state.id, {
        at: "2026-07-02T00:00:10.000Z",
        kind: "tool_running",
        session_id: "session-child",
        node_id: "001-implement-T1",
        agent: "sp-implementer",
        phase: "implement",
        task_id: "T1",
        summary: "bash running",
      })
      const timer = createManualTimer()
      let now = new Date("2026-07-02T00:00:40.000Z")
      const prompts: Array<{ sessionID: string; agent: string; prompt: string }> = []
      const progress: ProgressUpdate[] = []
      const notifier = createParentProgressNotifier(adapterWithPrompts(prompts, progress), {
        timer,
        now: () => now,
      })

      notifier.start({ project, runID: state.id, readState: () => state })
      await timer.tick()
      now = new Date("2026-07-02T00:00:50.000Z")
      await timer.tick()

      expect(prompts).toEqual([])
      expect(progress).toHaveLength(1)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("stops without sending when the workflow is no longer actively running child sessions", async () => {
    const project = tempProject()
    try {
      let state = runningState(project)
      const timer = createManualTimer()
      const prompts: Array<{ sessionID: string; agent: string; prompt: string }> = []
      const progress: ProgressUpdate[] = []
      const notifier = createParentProgressNotifier(adapterWithPrompts(prompts, progress), { timer })

      notifier.start({ project, runID: state.id, readState: () => state })
      state = {
        ...state,
        status: "waiting_user",
        node_runs: state.node_runs.map((node) => ({ ...node, status: "needs_user" })),
      }
      await timer.tick()

      expect(prompts).toEqual([])
      expect(progress).toEqual([])
      expect(timer.activeCount()).toBe(0)
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("does not start for foreground serial design and plan child sessions", async () => {
    const project = tempProject()
    try {
      const timer = createManualTimer()
      const prompts: Array<{ sessionID: string; agent: string; prompt: string }> = []
      const progress: ProgressUpdate[] = []
      const notifier = createParentProgressNotifier(adapterWithPrompts(prompts, progress), { timer })
      const state = {
        ...runningState(project),
        current_phase: "design",
        node_runs: [
          {
            id: "001-design",
            phase: "design",
            agent: "sp-designer",
            primary_skill: "superpowers-brainstorming",
            session_id: "session-design",
            status: "running" as const,
            attempts: 1,
            started_at: "2026-07-02T00:00:00.000Z",
          },
          {
            id: "002-plan",
            phase: "plan",
            agent: "sp-planner",
            primary_skill: "superpowers-writing-plans",
            session_id: "session-plan",
            status: "running" as const,
            attempts: 1,
            started_at: "2026-07-02T00:00:00.000Z",
          },
        ],
      }

      notifier.start({ project, runID: state.id, readState: () => state })
      await timer.tick()

      expect(timer.activeCount()).toBe(0)
      expect(prompts).toEqual([])
      expect(progress).toEqual([])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})

function tempProject(): string {
  const project = join(tmpdir(), `sp-parent-progress-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  mkdirSync(project, { recursive: true })
  return project
}

function adapterWithPrompts(
  prompts: Array<{ sessionID: string; agent: string; prompt: string }>,
  progress: ProgressUpdate[],
): SessionAdapter {
  return {
    async createNodeSession() {
      return "session-child"
    },
    async continueNodeSession(input) {
      prompts.push(input)
    },
    async showProgress(input) {
      progress.push(input)
    },
  }
}

function createManualTimer() {
  let nextID = 1
  const callbacks = new Map<number, () => void | Promise<void>>()
  const intervalValues: number[] = []
  return {
    setInterval(callback: () => void | Promise<void>, ms: number) {
      const id = nextID++
      callbacks.set(id, callback)
      intervalValues.push(ms)
      return id
    },
    clearInterval(id: number) {
      callbacks.delete(id)
    },
    async tick() {
      for (const callback of [...callbacks.values()]) {
        await callback()
      }
    },
    activeCount() {
      return callbacks.size
    },
    intervals() {
      return intervalValues
    },
  }
}

function runningState(project: string): WorkflowState {
  return {
    id: "run-1",
    project,
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
    created_at: "2026-07-02T00:00:00.000Z",
    updated_at: "2026-07-02T00:00:00.000Z",
    gates: {},
    artifacts: {},
    task_graph: {
      tasks: [
        {
          id: "T1",
          title: "Implement parent updates",
          summary: "Send parent progress periodically",
          depends_on: [],
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
        started_at: "2026-07-02T00:00:00.000Z",
      },
    ],
    history: [{ at: "2026-07-02T00:00:00.000Z", event: "created", to: "feature" }],
  }
}
