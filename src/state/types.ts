export type WorkflowKind =
  | "feature"
  | "debug"
  | "plan-only"
  | "review"
  | "verify-finish"
  | "parallel-investigate"

export type WorkflowEntrypoint = WorkflowKind | "design" | "plan" | "execute" | "debug" | "review" | "verify"

export type WorkflowMode =
  | "idle"
  | "design"
  | "plan"
  | "execute"
  | "debug"
  | "parallel-investigate"
  | "review"
  | "verify-finish"

export type WorkflowGate =
  | "request_confirmed"
  | "design_approved"
  | "spec_written"
  | "plan_written"
  | "root_cause_found"
  | "red_test_seen"
  | "implementation_done"
  | "acceptance_passed"
  | "code_review_passed"
  | "verification_fresh"

export type WorkflowArtifact =
  | "request"
  | "spec"
  | "plan"
  | "investigation"
  | "root_cause"
  | "red_test_log"
  | "patch_summary"
  | "acceptance"
  | "code_review"
  | "verification_log"
  | "finish_note"

export type NodeEvent =
  | "intake"
  | "question"
  | "design"
  | "plan"
  | "investigation"
  | "debug"
  | "red-test"
  | "implementation"
  | "acceptance"
  | "code-review"
  | "verification"
  | "finish"

export type NodeStatus = "progress" | "passed" | "failed" | "blocked" | "needs_user"

export type CheckKind = "acceptance" | "verification" | "code_review"

export type CheckState = {
  kind: CheckKind
  status: "pending" | "running" | "passed" | "failed" | "skipped" | "stale"
  summary?: string
  session_id?: string
  report_path?: string
}

export type TaskGraph = {
  tasks: Array<{
    id: string
    title: string
    summary: string
    depends_on: string[]
    files?: string[]
    test_commands?: string[]
    checks?: CheckState[]
  }>
}

export type NodeRunStatus = "running" | "passed" | "failed" | "blocked" | "needs_user"

export type NodeRun = {
  id: string
  task_id?: string
  phase: string
  agent: string
  primary_skill?: string
  session_id: string
  status: NodeRunStatus
  attempts: number
  started_at: string
  reported_at?: string
  closed_at?: string
  ended_at?: string
  record_path?: string
}

export type QuestionOption = {
  label: string
  description?: string
}

export type SpRecordInput = {
  event: NodeEvent
  status: NodeStatus
  summary: string
  artifacts?: Partial<Record<WorkflowArtifact, string>>
  gates?: Partial<Record<WorkflowGate, boolean>>
  checks?: string
  findings?: string
  question?: {
    prompt: string
    options?: QuestionOption[]
  }
  task_graph?: TaskGraph
}

export type WorkflowState = {
  id: string
  project: string
  session: string
  parent_session_id: string
  activation: "draft" | "active"
  workflow: WorkflowKind
  entrypoint: WorkflowEntrypoint
  limited_context: boolean
  mode: WorkflowMode
  phase: string
  current_phase: string
  status: "intake" | "running" | "waiting_user" | "blocked" | "passed" | "failed" | "canceled" | "recovered_unknown"
  goal: string
  created_at: string
  updated_at: string
  gates: Partial<Record<WorkflowGate, boolean>>
  artifacts: Partial<Record<WorkflowArtifact, string>>
  task_graph?: TaskGraph
  node_runs: NodeRun[]
  pending_question?: (SpRecordInput["question"] & { source_node_id?: string }) | undefined
  history: Array<{
    at: string
    event: string
    from?: string
    to?: string
    status?: NodeStatus
    summary?: string
  }>
  next?: string
}

export type WorkflowRecord = SpRecordInput
