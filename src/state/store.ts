import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { randomUUID } from "node:crypto"
import { applyRecord, createInitialState } from "./transitions"
import type { WorkflowMode, WorkflowRecord, WorkflowState } from "./types"

export type ProjectStore = {
  root: string
  readCurrent(): WorkflowState | null
  start(args: { session: string; mode: WorkflowMode; goal: string }): WorkflowState
  record(record: WorkflowRecord): WorkflowState
  reset(): void
}

export function createProjectStore(project: string): ProjectStore {
  const root = join(project, ".opencode", "superpowers")
  return {
    root,
    readCurrent() {
      const currentPath = join(root, "current.json")
      if (!existsSync(currentPath)) return null
      const pointer = JSON.parse(readFileSync(currentPath, "utf8")) as { run: string }
      const statePath = join(root, "runs", pointer.run, "state.json")
      if (!existsSync(statePath)) return null
      return JSON.parse(readFileSync(statePath, "utf8")) as WorkflowState
    },
    start(args) {
      const state = createInitialState({
        id: randomUUID(),
        project,
        session: args.session,
        mode: args.mode,
        goal: args.goal,
      })
      writeState(root, state)
      writeCurrent(root, state.id)
      return state
    },
    record(record) {
      const current = this.readCurrent()
      if (!current) {
        throw new Error("No active Superpowers workflow. Call sp_route or sp_next first.")
      }
      writeArtifacts(root, current.id, record.artifacts ?? {})
      const next = applyRecord(current, record)
      writeState(root, next)
      writeCurrent(root, next.id)
      return next
    },
    reset() {
      const currentPath = join(root, "current.json")
      if (existsSync(currentPath)) rmSync(currentPath)
    },
  }
}

function writeState(root: string, state: WorkflowState): void {
  const statePath = join(root, "runs", state.id, "state.json")
  mkdirSync(dirname(statePath), { recursive: true })
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`)
}

function writeCurrent(root: string, run: string): void {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, "current.json"), `${JSON.stringify({ run }, null, 2)}\n`)
}

function writeArtifacts(root: string, run: string, artifacts: NonNullable<WorkflowRecord["artifacts"]>): void {
  for (const [name, body] of Object.entries(artifacts)) {
    const artifactPath = join(root, "runs", run, "artifacts", `${name}.md`)
    mkdirSync(dirname(artifactPath), { recursive: true })
    writeFileSync(artifactPath, `${body.trim()}\n`)
  }
}
