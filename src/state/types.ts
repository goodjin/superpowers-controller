export type WorkflowMode =
  | "idle"
  | "design"
  | "plan"
  | "execute"
  | "debug"
  | "parallel-investigate"
  | "review"
  | "verify-finish"
  | "skill-authoring"

export type WorkflowGate =
  | "design_approved"
  | "spec_written"
  | "plan_written"
  | "worktree_ready"
  | "root_cause_found"
  | "red_test_seen"
  | "implementation_done"
  | "spec_review_passed"
  | "code_review_passed"
  | "verification_fresh"

export type WorkflowArtifact =
  | "spec"
  | "plan"
  | "root_cause"
  | "red_test_log"
  | "patch_summary"
  | "spec_review"
  | "code_review"
  | "verification_log"

export type WorkflowState = {
  id: string
  project: string
  session: string
  mode: WorkflowMode
  phase: string
  goal: string
  created_at: string
  updated_at: string
  gates: Partial<Record<WorkflowGate, boolean>>
  artifacts: Partial<Record<WorkflowArtifact, string>>
  history: Array<{
    at: string
    event: string
    from?: string
    to?: string
    reason?: string
  }>
  next?: string
  runtime?: {
    skills_used?: string[]
  }
}

export type WorkflowRecord = {
  event: string
  phase?: string
  next?: string
  reason?: string
  skills_used?: string[]
  gates?: Partial<Record<WorkflowGate, boolean>>
  artifacts?: Partial<Record<WorkflowArtifact, string>>
}
