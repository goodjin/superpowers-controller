import { afterEach, describe, expect, test } from "bun:test"
import { createMockLlmServer, extractRequestId } from "./llm-mock/server"

let server: Awaited<ReturnType<typeof createMockLlmServer>> | null = null

afterEach(async () => {
  await server?.close()
  server = null
})

describe("extractRequestId", () => {
  test("reads request id from message marker", () => {
    const requestId = extractRequestId({
      headers: {},
      body: {
        messages: [
          { role: "system", content: "system prompt" },
          { role: "user", content: "[llm_request_id:debug-route-001] /sp-debug fix tests" },
        ],
      },
    })

    expect(requestId).toBe("debug-route-001")
  })

  test("prefers metadata over headers and message marker", () => {
    const requestId = extractRequestId({
      headers: { "x-request-id": "from-header" },
      body: {
        metadata: { request_id: "from-metadata" },
        messages: [{ role: "user", content: "[llm_request_id:from-message]" }],
      },
    })

    expect(requestId).toBe("from-metadata")
  })
})

describe("mock LLM server", () => {
  test("returns the response registered for the request id marker", async () => {
    server = await createMockLlmServer()

    await post(server.url("/__mock/expectations"), {
      expectations: [
        {
          request_id: "route-debug",
          response: {
            type: "tool_call",
            name: "sp_route",
            arguments: {
              request: "/sp-debug fix tests",
              command: "/sp-debug",
            },
          },
        },
      ],
    })

    const response = await post(server.url("/v1/chat/completions"), {
      model: "test-model",
      messages: [{ role: "user", content: "[llm_request_id:route-debug] /sp-debug fix tests" }],
      tools: [
        {
          type: "function",
          function: {
            name: "sp_route",
            parameters: {},
          },
        },
      ],
    })

    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.choices[0].message.tool_calls[0].function.name).toBe("sp_route")
    expect(body.choices[0].message.tool_calls[0].function.arguments).toBe(
      JSON.stringify({ request: "/sp-debug fix tests", command: "/sp-debug" }),
    )

    const pending = await fetch(server.url("/__mock/pending")).then((item) => item.json())
    expect(pending.expectations).toEqual([])

    const recorded = await fetch(server.url("/__mock/requests")).then((item) => item.json())
    expect(recorded.requests[0].response).toMatchObject({
      status: 200,
      stream: false,
      type: "tool_call",
      name: "sp_route",
      arguments: {
        request: "/sp-debug fix tests",
        command: "/sp-debug",
      },
    })
  })

  test("returns 409 when no expectation is registered for the request id", async () => {
    server = await createMockLlmServer()

    const response = await post(server.url("/v1/chat/completions"), {
      model: "test-model",
      messages: [{ role: "user", content: "[llm_request_id:missing] hello" }],
    })

    expect(response.status).toBe(409)
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "unexpected_llm_request",
        request_id: "missing",
      },
    })

    const recorded = await fetch(server.url("/__mock/requests")).then((item) => item.json())
    expect(recorded.requests[0].response).toMatchObject({
      status: 409,
      stream: false,
      type: "error",
      code: "unexpected_llm_request",
    })
  })

  test("streams text responses when stream is true", async () => {
    server = await createMockLlmServer()

    await post(server.url("/__mock/expectations"), {
      expectations: [
        {
          request_id: "stream-text",
          response: {
            type: "text",
            content: "mocked stream",
          },
        },
      ],
    })

    const response = await post(server.url("/v1/chat/completions"), {
      model: "test-model",
      stream: true,
      messages: [{ role: "user", content: "[llm_request_id:stream-text] hello" }],
    })

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toContain("text/event-stream")
    const body = await response.text()
    expect(body).toContain('"delta":{"content":"mocked stream"}')
    expect(body).toContain('"usage":{"prompt_tokens":1,"completion_tokens":1,"total_tokens":2}')
    expect(body).toContain("data: [DONE]")
  })
})

async function post(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}
