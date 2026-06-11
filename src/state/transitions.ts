import type { WorkflowArtifact, WorkflowGate, WorkflowMode, WorkflowRecord, WorkflowState } from "./types"

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

const COMPLETION_EVENTS = new Set(["done", "pass", "passed", "fixed", "complete", "completed"])

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
    mode: args.mode,
    phase: initialPhase(args.mode),
    goal: args.goal,
    created_at: now,
    updated_at: now,
    gates: args.gates ?? {},
    artifacts: {},
    history: [{ at: now, event: "created", to: args.mode }],
    runtime: { skills_used: [] },
  }
}

export function applyRecord(state: WorkflowState, record: WorkflowRecord): WorkflowState {
  const gateUpdates = record.gates ?? {}
  const enabledGateUpdates = Object.entries(gateUpdates).filter(([, value]) => value === true)
  if (enabledGateUpdates.length > 3) {
    throw new Error("sp_record rejected: too many gates updated in one record")
  }

  if (COMPLETION_EVENTS.has(record.event.toLowerCase()) && state.gates.verification_fresh !== true) {
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
  const nextPhase = record.phase ?? state.phase
  return {
    ...state,
    phase: nextPhase,
    updated_at: now,
    gates: { ...state.gates, ...gateUpdates },
    artifacts: { ...state.artifacts, ...artifactRefs },
    runtime: {
      ...state.runtime,
      skills_used: Array.from(new Set([...(state.runtime?.skills_used ?? []), ...(record.skills_used ?? [])])),
    },
    next: record.next ?? state.next,
    history: [
      ...state.history,
      {
        at: now,
        event: record.event,
        from: state.phase,
        to: nextPhase,
        reason: record.reason,
      },
    ],
  }
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
      return "prove-independence"
    case "review":
      return "review-findings"
    case "verify-finish":
      return "fresh-verification"
    case "skill-authoring":
      return "pressure-scenario"
    default:
      return "idle"
  }
}
