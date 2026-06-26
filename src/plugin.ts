import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { createAgentConfig } from "./agents"
import { createCommandConfig } from "./commands"
import { loadConfig } from "./config/load"
import { createNodeProgressStore } from "./progress/node-progress"
import { resolveGlobalPermission } from "./config/permissions"
import { evaluateToolGate } from "./router/gates"
import { createOpenCodeSessionAdapter } from "./session/adapter"
import { createSessionOrchestrator } from "./session/orchestrator"
import { buildRuntimeSkillInjection, hasRuntimeSkillInjection } from "./skills/runtime-injection"
import { createProjectStore } from "./state/store"
import { createTools } from "./tools"

const startupRecoveryProjects = new Set<string>()

export function createPluginModule(): PluginModule {
  const server: Plugin = async (ctx) => {
    const config = loadConfig(ctx.directory)
    const store = createProjectStore(ctx.directory)
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
    const nodeProgress = createNodeProgressStore(ctx.directory)
    const adapter = createOpenCodeSessionAdapter(ctx as Parameters<typeof createOpenCodeSessionAdapter>[0])
    const progress = { report: adapter.showProgress }
    const orchestrator = createSessionOrchestrator(adapter)
    return {
      tool: createTools(store, orchestrator, progress),
      event: async ({ event }) => {
        nodeProgress.recordEvent(store.readCurrent(), event)
      },
      config: async (hostConfig: Record<string, unknown>) => {
        const globalPermission = resolveGlobalPermission(hostConfig.permission)
        hostConfig.agent = {
          ...createAgentConfig({ globalPermission }),
          ...((hostConfig.agent as Record<string, unknown>) ?? {}),
        }
        hostConfig.command = {
          ...createCommandConfig(),
          ...((hostConfig.command as Record<string, unknown>) ?? {}),
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
      "experimental.chat.system.transform": async (_input, output) => {
        const state = store.readCurrent()
        if (!state || output.system.some(hasRuntimeSkillInjection)) return
        output.system.push(buildRuntimeSkillInjection(state))
      },
    }
  }

  return {
    id: "superpowers-controller",
    server,
  }
}
