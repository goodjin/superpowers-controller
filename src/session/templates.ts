import type { DispatchDecision } from "../router/transition"
import type { NodeRun, ResumeInput, WorkflowState } from "../state/types"
import type { NodeTaskPacket } from "./task-packet"
import type { TaskResumeContext } from "../runtime/task-resume"
import type { WorkflowConfig } from "../config/schema"
import { DEFAULT_CONFIG } from "../config/defaults"
import { qualityGateHint, requiredQualityChecks, resolveQualityCommand } from "../runtime/quality-checks"

export function buildNodeTaskPrompt(packet: NodeTaskPacket): string {
  const artifacts = packet.required_artifacts.map((artifact) => `- ${artifact.name}: ${artifact.path}`).join("\n")
  const sourceArtifacts = formatSourceArtifacts(packet.source_artifacts)
  const contextSections = (packet.context_sections ?? [])
    .map((section) => `## ${section.title}\n${section.body.trim()}`)
    .join("\n\n")
  return [
    maybeChildRequestMarker(packet.node_id),
    `# Superpowers Node Task: ${packet.node_id}`,
    "",
    `Workflow: ${packet.workflow}`,
    `Phase: ${packet.phase}`,
    `Agent: ${packet.agent}`,
    `Primary skill: ${packet.primary_skill}`,
    "",
    "Load this skill and only this primary skill for this node.",
    "",
    "## Objective",
    packet.objective,
    "",
    contextSections,
    contextSections ? "" : "",
    "## Required Artifacts",
    artifacts || "- none",
    "",
    sourceArtifacts,
    sourceArtifacts ? "" : "",
    packet.retry_context ? `## Retry Context\n${packet.retry_context}\n` : "",
    packet.recovery_context ? `## Recovery Context\n${packet.recovery_context}\n` : "",
    "## sp_report Contract",
    `- event: ${packet.record_contract.event}`,
    `- expected_artifacts: ${packet.record_contract.expected_artifacts.join(", ") || "none"}`,
    `- allowed_gates: ${packet.record_contract.allowed_gates.join(", ") || "none"}`,
    "- Required fields: event, status, summary",
    "- Optional fields: artifacts, gates, checks, findings, question, task_graph",
    checksContractHint(packet),
    '- question.options uses objects: [{ "label": "...", "description": "..." }].',
    designBriefModeEnabled(packet)
      ? "- Design Brief Mode: do not call sp_report(status=needs_user) for clarifying questions. If the brief is insufficient, sp_report(status=blocked) with missing facts for the controller."
      : "- After sp_report(status=needs_user), stop the turn immediately. Do not continue to the next clarification in the same turn. For design sessions, wait for the user reply in this session; otherwise the parent controller collects the answer and resumes this session.",
    "- Do not include next_action, target_session_id, child_session_id, reuse_session_id, create_sessions, or skills_used.",
  ]
    .filter(Boolean)
    .join("\n")
}

function designBriefModeEnabled(packet: NodeTaskPacket): boolean {
  return packet.agent === "sp-designer" || packet.phase === "design"
}

function formatSourceArtifacts(sourceArtifacts: NodeTaskPacket["source_artifacts"]): string {
  if (!sourceArtifacts?.length) return ""
  const sections = sourceArtifacts.map((artifact) => {
    if (artifact.body !== undefined) {
      return [
        `### ${artifact.name}: ${artifact.path}`,
        "",
        "```markdown",
        artifact.body.trimEnd(),
        "```",
      ].join("\n")
    }
    return [
      `### ${artifact.name}: ${artifact.path}`,
      "",
      `Missing: ${artifact.missing ?? "artifact was not found in the workflow run directory."}`,
    ].join("\n")
  })
  return ["## Source Artifacts", ...sections].join("\n\n")
}

