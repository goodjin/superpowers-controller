import type { DispatchDecision } from "../router/transition"
import type { WorkflowState } from "../state/types"
import type { NodeTaskPacket } from "./task-packet"

export function buildNodeTaskPrompt(packet: NodeTaskPacket): string {
  const artifacts = packet.required_artifacts.map((artifact) => `- ${artifact.name}: ${artifact.path}`).join("\n")
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
    "## Required Artifacts",
    artifacts || "- none",
    "",
    packet.retry_context ? `## Retry Context\n${packet.retry_context}\n` : "",
    "## sp_report Contract",
    `- event: ${packet.record_contract.event}`,
    `- expected_artifacts: ${packet.record_contract.expected_artifacts.join(", ") || "none"}`,
    `- allowed_gates: ${packet.record_contract.allowed_gates.join(", ") || "none"}`,
    "- Required fields: event, status, summary",
    "- Optional fields: artifacts, gates, checks, findings, question, task_graph",
    "- Do not include next_action, target_session_id, child_session_id, reuse_session_id, create_sessions, or skills_used.",
  ]
    .filter(Boolean)
    .join("\n")
}

export function buildChildRequestId(nodeID: string): string {
  return `node-${nodeID}`
}

export function buildNodeTaskPacket(args: {
  state: WorkflowState
  decision: Extract<DispatchDecision, { action: "create_session" | "reuse_session" }>
  nodeID: string
}): NodeTaskPacket {
  const contract = recordContractForPhase(args.decision.phase)
  return {
    run_id: args.state.id,
    node_id: args.nodeID,
    workflow: args.state.workflow,
    phase: args.decision.phase,
    agent: args.decision.agent,
    primary_skill: args.decision.primary_skill,
    task_id: args.decision.task_id,
    objective: objectiveForDecision(args.state, args.decision),
    required_artifacts: requiredArtifactsForPhase(args.decision.phase, args.state),
    record_contract: contract,
  }
}

function objectiveForDecision(
  state: WorkflowState,
  decision: Extract<DispatchDecision, { action: "create_session" | "reuse_session" }>,
): string {
  if (state.activation === "draft" && decision.phase === "plan") {
    return "Produce the formal implementation plan and task graph for controller review. Do not begin implementation."
  }
  if (decision.task_id) return `${decision.reason}. Execute task ${decision.task_id}.`
  return decision.reason
}

function requiredArtifactsForPhase(phase: string, state: WorkflowState): NodeTaskPacket["required_artifacts"] {
  switch (phase) {
    case "plan":
      if (state.activation === "draft") {
        return [{ name: "request", path: "request.md" }]
      }
      return [{ name: "spec", path: "artifacts/spec.md" }]
    case "implement":
      return [{ name: "plan", path: "artifacts/plan.md" }]
    case "acceptance":
    case "code-review":
    case "verification":
      return [{ name: "patch_summary", path: "artifacts/patch_summary.md" }]
    case "finish":
      if (state.workflow === "parallel-investigate") {
        return [{ name: "investigation", path: "artifacts/investigation.md" }]
      }
      return [{ name: "verification_log", path: "artifacts/verification_log.md" }]
    default:
      return []
  }
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
