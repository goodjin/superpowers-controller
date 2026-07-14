import type { WorkflowConfig } from "./schema"

export type InteractionMode = "legacy" | "native" | "hybrid"

export function resolveInteractionMode(config: WorkflowConfig): InteractionMode {
  return config.interaction.mode
}

export function shouldAttachParentID(mode: InteractionMode): boolean {
  return mode === "native" || mode === "hybrid"
}

export function shouldSelectChildOnDispatch(mode: InteractionMode): boolean {
  return mode === "legacy"
}

export function shouldSelectChildOnResume(mode: InteractionMode): boolean {
  return mode === "legacy" || mode === "hybrid"
}

export function shouldSelectChildOnPermission(mode: InteractionMode): boolean {
  return mode === "legacy"
}

export function shouldDeferChildPromptOnParentPermission(mode: InteractionMode): boolean {
  return mode === "native" || mode === "hybrid"
}

/** Native users stay on parent; route pending questions there so they are visible. */
export function shouldRouteUserInputToParent(mode: InteractionMode): boolean {
  return mode === "native" || mode === "hybrid"
}