export function buildCleanHandoffPrompt(args: {
  preparedTaskID: string
  confirmationSummary: string
  taskBriefSummary: string
  artifactPaths: {
    request: string
    task: string
    proposal: string
    documents: string
  }
  next: string
  sourceSessionID: string
}): string {
  return [
    "# Superpowers clean controller handoff",
    "",
    "This is a fresh controller session opened after intake was clarified in another session.",
    "Do not redo full intake unless the user revises the task. Durable facts are already prepared.",
    "",
    `Prepared task id: ${args.preparedTaskID}`,
    `Source intake session (archive only): ${args.sourceSessionID}`,
    "",
    "## Confirmation Summary",
    args.confirmationSummary.trim(),
    "",
    "## Task Brief",
    args.taskBriefSummary.trim() || "(see request.md / task.md)",
    "",
    "## Artifact Paths",
    `- request: ${args.artifactPaths.request}`,
    `- task: ${args.artifactPaths.task}`,
    `- proposal: ${args.artifactPaths.proposal}`,
    `- documents: ${args.artifactPaths.documents}`,
    "",
    "## Next Steps",
    "1. Call sp_status for this prepared task if you need runtime facts.",
    "2. Show the confirmation summary to the user in this session.",
    "3. After the user confirms, call sp_start(action=\"start_prepared_task\", prepared_task_id, confirmation). start_config is optional.",
    "4. If the user wants changes, revise the brief and call sp_prepare again (optionally with clean_handoff=true).",
    "",
    `Prepare next hint: ${args.next}`,
  ].join("\n")
}

export function buildControllerDecisionPrompt(
  state: WorkflowState,
  allowedControllerDecisions: Array<{ kind: string; reason: string; payload?: unknown }>,
): string {
  const firstDecision = allowedControllerDecisions[0]
  return [
    "# Superpowers workflow waiting for controller decision",
    "",
    `Run: ${state.id}`,
    `Workflow: ${state.workflow}`,
    `Phase: ${state.current_phase}`,
    `Status: ${state.status}`,
    "",
    "A child node finished its `sp_report`, but the runtime cannot safely continue without a controller decision.",
    "First call `sp_status` for this run to refresh the runtime facts, then choose one of `allowed_controller_decisions` and call `sp_start(start_action=\"resolve_controller_decision\")` with that exact payload.",
    "Do not invent a decision outside `allowed_controller_decisions`.",
    "",
    "Suggested first available decision:",
    firstDecision ? `- ${firstDecision.kind}: ${firstDecision.reason}` : "- none available; call sp_status and explain the missing decision list.",
    "",
    firstDecision?.payload ? "```json" : "",
    firstDecision?.payload ? JSON.stringify(firstDecision.payload, null, 2) : "",
    firstDecision?.payload ? "```" : "",
  ].filter(Boolean).join("\n")
}

export function buildSilentExitControllerPrompt(
  state: WorkflowState,
  args: {
    evidence: {
      reason: string
      summary: string
      assistant_text: string
      produced_paths: string[]
      error?: string
      idle_ms?: number
    }
    artifact_path?: string
    allowed_controller_decisions: Array<{ kind: string; reason: string; payload?: unknown }>
  },
): string {
  const firstDecision = args.allowed_controller_decisions[0]
  const paths = args.evidence.produced_paths.length
    ? args.evidence.produced_paths.map((path) => `- ${path}`).join("\n")
    : "- (none detected)"
  const assistant = args.evidence.assistant_text.trim()
  const excerpt = assistant
    ? (assistant.length > 3500 ? `${assistant.slice(0, 3497)}...` : assistant)
    : "(no assistant text captured)"
  const siblingNote = state.status === "running" || state.status === "intake"
    ? "Other sibling nodes are still marked running. Decide how to handle this interrupted node; do not assume the whole workflow stopped."
    : "Do not treat this as a successful node completion."
  return [
    "# Superpowers workflow waiting for controller decision",
    "",
    `Run: ${state.id}`,
    `Workflow: ${state.workflow}`,
    `Phase: ${state.current_phase}`,
    `Status: ${state.status}`,
    "",
    "A child session ended without calling `sp_report`. Runtime captured partial evidence and needs a controller decision.",
    siblingNote,
    "First call `sp_status`, inspect the silent-exit artifact, then choose one of `allowed_controller_decisions`.",
    "",
    "## Capture Summary",
    "",
    args.evidence.summary,
    args.evidence.error ? `Error: ${args.evidence.error}` : "",
    args.evidence.idle_ms !== undefined ? `Idle ms: ${args.evidence.idle_ms}` : "",
    args.artifact_path ? `Evidence file: ${args.artifact_path}` : "",
    "",
    "## Produced Paths",
    "",
    paths,
    "",
    "## Last Assistant Text",
    "",
    excerpt,
    "",
    "Suggested first available decision:",
    firstDecision ? `- ${firstDecision.kind}: ${firstDecision.reason}` : "- none available; call sp_status and explain the missing decision list.",
    "",
    firstDecision?.payload ? "```json" : "",
    firstDecision?.payload ? JSON.stringify(firstDecision.payload, null, 2) : "",
    firstDecision?.payload ? "```" : "",
  ].filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n")
}

