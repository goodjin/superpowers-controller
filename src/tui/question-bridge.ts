import type { WorkflowState } from "../state/types"

export type QuestionOption = {
  label: string
  description: string
}

export type QuestionInfo = {
  question: string
  header: string
  options: QuestionOption[]
  multiple?: boolean
  custom?: boolean
}

export type QuestionRequest = {
  id: string
  sessionID: string
  questions: QuestionInfo[]
}

export type QuestionAction =
  | {
      type: "reply"
      requestID: string
      sessionID: string
      label: string
      description: string
      answers: string[][]
    }
  | {
      type: "reject"
      requestID: string
      sessionID: string
      label: string
      description: string
    }

export type QuestionBridgeClient = {
  list(project: string): Promise<QuestionRequest[]>
  reply(sessionID: string, requestID: string, answers: string[][]): Promise<void>
  reject(sessionID: string, requestID: string): Promise<void>
}

export function createHttpQuestionBridgeClient(baseURL = defaultQuestionApiBaseURL()): QuestionBridgeClient {
  return {
    async list(project) {
      const url = new URL("/api/question/request", baseURL)
      url.searchParams.set("location[directory]", project)
      const response = await fetch(url)
      if (!response.ok) throw new Error(`question list failed: ${response.status}`)
      const body = await response.json() as { data?: QuestionRequest[] }
      return Array.isArray(body.data) ? body.data : []
    },
    async reply(sessionID, requestID, answers) {
      const response = await fetch(new URL(`/api/session/${sessionID}/question/request/${requestID}/reply`, baseURL), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ answers }),
      })
      if (!response.ok) throw new Error(`question reply failed: ${response.status}`)
    },
    async reject(sessionID, requestID) {
      const response = await fetch(new URL(`/api/session/${sessionID}/question/request/${requestID}/reject`, baseURL), {
        method: "POST",
      })
      if (!response.ok) throw new Error(`question reject failed: ${response.status}`)
    },
  }
}

export function filterWorkflowQuestionRequests(
  state: WorkflowState | null,
  requests: QuestionRequest[],
): QuestionRequest[] {
  if (!state) return []
  const childSessions = new Set(state.node_runs.map((node) => node.session_id))
  return requests.filter((request) => childSessions.has(request.sessionID))
}

export function buildQuestionActions(requests: QuestionRequest[]): QuestionAction[] {
  const actions: QuestionAction[] = []
  for (const request of requests) {
    const firstQuestion = request.questions[0]
    if (firstQuestion) {
      for (const option of firstQuestion.options) {
        actions.push({
          type: "reply",
          requestID: request.id,
          sessionID: request.sessionID,
          label: `Reply: ${option.label}`,
          description: `${firstQuestion.header}: ${firstQuestion.question}`,
          answers: [[option.label]],
        })
      }
    }
    actions.push({
      type: "reject",
      requestID: request.id,
      sessionID: request.sessionID,
      label: "Reject question",
      description: firstQuestion ? `${firstQuestion.header}: ${firstQuestion.question}` : request.id,
    })
  }
  return actions
}

export function renderQuestionBridgeText(requests: QuestionRequest[]): string {
  if (requests.length === 0) return "No pending child questions."
  const lines = [`${requests.length} pending child question${requests.length === 1 ? "" : "s"}.`]
  for (const request of requests) {
    lines.push("")
    lines.push(`Session: ${request.sessionID}`)
    lines.push(`Request: ${request.id}`)
    request.questions.forEach((question, index) => {
      lines.push(`${index + 1}. ${question.header}: ${question.question}`)
      if (question.options.length > 0) {
        lines.push(`   Options: ${question.options.map((option) => option.label).join(" / ")}`)
      }
    })
  }
  return lines.join("\n")
}

export function renderSidebarQuestionText(requests: QuestionRequest[], maxRequests = 2): string {
  if (requests.length === 0) return ""
  const lines = [`SP pending child question${requests.length === 1 ? "" : "s"}`]
  for (const request of requests.slice(0, maxRequests)) {
    const first = request.questions[0]
    if (!first) continue
    lines.push(`${first.header}: ${first.question}`)
    if (first.options.length > 0) {
      lines.push(`Options: ${first.options.map((option) => option.label).join(" / ")}`)
    }
  }
  if (requests.length > maxRequests) lines.push(`+${requests.length - maxRequests} more`)
  return lines.join("\n")
}

export function renderCompactQuestionText(requests: QuestionRequest[]): string {
  const request = requests[0]
  const question = request?.questions[0]
  if (!request || !question) return ""
  return truncateLine(`SP Q: ${question.header} - ${question.question}`)
}

function defaultQuestionApiBaseURL(): string {
  return `http://127.0.0.1:${process.env.SUPERAGENT_PORT ?? process.env.OPENCODE_PORT ?? "5096"}`
}

function truncateLine(value: string, max = 120): string {
  return value.length > max ? `${value.slice(0, max - 3)}...` : value
}
