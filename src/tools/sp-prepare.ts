import { tool, type ToolDefinition } from "@opencode-ai/plugin/tool"
import { prepareExplicitStartRun } from "../controller/intake"
import type { SessionOrchestrator } from "../session/orchestrator"
import { noopProgressReporter, type ProgressReporter } from "../progress/reporter"
import type { ProjectStore } from "../state/store"
import type { PrepareMode, WorkflowEntrypoint, WorkflowKind } from "../state/types"
import { AGENT_SKILL_MAP } from "../router/modes"
import { buildControllerFeedback } from "../controller/feedback"
import { dispatchWorkflowDecisions } from "./sp-start"

export function createPrepareTool(
  store: ProjectStore,
  orchestrator: Pick<SessionOrchestrator, "dispatch">,
  progress: ProgressReporter = noopProgressReporter,
): ToolDefinition {
  return tool({
    description: "Prepare a Superpowers workflow from a confirmed task. V4 may dispatch managed design or planning draft nodes.",
    args: {
      task_brief: tool.schema
        .object({
          goal: tool.schema.string().describe("User-facing task goal."),
          scope: tool.schema.string().optional().describe("Task scope and boundaries."),
          constraints: tool.schema.string().optional().describe("Known constraints as model-readable prose."),
          acceptance_criteria: tool.schema.string().optional().describe("Acceptance criteria for completion as model-readable prose."),
          known_context: tool.schema.string().optional().describe("Important existing context as model-readable prose."),
          risks: tool.schema.string().optional().describe("Known risks or unknowns as model-readable prose."),
          controller_notes: tool.schema.string().optional().describe("Controller-only planning notes to persist in task.md."),
        })
        .optional()
        .describe("V5 structured task brief prepared by the controller after intake."),
      design_participation: tool.schema
        .object({
          mode: tool.schema.enum(["none", "brainstorm", "design"]).describe("Whether sp-designer participates during prepare."),
          reason: tool.schema.string().optional().describe("Why designer participation is or is not needed."),
          blocking_questions_allowed: tool.schema.boolean().optional().describe("Whether designer may ask design-blocking questions."),
        })
        .optional()
        .describe("V5 prepare-stage designer participation decision."),
      confirmation: tool.schema
        .object({
          required: tool.schema.boolean().optional().describe("Whether user confirmation is required before sp_start."),
          reason: tool.schema.string().optional().describe("Why confirmation is needed."),
          question: tool.schema.string().optional().describe("User-facing confirmation question."),
        })
        .optional()
        .describe("V5 confirmation policy for the prepared task."),
      task: tool.schema.string().optional().describe("Confirmed task markdown or plain text"),
      request: tool.schema.string().optional().describe("Backward-compatible confirmed task text"),
      workflow_id: tool.schema.string().optional().describe("Existing workflow id to load for continuation"),
      source_workflow_id: tool.schema.string().optional().describe("Completed workflow id to use as source context"),
      kind: tool.schema.string().optional().describe("Workflow kind: feature, debug, plan-only, review, verify-finish, or parallel-investigate"),
      workflow: tool.schema.string().optional().describe("Backward-compatible workflow kind"),
      entrypoint: tool.schema.string().optional().describe("Confirmed entrypoint"),
      prepare_mode: tool.schema.enum(["proposal_only", "managed_design", "managed_planning"]).optional().describe("V4 prepare mode."),
      proposal: tool.schema.string().optional().describe("Optional proposal markdown confirmed by the user"),
      session: tool.schema.string().optional().describe("Controller session id"),
    },
    async execute(args, context) {
      if (args.workflow_id) {
        const existing = store.readRun(args.workflow_id)
        if (!existing) throw new Error(`No Superpowers workflow found for ${args.workflow_id}.`)
        return JSON.stringify({ state: existing }, null, 2)
      }

      const taskBrief = normalizeTaskBrief(args.task_brief)
      const request = args.task ?? args.request ?? (taskBrief ? buildRequestFromTaskBrief(taskBrief) : undefined)
      if (!request) throw new Error("sp_prepare requires task or request.")
      const workflow = (args.kind ?? args.workflow ?? "feature") as WorkflowKind
      const entrypoint = (args.entrypoint ?? workflow) as WorkflowEntrypoint
      const designParticipation = normalizeDesignParticipation(args.design_participation)
      const prepareMode = choosePrepareMode({
        explicit: args.prepare_mode as PrepareMode | undefined,
        workflow,
        entrypoint,
        sourceWorkflowID: args.source_workflow_id,
        hasV5TaskBrief: Boolean(taskBrief),
        designMode: designParticipation?.mode,
      })
      const start = prepareExplicitStartRun({
        request,
        workflow,
        entrypoint,
        proposal: args.proposal ?? buildPreparedProposal({
          request,
          workflow,
          sourceWorkflowID: args.source_workflow_id,
          taskBrief,
          designParticipation,
        }),
        parentSessionID: args.session ?? context.sessionID,
      })
      const state = store.prepareRun({
        ...start,
        sourceWorkflowID: args.source_workflow_id,
        prepareMode,
      })
      const dispatches = await dispatchWorkflowDecisions({
        store,
        orchestrator,
        state,
        startMode: "resume",
        decisions: prepareDispatchDecisions(prepareMode),
      })
      await progress.report({
        stage: "run_started",
        title: "Superpowers workflow",
        message: `${state.workflow} workflow prepared from ${state.entrypoint} in ${prepareMode}.`,
        variant: "success",
      })

      const fresh = store.readCurrent() ?? state
      return JSON.stringify(
        {
          state: fresh,
          prepared_task_id: fresh.id,
          prepare_mode: prepareMode,
          dispatches,
          confirmation_summary: buildConfirmationSummary({
            request,
            workflow,
            entrypoint,
            prepareMode,
            taskBrief,
            designParticipation,
            confirmation: normalizeConfirmation(args.confirmation),
          }),
          required_user_confirmations: requiredConfirmations(args.confirmation),
          artifact_paths: {
            request: `.opencode/superpowers/runs/${fresh.id}/request.md`,
            task: `.opencode/superpowers/runs/${fresh.id}/task.md`,
            proposal: `.opencode/superpowers/runs/${fresh.id}/proposal.md`,
            documents: `.opencode/superpowers/runs/${fresh.id}/documents.json`,
          },
          warnings: prepareWarnings({ prepareMode, designParticipation }),
          documents: `.opencode/superpowers/runs/${fresh.id}/documents.json`,
          next: nextMessageForPrepareMode(prepareMode),
          controller_feedback: buildControllerFeedback(fresh),
        },
        null,
        2,
      )
    },
  })
}

