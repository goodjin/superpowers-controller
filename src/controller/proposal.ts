import { routeWorkflow } from "../router/route"
import type { WorkflowEntrypoint, WorkflowKind, WorkflowState } from "../state/types"

export type WorkflowProposal = {
  workflow: WorkflowKind
  entrypoint: WorkflowEntrypoint
  requires_confirmation: true
  markdown: string
  next_action: "confirm_start" | "confirm_resume"
}

export function buildWorkflowProposal(args: {
  request: string
  routeHint?: string
  command?: string
  existingState: WorkflowState | null
}): WorkflowProposal {
  if (args.existingState) return buildResumeProposal(args.existingState)

  const route = routeWorkflow({
    request: args.request,
    command: args.command,
    currentState: null,
  })
  const workflow = workflowFromHint(args.routeHint) ?? workflowFromMode(route.mode)
  const entrypoint = entrypointFromMode(route.mode, workflow)
  const markdown = [
    "# Superpowers Workflow Proposal",
    "",
    `Request: ${args.request.trim()}`,
    "",
    `I will run the ${workflow} workflow.`,
    "",
    `Entrypoint: ${entrypoint}`,
    "",
    "Next action: confirm to start the run.",
  ].join("\n")

  return {
    workflow,
    entrypoint,
    requires_confirmation: true,
    markdown,
    next_action: "confirm_start",
  }
}

function buildResumeProposal(state: WorkflowState): WorkflowProposal {
  const markdown = [
    "# Superpowers Resume Proposal",
    "",
    `Active run: ${state.id}`,
    `Workflow: ${state.workflow}`,
    `Current phase: ${state.current_phase ?? state.phase}`,
    "",
    "Next action: confirm to resume this run.",
  ].join("\n")

  return {
    workflow: state.workflow,
    entrypoint: state.entrypoint,
    requires_confirmation: true,
    markdown,
    next_action: "confirm_resume",
  }
}

function workflowFromHint(value: string | undefined): WorkflowKind | null {
  if (!value) return null
  if (value === "execute") return "feature"
  if (isWorkflowKind(value)) return value
  return null
}

function workflowFromMode(mode: string): WorkflowKind {
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

function entrypointFromMode(mode: string, workflow: WorkflowKind): WorkflowEntrypoint {
  if (mode === "execute") return "execute"
  if (mode === "design") return "feature"
  if (mode === "plan") return "plan-only"
  if (mode === "verify-finish") return "verify-finish"
  if (mode === "parallel-investigate") return "parallel-investigate"
  if (mode === "debug" || mode === "review") return mode
  return workflow
}

function isWorkflowKind(value: string): value is WorkflowKind {
  return ["feature", "debug", "plan-only", "review", "verify-finish", "parallel-investigate"].includes(value)
}