export function buildControllerUserInputPrompt(
  state: WorkflowState,
  options: { conversation?: "main" | "foreground" } = {},
): string {
  if (state.status === "awaiting_design_approval") {
    return buildApprovalPrompt(state, {
      kind: "design",
      artifact: "spec",
      conversation: options.conversation ?? "main",
    })
  }
  if (state.status === "awaiting_plan_approval") {
    return buildApprovalPrompt(state, {
      kind: "plan",
      artifact: "plan",
      conversation: options.conversation ?? "main",
    })
  }

  const question = state.pending_question
  if (!question) {
    return [
      "# Superpowers workflow waiting for user input",
      "",
      `Run: ${state.id}`,
      "",
      "The workflow is marked waiting_user, but no pending_question is available. Call sp_status and report the inconsistency to the user.",
    ].join("\n")
  }
  return [
    "# Superpowers workflow waiting for user input",
    "",
    `Run: ${state.id}`,
    `Workflow: ${state.workflow}`,
    `Phase: ${state.current_phase}`,
    `Source node: ${question.source_node_id ?? "unknown"}`,
    "",
    options.conversation === "foreground"
      ? "Ask the user this pending_question in the current foreground child conversation. Do not answer it yourself."
      : "Ask the user this pending_question in the main conversation. Do not answer it yourself.",
    options.conversation === "foreground"
      ? ""
      : "Keep the user in this parent controller session for the answer. Do not tell them to switch into the child session to reply.",
    "",
    "## Question",
    question.prompt,
    "",
    question.options?.length ? "## Options" : "",
    question.options?.map((option) => `- ${option.label}${option.description ? `: ${option.description}` : ""}`).join("\n") ?? "",
    question.options?.length ? "" : "",
    "After the user answers, call sp_start with this run_id and resume_input. Use free-form user text when the answer is not a simple option.",
    "",
    "```json",
    JSON.stringify({
      run_id: state.id,
      resume_input: {
        source_node_id: question.source_node_id,
        answer_text: "<user answer>",
        selected_options: ["<optional selected option label>"],
        user_message: "<original user reply>",
      },
    }, null, 2),
    "```",
  ]
    .filter((line) => line !== undefined)
    .join("\n")
}

function buildApprovalPrompt(
  state: WorkflowState,
  args: {
    kind: "design" | "plan"
    artifact: "spec" | "plan"
    conversation: "main" | "foreground"
  },
): string {
  const place = args.conversation === "foreground" ? "current foreground child conversation" : "main conversation"
  return [
    `# Superpowers ${args.kind} waiting for approval`,
    "",
    `Run: ${state.id}`,
    `Workflow: ${state.workflow}`,
    `Phase: ${state.current_phase}`,
    "",
    `The candidate ${args.kind} is ready. Show the user the candidate ${args.artifact} summary already produced by this node, then ask whether to approve, revise, or cancel.`,
    `Ask in the ${place}. Do not approve or revise on the user's behalf.`,
    "",
    "If the user accepts the candidate, do not call legacy approve actions. Return to the v5 controller path: either prepare a revised confirmed task with sp_prepare and then call sp_start(start_prepared_task) with confirmation and start_config, or resolve the current run with an allowed controller decision.",
    "",
    "```json",
    JSON.stringify({
      run_id: state.id,
      start_action: "resolve_controller_decision",
      expected_state_version: state.state_version,
      controller_decision: {
        kind: "request_reprepare",
        reason: `User accepted the candidate ${args.kind}; restart through the v5 prepared-task confirmation path.`,
      },
    }, null, 2),
    "```",
    "",
    "If the user asks for revisions, explain the requested changes and continue this node with an updated report when ready. If the user cancels, call sp_cancel.",
  ].join("\n")
}

