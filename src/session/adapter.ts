import type { ProgressUpdate } from "../progress/reporter"

export type SessionAdapter = {
  createNodeSession(input: {
    parentSessionID: string
    title: string
    agent: string
  }): Promise<string>

  continueNodeSession(input: {
    sessionID: string
    agent: string
    prompt: string
  }): Promise<void>

  showProgress(input: ProgressUpdate): Promise<void>
}

type OpenCodePluginContext = {
  client: {
    session?: {
      create?: (...args: never[]) => Promise<unknown>
      prompt?: (...args: never[]) => Promise<unknown>
    }
    tui?: {
      showToast?: (...args: never[]) => Promise<unknown>
    }
    app?: {
      log?: (...args: never[]) => Promise<unknown>
    }
  }
}

export function createOpenCodeSessionAdapter(ctx: OpenCodePluginContext): SessionAdapter {
  async function continueNodeSession(input: { sessionID: string; agent: string; prompt: string }): Promise<void> {
    if (process.env.OPENCODE_SUPERPOWERS_DISABLE_CHILD_PROMPT === "1") return
    const methods = process.env.OPENCODE_SUPERPOWERS_E2E_CHILD_REQUEST_MARKERS === "1"
      ? ["prompt"]
      : ["promptAsync", "prompt"]
    await callFirstMethod(ctx.client.session, methods, {
      path: { id: input.sessionID },
      body: {
        agent: input.agent,
        parts: [{ type: "text", text: input.prompt }],
      },
    })
  }

  return {
    async createNodeSession(input) {
      if (process.env.OPENCODE_SUPERPOWERS_DISABLE_CHILD_PROMPT === "1") {
        return `session-suppressed-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      }
      const created = await callMethod(ctx.client.session, "create", {
        body: {
          parentID: input.parentSessionID,
          title: input.title,
          agent: input.agent,
        },
      })
      const sessionID = extractSessionID(created)
      if (!sessionID) throw new Error("OpenCode session.create did not return a session id")
      return sessionID
    },
    continueNodeSession,
    async showProgress(input) {
      if (ctx.client.tui?.showToast) {
        await callMethod(ctx.client.tui, "showToast", { body: input })
        return
      }
      await callMethod(ctx.client.app, "log", {
        body: {
          service: "superpowers-controller",
          level: input.variant === "error" ? "error" : input.variant === "warning" ? "warn" : "info",
          message: `${input.title}: ${input.message}`,
        },
      })
    },
  }
}

async function callMethod(target: unknown, method: string, input: unknown): Promise<unknown> {
  if (!isRecord(target)) return undefined
  const fn = target[method]
  if (typeof fn !== "function") return undefined
  return fn.call(target, input)
}

async function callFirstMethod(target: unknown, methods: string[], input: unknown): Promise<unknown> {
  if (!isRecord(target)) return undefined
  for (const method of methods) {
    const fn = target[method]
    if (typeof fn === "function") return fn.call(target, input)
  }
  throw new Error(`OpenCode client is missing required method: ${methods.join(" or ")}`)
}

function extractSessionID(value: unknown): string | null {
  if (!isRecord(value)) return null
  if (typeof value.id === "string") return value.id
  if (isRecord(value.data) && typeof value.data.id === "string") return value.data.id
  if (isRecord(value.session) && typeof value.session.id === "string") return value.session.id
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
