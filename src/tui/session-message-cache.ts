import { appendFileSync, mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { projectStateRoot } from "../state/paths"
import type { SessionMessageReader } from "./live-activity"

type CachedSessionMessages = {
  at: number
  messages: ReadonlyArray<unknown>
}

const cache = new Map<string, CachedSessionMessages>()
const inflight = new Map<string, Promise<ReadonlyArray<unknown>>>()

export type SessionMessageClient = {
  session?: {
    messages?(input: { path: { id: string } }): Promise<{ data?: unknown } | ReadonlyArray<unknown> | unknown>
  }
}

export function createSessionMessageReader(
  api: {
    state?: {
      session?: {
        messages?(sessionID: string): ReadonlyArray<unknown>
      }
      path?: { directory?: string }
      part?(messageID: string): ReadonlyArray<unknown>
    }
    client?: SessionMessageClient
  },
): SessionMessageReader {
  return {
    messages(sessionID: string) {
      const live = api.state?.session?.messages?.(sessionID)
      if (Array.isArray(live) && live.length > 0) return live
      const cached = cache.get(sessionID)
      if (cached && Date.now() - cached.at < 30_000) return cached.messages
      return live ?? cached?.messages ?? []
    },
    part: api.state?.part?.bind(api.state),
  }
}

export function primeSessionMessageCache(
  api: {
    state?: {
      session?: {
        messages?(sessionID: string): ReadonlyArray<unknown>
      }
      path?: { directory?: string }
    }
    client?: SessionMessageClient
  },
  sessionIDs: string[],
): void {
  for (const sessionID of sessionIDs) {
    if (!sessionID || inflight.has(sessionID)) continue
    void refreshSessionMessageCache(api, sessionID)
  }
}

export async function refreshSessionMessageCache(
  api: {
    state?: {
      session?: {
        messages?(sessionID: string): ReadonlyArray<unknown>
      }
      path?: { directory?: string }
    }
    client?: SessionMessageClient
  },
  sessionID: string,
): Promise<ReadonlyArray<unknown>> {
  const existing = inflight.get(sessionID)
  if (existing) return existing

  const request = (async () => {
    const live = api.state?.session?.messages?.(sessionID)
    if (Array.isArray(live) && live.length > 0) {
      cache.set(sessionID, { at: Date.now(), messages: live })
      return live
    }
    const fetch = api.client?.session?.messages
    if (!fetch) return cache.get(sessionID)?.messages ?? []
    try {
      const response = await fetch({ path: { id: sessionID } })
      const messages = unwrapMessages(response)
      if (messages.length > 0) {
        cache.set(sessionID, { at: Date.now(), messages })
      }
      return messages
    } catch {
      return cache.get(sessionID)?.messages ?? []
    } finally {
      inflight.delete(sessionID)
    }
  })()

  inflight.set(sessionID, request)
  return request
}

export function sidebarDebugLogPath(projectDirectory?: string): string {
  if (projectDirectory) {
    return join(projectStateRoot(projectDirectory), "sidebar-debug.log")
  }
  return join(process.env.HOME ?? "/tmp", ".local", "share", "superpowers", "sidebar.log")
}

export function appendSidebarDebugLog(projectDirectory: string | undefined, line: string): void {
  try {
    const path = sidebarDebugLogPath(projectDirectory)
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, `${line}\n`, "utf8")
  } catch {
    // ignore log failures
  }
}

function unwrapMessages(response: unknown): ReadonlyArray<unknown> {
  if (Array.isArray(response)) return response
  if (!response || typeof response !== "object") return []
  const record = response as Record<string, unknown>
  if (Array.isArray(record.messages)) return record.messages
  if (record.data && typeof record.data === "object") {
    const data = record.data as Record<string, unknown>
    if (Array.isArray(data.messages)) return data.messages
  }
  return []
}
