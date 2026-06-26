import type { DispatchDecision } from "../router/transition"
import type { SessionAdapter } from "./adapter"
import { buildNodeTaskPrompt } from "./templates"
import type { NodeTaskPacket } from "./task-packet"

export type SessionDispatchResult = {
  action: "create_session" | "reuse_session"
  session_id: string
  task_markdown: string
}

export type SessionResumeResult = {
  action: "resume_session"
  session_id: string
}

export type SessionOrchestrator = ReturnType<typeof createSessionOrchestrator>

export function createSessionOrchestrator(adapter: SessionAdapter) {
  return {
    async dispatch(args: {
      project: string
      runID: string
      parentSessionID: string
      decision: Extract<DispatchDecision, { action: "create_session" | "reuse_session" }>
      packet: NodeTaskPacket
      onSessionCreated?: (args: { sessionID: string; taskMarkdown: string }) => Promise<void>
    }): Promise<SessionDispatchResult> {
      const taskMarkdown = buildNodeTaskPrompt(args.packet)
      await adapter.showProgress({
        stage: "dispatch_started",
        title: "Superpowers dispatch",
        message: `Starting ${args.decision.agent} for ${args.packet.node_id}.`,
        variant: "info",
      })
      if (args.decision.action === "reuse_session") {
        if (args.onSessionCreated) {
          await args.onSessionCreated({
            sessionID: args.decision.session_id,
            taskMarkdown,
          })
        }
        const scheduled = scheduleNodePrompt(adapter, {
          sessionID: args.decision.session_id,
          agent: args.decision.agent,
          prompt: taskMarkdown,
          failure: {
            stage: "dispatch_failed",
            title: "Superpowers dispatch",
            message: `Failed to prompt ${args.decision.agent} for ${args.packet.node_id}.`,
            variant: "error",
          },
        })
        if (shouldAwaitScheduledPrompt()) await scheduled
        await adapter.showProgress({
          stage: "node_running",
          title: "Superpowers dispatch",
          message: `Scheduled ${args.decision.agent} for ${args.packet.node_id}.`,
          variant: "info",
        })
        return {
          action: "reuse_session",
          session_id: args.decision.session_id,
          task_markdown: taskMarkdown,
        }
      }

      const sessionID = await adapter.createNodeSession({
        parentSessionID: args.parentSessionID,
        title: `${args.packet.phase}${args.packet.task_id ? ` ${args.packet.task_id}` : ""}`,
        agent: args.decision.agent,
      })
      if (args.onSessionCreated) {
        await args.onSessionCreated({
          sessionID,
          taskMarkdown,
        })
      }
      const scheduled = scheduleNodePrompt(adapter, {
        sessionID,
        agent: args.decision.agent,
        prompt: taskMarkdown,
        failure: {
          stage: "dispatch_failed",
          title: "Superpowers dispatch",
          message: `Failed to prompt ${args.decision.agent} for ${args.packet.node_id}.`,
          variant: "error",
        },
      })
      if (shouldAwaitScheduledPrompt()) await scheduled
      await adapter.showProgress({
        stage: "node_running",
        title: "Superpowers dispatch",
        message: `Scheduled ${args.decision.agent} for ${args.packet.node_id}.`,
        variant: "success",
      })
      return {
        action: "create_session",
        session_id: sessionID,
        task_markdown: taskMarkdown,
      }
    },
    async resumeNode(args: {
      sessionID: string
      agent: string
      prompt: string
    }): Promise<SessionResumeResult> {
      const scheduled = scheduleNodePrompt(adapter, {
        sessionID: args.sessionID,
        agent: args.agent,
        prompt: args.prompt,
        failure: {
          stage: "dispatch_failed",
          title: "Superpowers dispatch",
          message: `Failed to resume ${args.agent} in ${args.sessionID}.`,
          variant: "error",
        },
      })
      if (shouldAwaitScheduledPrompt()) await scheduled
      await adapter.showProgress({
        stage: "node_resumed",
        title: "Superpowers dispatch",
        message: `Scheduled resume for ${args.agent} in ${args.sessionID}.`,
        variant: "info",
      })
      return {
        action: "resume_session",
        session_id: args.sessionID,
      }
    },
    async notifyParent(args: {
      sessionID: string
      agent: string
      prompt: string
    }): Promise<void> {
      const scheduled = scheduleNodePrompt(adapter, {
        sessionID: args.sessionID,
        agent: args.agent,
        prompt: args.prompt,
        failure: {
          stage: "dispatch_failed",
          title: "Superpowers workflow",
          message: "Failed to notify controller session about pending user input.",
          variant: "error",
        },
      })
      if (shouldAwaitScheduledPrompt()) await scheduled
      await adapter.showProgress({
        stage: "parent_notified",
        title: "Superpowers workflow",
        message: "Scheduled controller session notification about pending user input.",
        variant: "warning",
      })
    },
  }
}

function scheduleNodePrompt(
  adapter: SessionAdapter,
  args: {
    sessionID: string
    agent: string
    prompt: string
    failure: {
      stage: "dispatch_failed"
      title: string
      message: string
      variant: "info" | "success" | "warning" | "error"
    }
  },
): Promise<void> {
  const scheduled = (async () => {
    try {
      await adapter.continueNodeSession({
        sessionID: args.sessionID,
        agent: args.agent,
        prompt: args.prompt,
      })
    } catch (error) {
      await adapter.showProgress({
        ...args.failure,
        message: `${args.failure.message} ${errorMessage(error)}`,
      })
    }
  })()
  void scheduled.catch(() => {})
  return scheduled
}

function shouldAwaitScheduledPrompt(): boolean {
  return process.env.OPENCODE_SUPERPOWERS_E2E_CHILD_REQUEST_MARKERS === "1"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Unknown error."
}