function choosePrepareMode(args: {
  explicit?: PrepareMode
  workflow: WorkflowKind
  entrypoint: WorkflowEntrypoint
  sourceWorkflowID?: string
  hasV5TaskBrief?: boolean
  designMode?: "none" | "brainstorm" | "design"
}): PrepareMode {
  if (args.explicit) return args.explicit
  if (args.designMode === "brainstorm" || args.designMode === "design") return "managed_design"
  if (args.hasV5TaskBrief && args.designMode === "none") return args.workflow === "plan-only" || args.entrypoint === "plan" ? "managed_planning" : "proposal_only"
  if (args.hasV5TaskBrief && !args.designMode) return args.workflow === "plan-only" || args.entrypoint === "plan" ? "managed_planning" : "proposal_only"
  if (args.workflow === "plan-only" || args.entrypoint === "plan") return "managed_planning"
  if (args.workflow === "feature" && args.entrypoint !== "execute" && !args.sourceWorkflowID) return "managed_design"
  return "proposal_only"
}

function prepareDispatchDecisions(mode: PrepareMode) {
  if (mode === "managed_design") {
    return [{
      action: "create_session" as const,
      phase: "design",
      agent: "sp-designer" as const,
      primary_skill: AGENT_SKILL_MAP["sp-designer"],
      reason: "prepare candidate design for controller approval",
    }]
  }
  if (mode === "managed_planning") {
    return [{
      action: "create_session" as const,
      phase: "plan",
      agent: "sp-planner" as const,
      primary_skill: AGENT_SKILL_MAP["sp-planner"],
      reason: "prepare candidate plan and task graph for controller approval",
    }]
  }
  return []
}

function nextMessageForPrepareMode(mode: PrepareMode): string {
  switch (mode) {
    case "managed_design":
      return "Wait for the designer candidate output. Approve it with sp_start(run_id, start_action=\"approve_design\") or request a revision."
    case "managed_planning":
      return "Wait for the planner candidate output. Approve it with sp_start(run_id, start_action=\"approve_plan\") or request a revision."
    default:
      return "Ask the user to approve, revise, or cancel the proposal. Start with sp_start(run_id, start_action=\"start_entrypoint\") only after approval."
  }
}

function buildPreparedProposal(args: {
  request: string
  workflow: WorkflowKind
  sourceWorkflowID?: string
  taskBrief?: NormalizedTaskBrief
  designParticipation?: NormalizedDesignParticipation
}): string {
  const source = args.sourceWorkflowID ? `\n\nSource workflow: ${args.sourceWorkflowID}` : ""
  const design = args.designParticipation
    ? `\n\nDesign participation: ${args.designParticipation.mode}${args.designParticipation.reason ? ` - ${args.designParticipation.reason}` : ""}`
    : ""
  const brief = args.taskBrief
    ? `\n\n## Task Brief\n\n${renderTaskBrief(args.taskBrief)}`
    : ""
  return [`# Superpowers Workflow Proposal`, "", `Workflow: ${args.workflow}`, "", args.request.trim(), brief, design, source].join("\n")
}

