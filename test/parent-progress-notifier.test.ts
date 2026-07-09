import { mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"
import { createParentProgressNotifier } from "../src/session/parent-progress-notifier"
import type { ProgressUpdate } from "../src/progress/reporter"
import type { SessionAdapter } from "../src/session/adapter"
import type { WorkflowState } from "../src/state/types"

describe("parent progress notifier", () => {
  test("does not start periodic parent progress prompts or toast updates", async () => {
    const project = tempProject()
    try {
      const state = runningState(project)
      const timer = createManualTimer()
      const prompts: Array<{ sessionID: string; agent: string; prompt: string }> = []
      const progress: ProgressUpdate[] = []
      const notifier = createParentProgressNotifier(adapterWithPrompts(prompts, progress), {
        timer,
        now: () => new Date("2026-07-09T00:00:30.000Z"),
      })

      notifier.start({
        project,
        runID: state.id,
        readState: () => state,
      })
      await timer.tick()

      expect(timer.intervals()).toEqual([])
      expect(timer.activeCount()).toBe(0)
      expect(notifier.activeCount()).toBe(0)
      expect(prompts).toEqual([])
      expect(progress).toEqual([])
    } finally {
      rmSync(project, { recursive: true, force: true })
    }
  })

  test("repeated start calls remain side-effect free", async () => {
    const project = tempProject()
    try {
      const state = runningState(project)
      const timer = createManualTimer()
      const prompts: Array<{ sessionID: string; agent: string; prompt: string }> = []
      const progress: ProgressUpdate[] = []
      const notifier = createParentProgressNotifier(adapterWithPrompts(prompts, progress), { timer })

      notifier.start({ project, runID: state.id, readState: () => state })
      notifier.start({ project, runID: state.id, readState: () => state })
      notifier.stop(state.id)
      await timer.tick()

      expect(timer.intervals()).toEqual([])
      expect(timer.activeCount()).toBe(0)
      expect(notifier.activeCount()).toBe(0)
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
    created_at: "2026-07-09T00:00:00.000Z",
    updated_at: "2026-07-09T00:00:00.000Z",
    gates: {},
    artifacts: {},
    node_runs: [
      {
        id: "001-implement-T1",
        phase: "implement",
        agent: "sp-implementer",
        primary_skill: "superpowers-test-driven-development",
        session_id: "session-child",
        task_id: "T1",
        status: "running",
        attempts: 1,
        started_at: "2026-07-09T00:00:00.000Z",
      },
    ],
    history: [],
  }
}
