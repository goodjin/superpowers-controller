import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createAgentConfig } from "./agents"
import { loadConfig } from "./config/load"
import { createNodeProgressStore } from "./progress/node-progress"
import { resolveGlobalPermission } from "./config/permissions"
import { evaluateToolGate } from "./router/gates"
import { createOpenCodeSessionAdapter } from "./session/adapter"
import { createSessionOrchestrator } from "./session/orchestrator"
import { buildRuntimeSkillInjection, hasRuntimeSkillInjection } from "./skills/runtime-injection"
import { createProjectStore } from "./state/store"
import { createTools } from "./tools"
import { createLivenessMonitor } from "./runtime/liveness"

const startupRecoveryProjects = new Set<string>()

export function createPluginModule(): PluginModule {
  const server: Plugin = async (ctx) => {
    const startupStart = Date.now()
    let stepStart = startupStart
    const logStartupTiming = async (label: string, startedAt: number) => {
      try {
        await ctx.client.app.log({
          body: {
            service: "superpowers-controller",
            level: "info",
            message: `[timing] startup ${label}: ${Date.now() - startedAt}ms`,
          },
        })
      } catch {
        // Startup timing is diagnostic only; logging failure must not block plugin loading.
      }
    }

    const config = loadConfig(ctx.directory)
    await logStartupTiming("config load", stepStart)
    stepStart = Date.now()
    const store = createProjectStore(ctx.directory, { reconcileOnLoad: true })
    await logStartupTiming("store init", stepStart)
    stepStart = Date.now()
    if (!startupRecoveryProjects.has(ctx.directory)) {
      startupRecoveryProjects.add(ctx.directory)
      const recovered = store.recoverInterruptedRunningNodes({
        reason: "Plugin process started; persisted running child sessions cannot be assumed live after startup.",
      })
      if (recovered?.status === "recovered_unknown") {
        await ctx.client.app.log({
          body: {
            service: "superpowers-controller",
            level: "warn",
            message: `Recovered workflow ${recovered.id} with interrupted running node sessions after plugin startup.`,
          },
        })
      }
    }
    await logStartupTiming("startup recovery", stepStart)
    stepStart = Date.now()
    const nodeProgress = createNodeProgressStore(ctx.directory)
    const adapter = createOpenCodeSessionAdapter(ctx as Parameters<typeof createOpenCodeSessionAdapter>[0])
    const progress = { report: adapter.showProgress }
    const orchestrator = createSessionOrchestrator(adapter)
    if (config.liveness.enabled) {
      createLivenessMonitor({
        readState: () => store.readCurrent(),
        readProgressByNode: (state) => nodeProgress.readRun(state),
        timeoutMs: config.liveness.timeout_ms,
        intervalMs: config.liveness.check_interval_ms,
        onExpired: (entry) => {
          const updated = store.markLivenessExpired({
            session_id: entry.node.session_id,
            idle_ms: entry.idle_ms,
          })
          if (updated) {
            void adapter.showProgress({
              stage: "workflow_blocked",
              title: "Superpowers workflow",
              message: `Node ${updated.id} had no progress for ${entry.idle_ms}ms and was marked interrupted.`,
              variant: "warning",
            })
          }
        },
      })
    }
    await logStartupTiming("runtime wiring", stepStart)
    await logStartupTiming("total", startupStart)
    return {
      tool: createTools(store, orchestrator, progress, config),
      event: async ({ event }) => {
        const state = store.readCurrent()
        const entry = nodeProgress.recordEvent(state, event)
        if (entry && isWaitingPermissionEvent(event)) {
          await adapter.selectSession?.({
            sessionID: entry.session_id,
            reason: "child session waiting for permission",
          })
          await adapter.showProgress({
            stage: "child_waiting_permission",
            title: "Superpowers workflow",
            message: `Child session ${entry.session_id} is waiting for permission.`,
            variant: "warning",
          })
          return
        }
        if (event.type === "session.error" && state) {
          const sessionID = event.properties.sessionID
          if (!sessionID) return
          const updated = store.markSessionError({
            session_id: sessionID,
            error: event.properties.error,
          })
          if (updated) {
            await adapter.showProgress({
              stage: "workflow_blocked",
              title: "Superpowers workflow",
              message: `Child session ${sessionID} reported an error; node ${updated.id} is now ${updated.status}.`,
              variant: "error",
            })
          }
        }
      },
      config: async (hostConfig: Record<string, unknown>) => {
        const globalPermission = resolveGlobalPermission(hostConfig.permission)
        hostConfig.agent = {
          ...((hostConfig.agent as Record<string, unknown>) ?? {}),
          ...createAgentConfig({ globalPermission }),
        }
      },
      "tool.execute.before": async (input, output) => {
        const gate = evaluateToolGate({
          config,
          state: store.readCurrent(),
          agent: (input as { agent?: string }).agent,
          tool: input.tool,
          args: output.args,
        })
        if (!gate.allowed) {
          throw new Error(`[superpowers-controller] ${gate.reason}`)
        }
        if (gate.severity === "warning") {
          await ctx.client.app.log({
            body: {
              service: "superpowers-controller",
              level: "warn",
              message: gate.reason,
            },
          })
        }
      },
      "experimental.chat.system.transform": async (input, output) => {
        const state = store.readCurrent()
        if (!state || output.system.some(hasRuntimeSkillInjection)) return
        const node = state.node_runs.find((run) => run.session_id === input.sessionID)
        if (!node) return
        output.system.push(buildRuntimeSkillInjection(state, node))
      },
    }
  }

  return {
    id: "superpowers-controller",
    server,
  }
}

function isWaitingPermissionEvent(event: { type: string; properties?: unknown }): boolean {
  if (event.type !== "session.status") return false
  const properties = event.properties
  if (!properties || typeof properties !== "object") return false
  const status = (properties as { status?: unknown }).status
  return Boolean(status && typeof status === "object" && (status as { type?: unknown }).type === "waiting_permission")
}
