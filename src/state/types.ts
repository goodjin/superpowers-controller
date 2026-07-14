export type WorkflowKind =
  | "feature"
  | "bugfix"
  | "debug"
  | "design-only"
  | "plan-only"
  | "review"
  | "review-only"
  | "verify-finish"
  | "parallel-investigate"
  | "single-agent"

export type WorkflowEntrypoint = WorkflowKind | "design" | "plan" | "execute" | "debug" | "review" | "verify" | "investigate" | "implement"

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

export type PrepareMode = "proposal_only" | "managed_design" | "managed_planning"

export type StartAction =
  | "start_prepared_task"
  | "resume_user_input"
  | "resume_tasks"
  | "retry_node"
  | "resolve_controller_decision"

export type ControllerDecisionKind =
  | "continue_existing_graph"
  | "retry_node"
  | "accept_partial_result"
  | "mark_blocked"
  | "request_reprepare"
  | "apply_workflow_patch"
  | "replace_orchestration"

export type ControllerDecision = {
  kind: ControllerDecisionKind
  node_id?: string
  task_id?: string
  reason?: string
  evidence_refs?: string[]
  required_user_action?: string
  reuse_session?: boolean
  workflow_patch?: WorkflowExpansionPatch
  orchestration?: WorkflowOrchestration
}

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
    agent?: string
    files?: string[]
    test_commands?: string[]
    checks?: CheckState[]
  }>
}

export type WorkflowDocumentSpec = {
  id: string
  path: string
  kind: string
  producer: "controller" | "plugin" | "node" | "recovery"
  consumer?: string[]
  status?: "draft" | "candidate" | "approved" | "current" | "historical"
  node_id?: string
  task_id?: string
  updated_at?: string
}

export type WorkflowNodeSpec = {
  id: string
  title?: string
  agent: string
  phase?: string
  task_id?: string
  depends_on?: string[]
  input_documents?: string[]
  output_documents?: string[]
  report_contract?: string[]
}

export type WorkflowOrchestration = {
  id?: string
  title?: string
  nodes: WorkflowNodeSpec[]
  edges?: Array<{
    from: string
    to: string
    condition?: string
  }>
  documents?: WorkflowDocumentSpec[]
  completion_policy?: string
  required_checks?: QualityCheckKind[]
  quality_commands?: Partial<Record<QualityCheckKind, string>>
}

export type QualityCheckKind = "build" | "test" | "lint"

export type QualityCheckRecord = {
  status: "passed" | "failed"
  command?: string
  summary?: string
  node_id?: string
  reported_at: string
}

export type WorkflowAutoExpansionPolicy = {
  allow: boolean
  source?: "template" | "controller_override" | "orchestration"
  reason?: string
}

export type WorkflowStage = "prepare" | "planning" | "execution" | "review" | "finish" | "recovery"

export type WorkflowSpecSource =
  | { kind: "prepare"; prepared_task_id?: string }
  | { kind: "built_in_template"; workflow_id: WorkflowKind }
  | { kind: "controller_orchestration" }
  | { kind: "report_expansion"; source_node_id?: string }
  | { kind: "controller_decision"; decision_id?: string }

export type WorkflowSpec = {
  id: string
  version?: "v5"
  spec_version?: number
  stage?: WorkflowStage
  source?: WorkflowSpecSource
  template_id?: WorkflowKind
  kind: "built_in_workflow" | "orchestration"
  title: string
  auto_expansion: WorkflowAutoExpansionPolicy
  orchestration: WorkflowOrchestration
  created_at: string
  updated_at: string
}

export type StartConfirmation = {
  user_confirmed: true
  user_message?: string
  confirmed_by_session_id?: string
}

export type WorkflowExpansionPatch = {
  mode?: "append" | "replace"
  reason?: string
  tasks?: TaskGraph["tasks"]
  nodes?: WorkflowNodeSpec[]
  documents?: WorkflowDocumentSpec[]
}

export type NodeRunStatus =
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "needs_user"
  | "interrupted"
  | "dispatch_failed"
  | "notification_failed"
  | "canceled"

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
  workflow_expansion?: WorkflowExpansionPatch
}

export type ResumeInput = {
  source_node_id: string
  answer_text?: string
  selected_options?: string[]
  user_message?: string
  [key: string]: unknown
}

export type WorkflowState = {
  id: string
  project: string
  session: string
  parent_session_id: string
  activation: "draft" | "active"
  prepare_mode?: PrepareMode
  workflow: WorkflowKind
  entrypoint: WorkflowEntrypoint
  limited_context: boolean
  mode: WorkflowMode
  phase: string
  current_phase: string
  status:
    | "intake"
    | "running"
    | "awaiting_design_approval"
    | "awaiting_plan_approval"
    | "waiting_user"
    | "waiting_user_decision"
    | "waiting_controller_decision"
    | "blocked"
    | "passed"
    | "failed"
    | "canceled"
    | "recovered_unknown"
  goal: string
  created_at: string
  updated_at: string
  state_version?: string
  gates: Partial<Record<WorkflowGate, boolean>>
  artifacts: Partial<Record<WorkflowArtifact, string>>
  task_graph?: TaskGraph
  workflow_spec?: WorkflowSpec
  quality_checks?: Partial<Record<QualityCheckKind, QualityCheckRecord>>
  start_confirmation?: StartConfirmation
  pending_workflow_expansion?: WorkflowExpansionPatch
  documents?: WorkflowDocumentSpec[]
  fallback_summaries?: Array<{
    node_id: string
    path: string
    reason: string
    created_at: string
  }>
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