export function buildChildResumePrompt(args: {
  state: WorkflowState
  node: NodeRun
  resumeInput: ResumeInput
  pendingQuestion: WorkflowState["pending_question"]
}): string {
  return [
    "# Superpowers User Input Resume",
    "",
    `Run: ${args.state.id}`,
    `Node: ${args.node.id}`,
    `Phase: ${args.node.phase}`,
    args.node.task_id ? `Task: ${args.node.task_id}` : "",
    "",
    "The parent controller session collected user input for your pending question. Continue the same node work using this answer.",
    "",
    "## Pending Question",
    args.pendingQuestion?.prompt ?? "(question unavailable)",
    "",
    args.pendingQuestion?.options?.length ? "## Original Options" : "",
    args.pendingQuestion?.options?.map((option) => `- ${option.label}${option.description ? `: ${option.description}` : ""}`).join("\n") ?? "",
    args.pendingQuestion?.options?.length ? "" : "",
    "## User Answer",
    args.resumeInput.answer_text ?? args.resumeInput.user_message ?? JSON.stringify(args.resumeInput),
    "",
    args.resumeInput.selected_options?.length ? "Selected options:" : "",
    args.resumeInput.selected_options?.map((option) => `- ${option}`).join("\n") ?? "",
    args.resumeInput.selected_options?.length ? "" : "",
    "When this node is complete or blocked, call sp_report with the normal event, status, summary, artifacts, gates, checks, findings, question, or task_graph as relevant.",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildChildRequestId(nodeID: string): string {
  return `node-${nodeID}`
}

export function buildRecoveryContext(context: TaskResumeContext): string {
  const prior = context.prior_node_id
    ? `Prior node: ${context.prior_node_id}${context.prior_node_status ? ` (${context.prior_node_status})` : ""}.`
    : "Prior node: none recorded for this phase."
  return [
    "This task was interrupted before plugin restart and is now being resumed.",
    "",
    "Before doing new work, inspect the current task state:",
    "- If the work is already complete and acceptance criteria are met, submit sp_report(status=passed) with a short summary.",
    "- If the work is incomplete, continue from the interruption point without redoing finished work.",
    "",
    `${prior} Phase: ${context.phase}. Task: ${context.task_id}.`,
    "Use existing run artifacts and progress as the source of truth.",
  ].join("\n")
}

export function buildNodeTaskPacket(args: {
  state: WorkflowState
  decision: Extract<DispatchDecision, { action: "create_session" | "reuse_session" }>
  nodeID: string
  config?: WorkflowConfig
  resumeContext?: TaskResumeContext
}): NodeTaskPacket {
  const contract = recordContractForPhase(args.decision.phase)
  const config = args.config ?? DEFAULT_CONFIG
  const contextSections = [
    ...(contextSectionsForDecision(args.state, args.decision) ?? []),
    ...qualityCheckContextSections(args.state, args.decision.phase, config),
  ]
  return {
    run_id: args.state.id,
    node_id: args.nodeID,
    workflow: args.state.workflow,
    phase: args.decision.phase,
    agent: args.decision.agent,
    primary_skill: args.decision.primary_skill,
    task_id: args.decision.task_id,
    objective: objectiveForDecision(args.state, args.decision),
    context_sections: contextSections.length > 0 ? contextSections : undefined,
    required_artifacts: requiredArtifactsForPhase(args.decision.phase, args.state, args.decision.task_id),
    record_contract: contract,
    recovery_context: args.resumeContext ? buildRecoveryContext(args.resumeContext) : undefined,
  }
}

function qualityCheckContextSections(
  state: WorkflowState,
  phase: string,
  config: WorkflowConfig,
): Array<{ title: string; body: string }> {
  if (phase !== "verification" && phase !== "finish") return []
  const required = requiredQualityChecks(state)
  if (required.length === 0) return []
  const commands = required
    .map((kind) => `${kind}: \`${resolveQualityCommand(config, state, kind)}\``)
    .join("\n")
  const hint = qualityGateHint(state, config)
  return [
    {
      title: "Quality Check Evidence",
      body: [
        "Run the required commands and include results in `sp_report.checks`.",
        "",
        "Line format (one per check):",
        "```",
        "build: passed (bun run build)",
        "test: passed (bun test)",
        "```",
        "Or JSON: `{\"build\":{\"status\":\"passed\",\"command\":\"bun run build\"}}`",
        "",
        `Required checks: ${required.join(", ")}`,
        "",
        "Suggested commands:",
        commands,
        hint ? `\nStill missing before finish: ${hint}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    },
  ]
}

function checksContractHint(packet: NodeTaskPacket): string {
  if (packet.record_contract.event !== "verification" && packet.record_contract.event !== "finish") return ""
  const section = packet.context_sections?.find((item) => item.title === "Quality Check Evidence")
  if (!section) return ""
  return "- checks: required for this workflow; see Quality Check Evidence above."
}

function objectiveForDecision(
  state: WorkflowState,
  decision: Extract<DispatchDecision, { action: "create_session" | "reuse_session" }>,
): string {
  if (decision.phase === "design" || decision.agent === "sp-designer") {
    return "Produce the candidate design/spec from the controller's clarified design brief and source artifacts. Do not interview the user. If the brief is insufficient, report blocked with missing facts."
  }
  if (state.activation === "draft" && decision.phase === "plan") {
    return "Produce the formal implementation plan and task graph for controller review. Do not begin implementation."
  }
  if (decision.task_id) return `${decision.reason}. Execute task ${decision.task_id}.`
  return decision.reason
}

function requiredArtifactsForPhase(phase: string, state: WorkflowState, taskID?: string): NodeTaskPacket["required_artifacts"] {
  switch (phase) {
    case "design":
      return [
        { name: "request", path: "request.md" },
        { name: "task", path: "task.md" },
        { name: "proposal", path: "proposal.md" },
      ]
    case "plan":
      if (state.activation === "draft") {
        return [{ name: "request", path: "request.md" }]
      }
      return [{ name: "spec", path: "artifacts/spec.md" }]
    case "implement":
      return [
        { name: "plan", path: "artifacts/plan.md" },
        ...(taskID ? [{ name: "task_prompt", path: `reports/${taskID}/task.md` }] : []),
      ]
    case "acceptance":
      return taskScopedArtifacts(taskID, [
        { name: "spec", path: "spec.md" },
        { name: "plan", path: "plan.md" },
        { name: "tasks", path: "tasks.json" },
        { name: "task_prompt", path: `reports/${taskID}/task.md` },
        { name: "implementation_report", path: `reports/${taskID}/report.md` },
      ])
    case "code-review":
      return taskScopedArtifacts(taskID, [
        { name: "task_prompt", path: `reports/${taskID}/task.md` },
        { name: "implementation_report", path: `reports/${taskID}/report.md` },
        { name: "acceptance_report", path: `reports/${taskID}/acceptance.md` },
        { name: "verification_report", path: `reports/${taskID}/verification.md` },
      ])
    case "verification":
      return taskScopedArtifacts(taskID, [
        { name: "task_prompt", path: `reports/${taskID}/task.md` },
        { name: "implementation_report", path: `reports/${taskID}/report.md` },
        { name: "acceptance_report", path: `reports/${taskID}/acceptance.md` },
      ])
    case "finish":
      if (state.workflow === "parallel-investigate") {
        return [{ name: "investigation", path: "artifacts/investigation.md" }]
      }
      return [{ name: "verification_log", path: "artifacts/verification_log.md" }]
    default:
      return []
  }
}

function taskScopedArtifacts(taskID: string | undefined, artifacts: NodeTaskPacket["required_artifacts"]): NodeTaskPacket["required_artifacts"] {
  if (!taskID) return [{ name: "patch_summary", path: "artifacts/patch_summary.md" }]
  return artifacts
}

function contextSectionsForDecision(
  state: WorkflowState,
  decision: Extract<DispatchDecision, { action: "create_session" | "reuse_session" }>,
): NodeTaskPacket["context_sections"] {
  const sections: NodeTaskPacket["context_sections"] = []
  if (decision.phase === "design" || decision.agent === "sp-designer") {
    sections.push({
      title: "Design Brief Mode",
      body: [
        "The controller already clarified requirements with the user in the main session.",
        "Source artifacts (request/task/proposal) are the design brief.",
        "Skip interactive clarifying questions, visual-companion consent gates, and mid-design sectional user approval.",
        "Write the candidate spec for controller review. If critical facts are missing, sp_report(status=blocked) instead of needs_user.",
      ].join("\n"),
    })
  }
  if (decision.task_id) {
    const task = state.task_graph?.tasks.find((item) => item.id === decision.task_id)
    sections.push({
      title: "Task Scope",
      body: task
        ? formatTaskScope(task)
        : [`Task ID: ${decision.task_id}`, "", "No matching task definition was found in the current task graph."].join("\n"),
    })
  }
  if (decision.phase === "acceptance" && decision.review_context) {
    sections.push({
      title: "Implementation Completion Summary",
      body: [
        `Source event: ${decision.review_context.source_event}`,
        "",
        decision.review_context.summary,
        decision.review_context.report ? `\n### Patch Summary\n${decision.review_context.report}` : "",
      ].join("\n"),
    })
    if (decision.task_id) {
      sections.push({
        title: "Acceptance Instructions",
        body: [
          `Review only task ${decision.task_id}.`,
          "Compare the task definition, confirmed spec, plan, implementation report, and changed files.",
          "Do not fail this task because other task graph items are not implemented yet.",
          "Report concrete mismatches, missing acceptance criteria, or evidence gaps through sp_report.",
        ].join("\n"),
      })
    }
  }
  if (decision.action === "reuse_session" && decision.review_context) {
    sections.push({
      title: "Retry Context",
      body: [
        `Source event: ${decision.review_context.source_event}`,
        "",
        decision.review_context.summary,
        decision.review_context.report ? `\n### Findings\n${decision.review_context.report}` : "",
      ].join("\n"),
    })
  }
  return sections
}

function formatTaskScope(task: NonNullable<WorkflowState["task_graph"]>["tasks"][number]): string {
  return [
    `Task ID: ${task.id}`,
    `Title: ${task.title}`,
    "",
    "Summary:",
    task.summary,
    "",
    "Dependencies:",
    task.depends_on.length > 0 ? task.depends_on.map((item) => `- ${item}`).join("\n") : "- none",
    "",
    "Files:",
    task.files?.length ? task.files.map((item) => `- ${item}`).join("\n") : "- not specified",
    "",
    "Test commands:",
    task.test_commands?.length ? task.test_commands.map((item) => `- ${item}`).join("\n") : "- not specified",
  ].join("\n")
}

function recordContractForPhase(phase: string): NodeTaskPacket["record_contract"] {
  switch (phase) {
    case "design":
      return { event: "design", expected_artifacts: ["spec"], allowed_gates: ["design_approved", "spec_written"] }
    case "plan":
      return { event: "plan", expected_artifacts: ["plan"], allowed_gates: ["plan_written"] }
    case "investigate":
      return { event: "investigation", expected_artifacts: ["investigation"], allowed_gates: [] }
    case "debug":
      return { event: "debug", expected_artifacts: ["root_cause"], allowed_gates: ["root_cause_found"] }
    case "implement":
      return { event: "implementation", expected_artifacts: ["patch_summary"], allowed_gates: ["implementation_done"] }
    case "acceptance":
      return { event: "acceptance", expected_artifacts: ["acceptance"], allowed_gates: ["acceptance_passed"] }
    case "code-review":
      return { event: "code-review", expected_artifacts: ["code_review"], allowed_gates: ["code_review_passed"] }
    case "verification":
      return { event: "verification", expected_artifacts: ["verification_log"], allowed_gates: ["verification_fresh"] }
    case "finish":
      return { event: "finish", expected_artifacts: ["finish_note"], allowed_gates: [] }
    default:
      return { event: "question", expected_artifacts: [], allowed_gates: [] }
  }
}

function maybeChildRequestMarker(nodeID: string): string {
  if (process.env.OPENCODE_SUPERPOWERS_E2E_CHILD_REQUEST_MARKERS !== "1") return ""
  return `[llm_request_id:${buildChildRequestId(nodeID)}]`
}
