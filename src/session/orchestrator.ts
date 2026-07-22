import { existsSync, readFileSync } from "node:fs"
import { isAbsolute, join, normalize } from "node:path"
import type { DispatchDecision } from "../router/transition"
import type { SessionAdapter } from "./adapter"
import { isDesignForegroundPhase } from "./design-foreground"
import { buildNodeTaskPrompt } from "./templates"
import type { NodeTaskPacket } from "./task-packet"
import type { WorkflowState } from "../state/types"
import { projectRunRoot } from "../state/paths"

export type SessionDispatchResult = {
  action: "create_session" | "reuse_session"
  session_id: string
  task_markdown: string
}

export type SessionResumeResult = {
  action: "resume_session"
  session_id: string
}

export type SessionHandoffResult = {
  action: "clean_handoff"
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
      onPromptDeliveryFailed?: (args: { sessionID: string; agent: string; nodeID: string; error: unknown }) => void | Promise<void>
      readStateForProgress?: () => WorkflowState | null
    }): Promise<SessionDispatchResult> {
      const packet = inlineRequiredArtifacts({
        project: args.project,
        runID: args.runID,
        packet: args.packet,
      })
      const taskMarkdown = buildNodeTaskPrompt(packet)
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
          nodeID: args.packet.node_id,
          prompt: taskMarkdown,
          onPromptDeliveryFailed: args.onPromptDeliveryFailed,
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
        await maybeFocusDesignSession(adapter, {
          phase: args.decision.phase,
          sessionID: args.decision.session_id,
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
      const scheduledCreate = scheduleNodePrompt(adapter, {
        sessionID,
        agent: args.decision.agent,
        nodeID: args.packet.node_id,
        prompt: taskMarkdown,
        onPromptDeliveryFailed: args.onPromptDeliveryFailed,
        failure: {
          stage: "dispatch_failed",
          title: "Superpowers dispatch",
          message: `Failed to prompt ${args.decision.agent} for ${args.packet.node_id}.`,
          variant: "error",
        },
      })
      if (shouldAwaitScheduledPrompt()) await scheduledCreate
      await adapter.showProgress({
        stage: "node_running",
        title: "Superpowers dispatch",
        message: `Scheduled ${args.decision.agent} for ${args.packet.node_id}.`,
        variant: "success",
      })
      await maybeFocusDesignSession(adapter, {
        phase: args.decision.phase,
        sessionID,
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
      phase?: string
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
      selectSession?: boolean
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
      if (args.selectSession !== false && adapter.selectSession) {
        await adapter.selectSession({
          sessionID: args.sessionID,
          reason: "pending user input",
        })
      }
      await adapter.showProgress({
        stage: "parent_notified",
        title: "Superpowers workflow",
        message: "Scheduled controller session notification about pending user input.",
        variant: "warning",
      })
    },
    async handoffController(args: {
      title: string
      agent?: string
      prompt: string
      selectSession?: boolean
    }): Promise<SessionHandoffResult> {
      const agent = args.agent ?? "superpowers-agent"
      const sessionID = await adapter.createControllerSession({
        title: args.title,
        agent,
      })
      const scheduled = scheduleNodePrompt(adapter, {
        sessionID,
        agent,
        prompt: args.prompt,
        failure: {
          stage: "dispatch_failed",
          title: "Superpowers workflow",
          message: "Failed to prompt clean controller handoff session.",
          variant: "error",
        },
      })
      if (shouldAwaitScheduledPrompt()) await scheduled
      if (args.selectSession !== false && adapter.selectSession) {
        await adapter.selectSession({
          sessionID,
          reason: "clean controller handoff",
        })
      }
      await adapter.showProgress({
        stage: "parent_notified",
        title: "Superpowers workflow",
        message: `Opened clean controller session ${sessionID}.`,
        variant: "success",
      })
      return {
        action: "clean_handoff",
        session_id: sessionID,
      }
    },
    async returnToParent(args: {
      sessionID: string
      message?: string
    }): Promise<void> {
      if (adapter.selectSession) {
        await adapter.selectSession({
          sessionID: args.sessionID,
          reason: "left design foreground",
        })
      }
      await adapter.showProgress({
        stage: "session_focused",
        title: "Superpowers workflow",
        message: args.message ?? "design 已结束，已切回主控。",
        variant: "info",
      })
    },
  }
}

function inlineRequiredArtifacts(args: {
  project: string
  runID: string
  packet: NodeTaskPacket
}): NodeTaskPacket {
  if (args.packet.required_artifacts.length === 0) return args.packet
  const runRoot = projectRunRoot(args.project, args.runID)
  return {
    ...args.packet,
    source_artifacts: args.packet.required_artifacts.map((artifact) => {
      const path = resolveArtifactPath(runRoot, artifact.path)
      if (!path) {
        return {
          ...artifact,
          missing: "artifact path escapes the workflow run directory.",
        }
      }
      if (!existsSync(path)) {
        return {
          ...artifact,
          missing: `not found under ${runRoot}`,
        }
      }
      return {
        ...artifact,
        body: readFileSync(path, "utf8"),
      }
    }),
  }
}

function resolveArtifactPath(runRoot: string, artifactPath: string): string | null {
  const path = isAbsolute(artifactPath) ? normalize(artifactPath) : normalize(join(runRoot, artifactPath))
  const normalizedRunRoot = normalize(runRoot)
  if (path !== normalizedRunRoot && !path.startsWith(`${normalizedRunRoot}/`)) return null
  return path
}

function scheduleNodePrompt(
  adapter: SessionAdapter,
  args: {
    sessionID: string
    agent: string
    nodeID?: string
    prompt: string
    onPromptDeliveryFailed?: (args: { sessionID: string; agent: string; nodeID: string; error: unknown }) => void | Promise<void>
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
      if (args.onPromptDeliveryFailed && args.nodeID) {
        await args.onPromptDeliveryFailed({
          sessionID: args.sessionID,
          agent: args.agent,
          nodeID: args.nodeID,
          error,
        })
      }
      await adapter.showProgress({
        ...args.failure,
        message: `${args.failure.message} ${errorMessage(error)}`,
      })
    }
  })()
  void scheduled.catch(() => {})
  return scheduled
}

async function maybeFocusDesignSession(
  adapter: SessionAdapter,
  args: {
    phase: string
    sessionID: string
  },
): Promise<void> {
  if (!adapter.selectSession) return
  if (!isDesignForegroundPhase(args.phase)) return
  await adapter.selectSession({
    sessionID: args.sessionID,
    reason: "design foreground",
  })
  await adapter.showProgress({
    stage: "session_focused",
    title: "Superpowers workflow",
    message: "已进入 design 子会话，可直接对话。",
    variant: "info",
  })
}

function shouldAwaitScheduledPrompt(): boolean {
  return process.env.OPENCODE_SUPERPOWERS_E2E_CHILD_REQUEST_MARKERS === "1"
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message
  if (typeof error === "string" && error) return error
  return "Unknown error."
}
