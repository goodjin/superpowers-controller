export type E2EScenarioLogger = {
  step(action: string, target: string): void
  verify(result: string): void
  mockInteractions(interactions: MockInteractionForLog[]): void
  stateSnapshot(label: string, state: unknown): void
  artifactSnapshot(name: string, content: string | null): void
}

type MockInteractionForLog = {
  request_id: string | null
  body: {
    model?: string
    messages?: Array<{ role?: string; content?: unknown }>
    stream?: boolean
    tools?: unknown
  }
  response?: unknown
}

type ScenarioSummary = {
  name: string
  status: "passed" | "failed"
  steps: number
  verifications: number
  error?: string
}

export function createE2ELogger(args: { suite: string; description: string }) {
  const summaries: ScenarioSummary[] = []

  return {
    suiteStart() {
      console.log("")
      console.log(`[e2e] 测试套件：${args.suite}`)
      console.log(`[e2e] 测试目标：${args.description}`)
    },
    async scenario(name: string, description: string, run: (log: E2EScenarioLogger) => Promise<void>) {
      let steps = 0
      let verifications = 0
      const startedAt = Date.now()
      const log: E2EScenarioLogger = {
        step(action, target) {
          steps += 1
          console.log(`[e2e] 步骤 ${steps}：${action}`)
          console.log(`[e2e]   验证点：${target}`)
        },
        verify(result) {
          verifications += 1
          console.log(`[e2e] 验证 ${verifications}：通过 - ${result}`)
        },
        mockInteractions(interactions) {
          console.log(`[e2e] mock-server 交互记录：共 ${interactions.length} 次请求`)
          interactions.forEach((interaction, index) => {
            logJsonBlock(`请求 ${index + 1}`, summarizeMockRequest(interaction))
            logJsonBlock(`返回 ${index + 1}`, summarizeMockResponse(interaction.response))
          })
        },
        stateSnapshot(label, state) {
          console.log(`[e2e] 处理流程：${label}`)
          logJsonBlock("状态快照", summarizeWorkflowState(state))
        },
        artifactSnapshot(name, content) {
          logJsonBlock(`产物快照 ${name}`, summarizeArtifact(content))
        },
      }

      console.log("")
      console.log(`[e2e] 测试场景：${name}`)
      console.log(`[e2e] 场景说明：${description}`)

      try {
        await run(log)
        const durationMs = Date.now() - startedAt
        summaries.push({ name, status: "passed", steps, verifications })
        console.log(`[e2e] 场景结果：通过 - ${name}（${steps} 个步骤，${verifications} 个验证，${durationMs}ms）`)
      } catch (error) {
        const durationMs = Date.now() - startedAt
        const message = error instanceof Error ? error.message : String(error)
        summaries.push({ name, status: "failed", steps, verifications, error: message })
        console.log(`[e2e] 场景结果：失败 - ${name}（${steps} 个步骤，${verifications} 个验证，${durationMs}ms）`)
        console.log(`[e2e] 失败原因：${message}`)
        throw error
      }
    },
    suiteSummary() {
      const passed = summaries.filter((summary) => summary.status === "passed").length
      const failed = summaries.length - passed
      const steps = summaries.reduce((total, summary) => total + summary.steps, 0)
      const verifications = summaries.reduce((total, summary) => total + summary.verifications, 0)

      console.log("")
      console.log(`[e2e] 总结：${args.suite}`)
      console.log(`[e2e] 场景数：${summaries.length}，通过：${passed}，失败：${failed}`)
      console.log(`[e2e] 步骤数：${steps}，验证数：${verifications}`)
      for (const summary of summaries) {
        const detail =
          summary.status === "passed"
            ? `${summary.steps} 个步骤，${summary.verifications} 个验证`
            : `${summary.steps} 个步骤，${summary.verifications} 个验证，错误：${summary.error}`
        const status = summary.status === "passed" ? "通过" : "失败"
        console.log(`[e2e] - ${status} ${summary.name}：${detail}`)
      }
    },
  }
}

