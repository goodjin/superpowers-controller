type ChatMessage = {
  role?: string
  content?: unknown
}

type ChatCompletionRequest = {
  model?: string
  messages?: ChatMessage[]
  metadata?: {
    request_id?: unknown
  }
  stream?: boolean
}

type RequestIdInput = {
  headers: Record<string, string | undefined>
  body: ChatCompletionRequest
}

export type TextResponse = {
  type: "text"
  content: string
}

export type ToolCallResponse = {
  type: "tool_call"
  name: string
  arguments: Record<string, unknown>
}

export type MockLlmResponse = TextResponse | ToolCallResponse

export type MockLlmExpectation = {
  request_id: string
  response: MockLlmResponse
}

export type RecordedMockLlmRequest = {
  request_id: string | null
  body: ChatCompletionRequest
  response?: RecordedMockLlmResponse
}

export type RecordedMockLlmResponse =
  | {
      status: 200
      stream: boolean
      type: "text"
      content: string
    }
  | {
      status: 200
      stream: boolean
      type: "tool_call"
      name: string
      arguments: Record<string, unknown>
    }
  | {
      status: number
      stream: false
      type: "error"
      code: string
      message: string
    }

type ExpectationPayload = {
  expectations?: MockLlmExpectation[]
}

export type MockLlmServer = {
  origin: string
  url(path: string): string
  close(): Promise<void>
}

const REQUEST_ID_MARKER = /\[llm_request_id:([A-Za-z0-9._:-]+)\]/

export function extractRequestId(input: RequestIdInput): string | null {
  const metadataRequestId = input.body.metadata?.request_id
  if (typeof metadataRequestId === "string" && metadataRequestId.length > 0) return metadataRequestId

  const headerRequestId = input.headers["x-request-id"]
  if (typeof headerRequestId === "string" && headerRequestId.length > 0) return headerRequestId

  for (const message of input.body.messages ?? []) {
    const content = message.content
    if (typeof content === "string") {
      const match = content.match(REQUEST_ID_MARKER)
      if (match) return match[1]
      continue
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (!isTextPart(part)) continue
        const match = part.text.match(REQUEST_ID_MARKER)
        if (match) return match[1]
      }
    }
  }

  return null
}

export async function createMockLlmServer(): Promise<MockLlmServer> {
  const expectations: MockLlmExpectation[] = []
  const requests: RecordedMockLlmRequest[] = []

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)

      if (request.method === "POST" && url.pathname === "/__mock/reset") {
        expectations.splice(0)
        requests.splice(0)
        return json({ ok: true })
      }

      if (request.method === "POST" && url.pathname === "/__mock/expectations") {
        const payload = (await request.json()) as ExpectationPayload
        for (const expectation of payload.expectations ?? []) {
          expectations.push(expectation)
        }
        return json({ ok: true, count: expectations.length })
      }

      if (request.method === "GET" && url.pathname === "/__mock/requests") {
        return json({ requests })
      }

      if (request.method === "GET" && url.pathname === "/__mock/pending") {
        return json({ expectations })
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        return json({
          object: "list",
          data: [{ id: "test-model", object: "model", created: 0, owned_by: "llm-mock" }],
        })
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const body = (await request.json()) as ChatCompletionRequest
        const requestId = extractRequestId({
          headers: headersToRecord(request.headers),
          body,
        })
        const recordedRequest: RecordedMockLlmRequest = { request_id: requestId, body }
        requests.push(recordedRequest)

        if (!requestId) {
          recordedRequest.response = {
            status: 409,
            stream: false,
            type: "error",
            code: "missing_request_id",
            message: "LLM mock request did not include a request_id marker.",
          }
          return json(
            {
              error: {
                code: recordedRequest.response.code,
                message: recordedRequest.response.message,
              },
            },
            409,
          )
        }

        const index = expectations.findIndex((item) => item.request_id === requestId)
        if (index === -1) {
          recordedRequest.response = {
            status: 409,
            stream: false,
            type: "error",
            code: "unexpected_llm_request",
            message: `No expectation registered for request_id ${requestId}.`,
          }
          return json(
            {
              error: {
                code: recordedRequest.response.code,
                request_id: requestId,
                message: recordedRequest.response.message,
              },
            },
            409,
          )
        }

        const [expectation] = expectations.splice(index, 1)
        recordedRequest.response = toRecordedResponse(expectation.response, body.stream === true)
        if (body.stream === true) return streamChatCompletion(body, requestId, expectation.response)
        return json(toChatCompletion(body, requestId, expectation.response))
      }

      return json({ error: { code: "not_found" } }, 404)
    },
  })

  const origin = `http://${server.hostname}:${server.port}`
  return {
    origin,
    url(path) {
      return `${origin}${path}`
    },
    async close() {
      await server.stop()
    },
  }
}

function toRecordedResponse(response: MockLlmResponse, stream: boolean): RecordedMockLlmResponse {
  if (response.type === "text") {
    return {
      status: 200,
      stream,
      type: "text",
      content: response.content,
    }
  }

  return {
    status: 200,
    stream,
    type: "tool_call",
    name: response.name,
    arguments: response.arguments,
  }
}

function streamChatCompletion(request: ChatCompletionRequest, requestId: string, response: MockLlmResponse): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of toChatCompletionChunks(request, requestId, response)) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`))
      }
      if (request.stream === true) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(toUsageChunk(request, requestId))}\n\n`))
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"))
      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "access-control-allow-origin": "*",
    },
  })
}

function toUsageChunk(request: ChatCompletionRequest, requestId: string): unknown {
  return {
    id: `chatcmpl_${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: request.model ?? "test-model",
    choices: [],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  }
}

function toChatCompletion(request: ChatCompletionRequest, requestId: string, response: MockLlmResponse): unknown {
  return {
    id: `chatcmpl_${requestId}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: request.model ?? "test-model",
    choices: [
      {
        index: 0,
        message: toAssistantMessage(requestId, response),
        finish_reason: response.type === "tool_call" ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: 1,
      completion_tokens: 1,
      total_tokens: 2,
    },
  }
}

function toChatCompletionChunks(request: ChatCompletionRequest, requestId: string, response: MockLlmResponse): unknown[] {
  const base = {
    id: `chatcmpl_${requestId}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: request.model ?? "test-model",
  }

  if (response.type === "text") {
    return [
      {
        ...base,
        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
      },
      {
        ...base,
        choices: [{ index: 0, delta: { content: response.content }, finish_reason: null }],
      },
      {
        ...base,
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      },
    ]
  }

  return [
    {
      ...base,
      choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
    },
    {
      ...base,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_${requestId}`,
                type: "function",
                function: {
                  name: response.name,
                  arguments: JSON.stringify(response.arguments),
                },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    },
    {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    },
  ]
}

function toAssistantMessage(requestId: string, response: MockLlmResponse): unknown {
  if (response.type === "text") {
    return {
      role: "assistant",
      content: response.content,
    }
  }

  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `call_${requestId}`,
        type: "function",
        function: {
          name: response.name,
          arguments: JSON.stringify(response.arguments),
        },
      },
    ],
  }
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {}
  headers.forEach((value, key) => {
    result[key.toLowerCase()] = value
  })
  return result
}

function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: {
      "access-control-allow-origin": "*",
    },
  })
}

function isTextPart(value: unknown): value is { type: "text"; text: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "text" &&
    "text" in value &&
    typeof value.text === "string"
  )
}