type NormalizedTaskBrief = {
  goal: string
  scope?: string
  constraints?: string
  acceptance_criteria?: string
  known_context?: string
  risks?: string
  controller_notes?: string
}

type NormalizedDesignParticipation = {
  mode: "none" | "brainstorm" | "design"
  reason?: string
  blocking_questions_allowed?: boolean
}

type NormalizedConfirmation = {
  required: boolean
  reason?: string
  question?: string
}

function normalizeTaskBrief(value: unknown): NormalizedTaskBrief | undefined {
  if (!value || typeof value !== "object") return undefined
  const input = value as Record<string, unknown>
  if (typeof input.goal !== "string" || !input.goal) return undefined
  return {
    goal: input.goal,
    scope: optionalTaskBriefText(input.scope, "scope"),
    constraints: optionalTaskBriefText(input.constraints, "constraints"),
    acceptance_criteria: optionalTaskBriefText(input.acceptance_criteria, "acceptance_criteria"),
    known_context: optionalTaskBriefText(input.known_context, "known_context"),
    risks: optionalTaskBriefText(input.risks, "risks"),
    controller_notes: optionalTaskBriefText(input.controller_notes, "controller_notes"),
  }
}

function optionalTaskBriefText(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "string") throw new Error(`sp_prepare task_brief.${field} must be a string.`)
  return value
}

function normalizeDesignParticipation(value: unknown): NormalizedDesignParticipation | undefined {
  if (!value || typeof value !== "object") return undefined
  const input = value as Partial<NormalizedDesignParticipation>
  if (!input.mode) return undefined
  return {
    mode: input.mode,
    reason: input.reason,
    blocking_questions_allowed: input.blocking_questions_allowed,
  }
}

function normalizeConfirmation(value: unknown): NormalizedConfirmation {
  if (!value || typeof value !== "object") return { required: true }
  const input = value as Partial<NormalizedConfirmation>
  return {
    required: input.required ?? true,
    reason: input.reason,
    question: input.question,
  }
}

function buildRequestFromTaskBrief(brief: NormalizedTaskBrief): string {
  return [`# Request`, "", renderTaskBrief(brief)].join("\n")
}

function renderTaskBrief(brief: NormalizedTaskBrief): string {
  const sections = [
    `Goal: ${brief.goal}`,
    brief.scope ? `Scope: ${brief.scope}` : undefined,
    textSection("Constraints", brief.constraints),
    textSection("Acceptance Criteria", brief.acceptance_criteria),
    textSection("Known Context", brief.known_context),
    textSection("Risks", brief.risks),
    brief.controller_notes ? `Controller Notes: ${brief.controller_notes}` : undefined,
  ].filter(Boolean)
  return sections.join("\n\n")
}

function textSection(title: string, text?: string): string | undefined {
  if (!text?.trim()) return undefined
  return `${title}:\n${text.trim()}`
}

function buildConfirmationSummary(args: {
  request: string
  workflow: WorkflowKind
  entrypoint: WorkflowEntrypoint
  prepareMode: PrepareMode
  taskBrief?: NormalizedTaskBrief
  designParticipation?: NormalizedDesignParticipation
  confirmation: NormalizedConfirmation
}): string {
  const goal = args.taskBrief?.goal ?? args.request.replace(/^# Request\s*/i, "").trim().split("\n")[0]
  const lines = [
    `Prepared task: ${goal}`,
    `Workflow: ${args.workflow}`,
    `Entrypoint: ${args.entrypoint}`,
    `Prepare mode: ${args.prepareMode}`,
    `Designer participation: ${args.designParticipation?.mode ?? "none"}`,
    `User confirmation required: ${args.confirmation.required ? "yes" : "no"}`,
  ]
  if (args.confirmation.reason) lines.push(`Confirmation reason: ${args.confirmation.reason}`)
  if (args.confirmation.question) lines.push(`Confirmation question: ${args.confirmation.question}`)
  return lines.join("\n")
}

function requiredConfirmations(value: unknown): string[] {
  const confirmation = normalizeConfirmation(value)
  if (!confirmation.required) return []
  return [confirmation.question ?? "Confirm this prepared task before calling sp_start."]
}

function prepareWarnings(args: {
  prepareMode: PrepareMode
  designParticipation?: NormalizedDesignParticipation
}): string[] {
  const warnings: string[] = []
  if (args.prepareMode === "proposal_only" && args.designParticipation?.mode && args.designParticipation.mode !== "none") {
    warnings.push("design_participation requested designer involvement but prepare_mode resolved to proposal_only.")
  }
  if (args.designParticipation?.mode === "none" && args.designParticipation.blocking_questions_allowed) {
    warnings.push("blocking_questions_allowed is ignored when design_participation.mode is none.")
  }
  return warnings
}
