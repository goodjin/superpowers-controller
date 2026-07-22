import { join } from "node:path"

/** Project-local durable workflow data root (not under `.opencode/`). */
export const SUPERPOWERS_STATE_DIRNAME = ".superpowers"

/** Relative posix-style prefix for tool / document paths shown to agents. */
export const SUPERPOWERS_STATE_RELATIVE = ".superpowers"

export function projectStateRoot(project: string): string {
  return join(project, SUPERPOWERS_STATE_DIRNAME)
}

export function projectRunRoot(project: string, runID: string): string {
  return join(projectStateRoot(project), "runs", runID)
}

export function relativeRunPath(runID: string, ...parts: string[]): string {
  return [SUPERPOWERS_STATE_RELATIVE, "runs", runID, ...parts].join("/")
}
