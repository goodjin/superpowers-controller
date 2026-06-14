import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { createMockLlmServer, type MockLlmExpectation, type RecordedMockLlmRequest } from "../llm-mock/server"
import type { WorkflowState } from "../../../src/state/types"

export type OpencodeRunArgs = {
  title: string
  message: string
  agent?: string
  extraArgs?: string[]
  timeoutMs?: number
}

export type OpencodeRunResult = {
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  error?: unknown
}

export type OpencodeE2EHarness = {
  projectRoot: string
  projectDir: string
  homeDir: string
  mock: {
    origin: string
    expect(expectations: MockLlmExpectation[]): Promise<void>
    requests(): Promise<RecordedMockLlmRequest[]>
    pending(): Promise<MockLlmExpectation[]>
    reset(): Promise<void>
  }
  runOpencode(args: OpencodeRunArgs): Promise<OpencodeRunResult>
  readWorkflowState(): WorkflowState | null
  readLastWorkflowState(): WorkflowState | null
  readArtifact(name: string): string | null
  readLastArtifact(name: string): string | null
  close(): Promise<void>
}

type HarnessOptions = {
  projectRoot?: string
  config?: Record<string, unknown>
  workflowConfig?: Record<string, unknown>
}

const DEFAULT_TIMEOUT_MS = 30_000

export async function createOpencodeE2EHarness(options: HarnessOptions = {}): Promise<OpencodeE2EHarness> {
  const projectRoot = options.projectRoot ?? resolve(import.meta.dir, "../../..")
  const opencodeBin = join(projectRoot, "tools", "opencode-1.16.2", "node_modules", ".bin", "opencode")
  const pluginEntry = `file://${join(projectRoot, "dist", "index.js")}`
  const homeDir = mkdtempSync(join(tmpdir(), "sp-opencode-e2e-home-"))
  const projectDir = mkdtempSync(join(tmpdir(), "sp-opencode-e2e-project-"))
  const mockServer = await createMockLlmServer()
  writeWorkflowConfig(projectDir, options.workflowConfig)
  writeOpencodeConfig({
    homeDir,
    mockOrigin: mockServer.origin,
    pluginEntry,
    config: options.config ?? {},
  })

  return {
    projectRoot,
    projectDir,
    homeDir,
    mock: {
      origin: mockServer.origin,
      async expect(expectations) {
        await post(mockServer.url("/__mock/expectations"), { expectations })
      },
      async requests() {
        const payload = (await fetch(mockServer.url("/__mock/requests")).then((response) => response.json())) as {
          requests: RecordedMockLlmRequest[]
        }
        return payload.requests
      },
      async pending() {
        const payload = (await fetch(mockServer.url("/__mock/pending")).then((response) => response.json())) as {
          expectations: MockLlmExpectation[]
        }
        return payload.expectations
      },
      async reset() {
        await post(mockServer.url("/__mock/reset"), {})
      },
    },
    async runOpencode(args) {
      const commandArgs = [
        "run",
        "--model",
        "llm-mock/test-model",
        "--format",
        "json",
        "--title",
        args.title,
        "--dir",
        projectDir,
        ...(args.agent ? ["--agent", args.agent] : []),
        ...(args.extraArgs ?? []),
        args.message,
      ]
      return runCommand(opencodeBin, commandArgs, projectDir, isolatedEnv(homeDir), args.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    },
    readWorkflowState() {
      return readWorkflowState(projectDir)
    },
    readLastWorkflowState() {
      return readLastWorkflowState(projectDir)
    },
    readArtifact(name) {
      const state = readWorkflowState(projectDir)
      if (!state) return null
      const artifactPath = join(projectDir, ".opencode", "superpowers", "runs", state.id, "artifacts", `${name}.md`)
      if (!existsSync(artifactPath)) return null
      return readFileSync(artifactPath, "utf8")
    },
    readLastArtifact(name) {
      const state = readLastWorkflowState(projectDir)
      if (!state) return null
      const artifactPath = join(projectDir, ".opencode", "superpowers", "runs", state.id, "artifacts", `${name}.md`)
      if (!existsSync(artifactPath)) return null
      return readFileSync(artifactPath, "utf8")
    },
    async close() {
      await mockServer.close()
      rmSync(homeDir, { recursive: true, force: true })
      rmSync(projectDir, { recursive: true, force: true })
    },
  }
}

function readLastWorkflowState(projectDir: string): WorkflowState | null {
  const runsRoot = join(projectDir, ".opencode", "superpowers", "runs")
  if (!existsSync(runsRoot)) return null
  const runIDs = readdirSync(runsRoot)
    .map((run) => ({ run, mtime: statSync(join(runsRoot, run)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  const latest = runIDs[0]?.run
  if (!latest) return null
  const statePath = join(runsRoot, latest, "state.json")
  if (!existsSync(statePath)) return null
  return JSON.parse(readFileSync(statePath, "utf8")) as WorkflowState
}

function readWorkflowState(projectDir: string): WorkflowState | null {
  const currentPath = join(projectDir, ".opencode", "superpowers", "current.json")
  if (!existsSync(currentPath)) return null
  const pointer = JSON.parse(readFileSync(currentPath, "utf8")) as { run: string }
  const statePath = join(projectDir, ".opencode", "superpowers", "runs", pointer.run, "state.json")
  if (!existsSync(statePath)) return null
  return JSON.parse(readFileSync(statePath, "utf8")) as WorkflowState
}

function writeWorkflowConfig(projectDir: string, config: Record<string, unknown> | undefined): void {
  if (!config) return
  const configPath = join(projectDir, ".opencode", "superpowers.jsonc")
  mkdirSync(join(projectDir, ".opencode"), { recursive: true })
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

function writeOpencodeConfig(args: {
  homeDir: string
  mockOrigin: string
  pluginEntry: string
  config: Record<string, unknown>
}): void {
  const configDir = join(args.homeDir, ".config", "opencode")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(
    join(configDir, "opencode.jsonc"),
    `${JSON.stringify(
      {
        plugin: [args.pluginEntry],
        model: "llm-mock/test-model",
        enabled_providers: ["llm-mock"],
        provider: {
          "llm-mock": {
            npm: "@ai-sdk/openai-compatible",
            name: "LLM Mock",
            options: {
              baseURL: `${args.mockOrigin}/v1`,
              apiKey: "mock-api-key",
            },
            models: {
              "test-model": {
                name: "Test Model",
              },
            },
          },
        },
        ...args.config,
      },
      null,
      2,
    )}\n`,
  )
}

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    OPENCODE_DISABLE_UPDATE_CHECK: "1",
    OPENCODE_SUPERPOWERS_DISABLE_CHILD_PROMPT: "1",
    NO_COLOR: "1",
  }
}

async function post(url: string, body: unknown): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    throw new Error(`POST ${url} failed: ${response.status} ${await response.text()}`)
  }
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<OpencodeRunResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    let error: unknown
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, timeoutMs)

    child.stdout.setEncoding("utf8")
    child.stderr.setEncoding("utf8")
    child.stdout.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", (value) => {
      error = value
    })
    child.on("close", (code, signal) => {
      clearTimeout(timer)
      resolve({
        code,
        signal,
        stdout,
        stderr,
        error: timedOut ? new Error(`timed out after ${timeoutMs}ms`) : error,
      })
    })
  })
}
