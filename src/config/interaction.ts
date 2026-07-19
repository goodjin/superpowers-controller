import type { WorkflowConfig } from "./schema"

/** Interaction is native-only: parent-led UX. Kept for config shape compatibility. */
export type InteractionMode = "native"

export function resolveInteractionMode(config: WorkflowConfig): InteractionMode {
  return config.interaction.mode
}
