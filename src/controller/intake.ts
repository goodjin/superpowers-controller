import type { WorkflowProposal } from "./proposal"
import type { WorkflowEntrypoint, WorkflowKind } from "../state/types"

export type StartRunInput = {
  workflow: WorkflowKind
  entrypoint: WorkflowEntrypoint
  goal: string
  request: string
  proposal: string
  parentSessionID: string
}

export function prepareStartRun(args: {
  request: string
  proposal: WorkflowProposal
  parentSessionID: string
}): StartRunInput {
  return {
    workflow: args.proposal.workflow,
    entrypoint: args.proposal.entrypoint,
    goal: args.request.trim(),
    request: args.request.trim().startsWith("#") ? ensureTrailingNewline(args.request) : `# Request\n\n${args.request.trim()}\n`,
    proposal: ensureTrailingNewline(args.proposal.markdown),
    parentSessionID: args.parentSessionID,
  }
}

export function prepareExplicitStartRun(args: {
  request: string
  workflow: WorkflowKind
  entrypoint: WorkflowEntrypoint
  proposal: string
  parentSessionID: string
}): StartRunInput {
  return {
    workflow: args.workflow,
    entrypoint: args.entrypoint,
    goal: args.request.trim(),
    request: args.request.trim().startsWith("#") ? ensureTrailingNewline(args.request) : `# Request\n\n${args.request.trim()}\n`,
    proposal: ensureTrailingNewline(args.proposal),
    parentSessionID: args.parentSessionID,
  }
}

function ensureTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`
}
