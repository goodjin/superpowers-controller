export type ProgressVariant = "info" | "success" | "warning" | "error"

export type ProgressStage =
  | "waiting_user_confirmation"
  | "run_started"
  | "node_recorded"
  | "waiting_user_input"
  | "workflow_blocked"
  | "workflow_finished"
  | "dispatch_started"
  | "node_running"

export type ProgressUpdate = {
  stage: ProgressStage
  title: string
  message: string
  variant: ProgressVariant
}

export type ProgressReporter = {
  report(input: ProgressUpdate): Promise<void>
}

export const noopProgressReporter: ProgressReporter = {
  async report() {},
}
