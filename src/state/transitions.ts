import type { WorkflowArtifact, WorkflowGate, WorkflowKind, WorkflowMode, WorkflowRecord, WorkflowState } from "./types"

const GATE_ARTIFACTS: Partial<Record<WorkflowGate, WorkflowArtifact>> = {
  spec_written: "spec",
  plan_written: "plan",
  root_cause_found: "root_cause",
  red_test_seen: "red_test_log",
  implementation_done: "patch_summary",
  spec_review_passed: "spec_review",
  code_review_passed: "code_review",
  verification_fresh: "verification_log",
}

export function createInitialState(args: {
  id: string
  project: string
  session: string
  mode: WorkflowMode
  goal: string
  gates?: WorkflowState["gates"]
}): WorkflowState {
  const now = new Date().toISOString()
  return {
    id: args.id,
    project: args.project,
    session: args.session,
    parent_session_id: args.session,
    workflow: workflowForMode(args.mode),
    entrypoint: workflowForMode(args.mode),
    limited_context: false,
    mode: args.mode,
    phase: initialPhase(args.mode),
    current_phase: initialPhase(args.mode),
    status: args.mode === "idle" ? "intake" : "running",
    goal: args.goal,
    created_at: now,
    updated_at: now,
    gates: args.gates ?? {},
    artifacts: {},
    node_runs: [],
    history: [{ at: now, event: "created", to: args.mode }],
  }
}

export function applyRecord(state: WorkflowState, record: WorkflowRecord): WorkflowState {
  const gateUpdates = record.gates ?? {}
  const enabledGateUpdates = Object.entries(gateUpdates).filter(([, value]) => value === true)
  if (enabledGateUpdates.length > 3) {
    throw new Error("sp_record rejected: too many gates updated in one record")
  }

  if (record.event === "finish" && record.status === "passed" && state.gates.verification_fresh !== true) {
    throw new Error("sp_record rejected: verification_fresh is required before completion records")
  }

  for (const [gate] of enabledGateUpdates) {
    const requiredArtifact = GATE_ARTIFACTS[gate as WorkflowGate]
    if (requiredArtifact && !record.artifacts?.[requiredArtifact] && !state.artifacts[requiredArtifact]) {
      throw new Error(`sp_record rejected: ${gate} requires ${requiredArtifact} artifact`)
    }
  }

  const now = new Date().toISOString()
  const artifactRefs = normalizeArtifactRefs(record.artifacts ?? {})
  const nextPhase = phaseForRecord(state.mode, record)
  return {
    ...state,
    phase: nextPhase,
    current_phase: nextPhase,
    status: statusForRecord(record),
    updated_at: now,
    gates: { ...state.gates, ...gateUpdates },
    artifacts: { ...state.artifacts, ...artifactRefs },
    task_graph: record.task_graph ?? state.task_graph,
    pending_question: record.status === "needs_user" ? record.question : undefined,
    history: [
      ...state.history,
      {
        at: now,
        event: record.event,
        from: state.phase,
        to: nextPhase,
        status: record.status,
        summary: record.summary,
      },
    ],
  }
}

function workflowForMode(mode: WorkflowMode): WorkflowKind {
  switch (mode) {
    case "debug":
      return "debug"
    case "plan":
      return "plan-only"
    case "review":
      return "review"
    case "verify-finish":
      return "verify-finish"
    case "parallel-investigate":
      return "parallel-investigate"
    default:
      return "feature"
  }
}

function statusForRecord(record: WorkflowRecord): WorkflowState["status"] {
  if (record.status === "needs_user") return "waiting_user"
  if (record.status === "blocked") return "blocked"
  if (record.status === "failed") return "failed"
  if (record.event === "finish" && record.status === "passed") return "passed"
  return "running"
}

function normalizeArtifactRefs(artifacts: NonNullable<WorkflowRecord["artifacts"]>): WorkflowState["artifacts"] {
  const refs: WorkflowState["artifacts"] = {}
  for (const key of Object.keys(artifacts) as WorkflowArtifact[]) {
    refs[key] = `${key}.md`
  }
  return refs
}

function initialPhase(mode: WorkflowMode): string {
  switch (mode) {
    case "design":
      return "explore"
    case "plan":
      return "write-plan"
    case "execute":
      return "run-task"
    case "debug":
      return "find-root-cause"
    case "parallel-investigate":
      return "investigate"
    case "review":
      return "spec-review"
    case "verify-finish":
      return "fresh-verification"
    default:
      return "idle"
  }
}

function phaseForRecord(stateMode: WorkflowMode, record: WorkflowRecord): string {
  if (record.status === "needs_user") return "waiting-user"
  if (record.status === "blocked") return "blocked"
  switch (record.event) {
    case "intake":
      return "confirmed"
    case "design":
      return record.status === "passed" ? "design-complete" : "design-retry"
    case "plan":
      return record.status === "passed" ? "plan-complete" : "plan-retry"
    case "debug":
      return record.status === "passed" ? "root-cause-found" : "debug-retry"
    case "red-test":
      return "red-test-recorded"
    case "implementation":
      return record.status === "passed" ? "implementation-complete" : "implementation-retry"
    case "spec-review":
      return record.status === "passed" ? "spec-review-passed" : "implementation-retry"
    case "code-review":
      return record.status === "passed" ? "code-review-passed" : "implementation-retry"
    case "verification":
      return record.status === "passed" ? "verification-passed" : "implementation-retry"
    case "finish":
      return record.status === "passed" ? "finished" : "finish-blocked"
    case "question":
      return "waiting-user"
    default:
      return initialPhase(stateMode)
  }
}