function summarizeMockRequest(interaction: MockInteractionForLog): Record<string, unknown> {
  const messages = Array.isArray(interaction.body.messages) ? interaction.body.messages : []
  return {
    request_id: interaction.request_id,
    model: interaction.body.model,
    stream: interaction.body.stream === true,
    message_count: messages.length,
    last_messages: messages.slice(-4).map((message) => ({
      role: message.role,
      content: summarizeMessageContent(message.role, message.content),
    })),
    tools: summarizeTools(interaction.body.tools),
  }
}

function summarizeMockResponse(response: unknown): unknown {
  if (!isRecord(response)) return response ?? null
  if (response.type === "tool_call") {
    return {
      status: response.status,
      stream: response.stream,
      type: response.type,
      name: response.name,
      arguments: compactValue(response.arguments),
    }
  }
  if (response.type === "text") {
    return {
      status: response.status,
      stream: response.stream,
      type: response.type,
      content: truncate(String(response.content ?? "")),
    }
  }
  if (response.type === "error") {
    return {
      status: response.status,
      stream: response.stream,
      type: response.type,
      code: response.code,
      message: response.message,
    }
  }
  return compactValue(response)
}

function summarizeWorkflowState(state: unknown): unknown {
  if (!isRecord(state)) return state ?? null
  const gates = isRecord(state.gates) ? state.gates : {}
  const artifacts = isRecord(state.artifacts) ? state.artifacts : {}
  const history = Array.isArray(state.history) ? state.history : []
  return {
    id: state.id,
    mode: state.mode,
    phase: state.phase,
    goal: typeof state.goal === "string" ? truncate(state.goal, 120) : state.goal,
    true_gates: Object.keys(gates).filter((key) => gates[key] === true),
    artifacts,
    history: history.map((entry) => {
      if (!isRecord(entry)) return entry
      return {
        event: entry.event,
        from: entry.from,
        to: entry.to,
        reason: typeof entry.reason === "string" ? truncate(entry.reason, 120) : entry.reason,
      }
    }),
    next: state.next,
  }
}

function summarizeArtifact(content: string | null): Record<string, unknown> {
  if (content === null) {
    return {
      exists: false,
    }
  }
  return {
    exists: true,
    characters: content.length,
    preview: truncate(content.replace(/\s+/g, " "), 180),
  }
}

function summarizeMessageContent(role: string | undefined, content: unknown): unknown {
  if (typeof content === "string") {
    if (role === "system" && content.startsWith("You are opencode")) {
      return `<OpenCode system prompt: ${content.length} chars>`
    }
    const max = role === "tool" ? 700 : 320
    return truncate(content, max)
  }
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (isRecord(part) && part.type === "text" && typeof part.text === "string") {
        return { type: "text", text: truncate(part.text, 320) }
      }
      return compactValue(part)
    })
  }
  return compactValue(content)
}

function summarizeTools(tools: unknown): unknown {
  if (!Array.isArray(tools)) return undefined
  return tools.map((tool) => {
    if (!isRecord(tool)) return compactValue(tool)
    const fn = isRecord(tool.function) ? tool.function : {}
    return {
      type: tool.type,
      name: fn.name,
    }
  })
}

function compactValue(value: unknown): unknown {
  if (typeof value === "string") return truncate(value)
  if (Array.isArray(value)) return value.slice(0, 8).map(compactValue)
  if (!isRecord(value)) return value

  const result: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value).slice(0, 20)) {
    result[key] = compactValue(entry)
  }
  return result
}

function logJsonBlock(label: string, value: unknown): void {
  console.log(`[e2e]   ${label}：`)
  for (const line of stringifyForLog(value).split("\n")) {
    console.log(`[e2e]     ${line}`)
  }
}

function stringifyForLog(value: unknown): string {
  return JSON.stringify(value, null, 2)
}

function truncate(value: string, max = 500): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}...<truncated:${value.length - max}>`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
