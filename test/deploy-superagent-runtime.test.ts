import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { createServer } from "node:net"
import type { AddressInfo } from "node:net"

describe("deploy-superagent-runtime", () => {
  test("persists global allow permissions and writes a superpowers-agent TUI launcher", () => {
    const tempHome = mkdtempSync(join(tmpdir(), "sp-superagent-home-"))
    const runtimeRoot = mkdtempSync(join(tmpdir(), "sp-superagent-runtime-"))

    const result = spawnSync("bash", ["scripts/deploy-superagent-runtime.sh", "deploy"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: tempHome,
        SUPERAGENT_ROOT: runtimeRoot,
        SUPERAGENT_PORT: "5996",
      },
      encoding: "utf8",
    })

    expect(result.status, result.stderr || result.stdout).toBe(0)

    const configPath = join(runtimeRoot, "home", ".config", "opencode", "opencode.json")
    const tuiConfigPath = join(runtimeRoot, "home", ".config", "opencode", "tui.json")
    const launcherPath = join(tempHome, ".local", "bin", "superagent")
    expect(existsSync(configPath)).toBe(true)
    expect(existsSync(tuiConfigPath)).toBe(true)
    expect(existsSync(launcherPath)).toBe(true)

    const config = JSON.parse(readFileSync(configPath, "utf8"))
    expect(config.permission).toBe("allow")
    expect(config.plugin).toEqual([`file://${process.cwd()}/dist/index.js`])

    const tuiConfig = JSON.parse(readFileSync(tuiConfigPath, "utf8"))
    expect(tuiConfig.plugin).toEqual([`file://${process.cwd()}/dist/tui.js`])

    const launcher = readFileSync(launcherPath, "utf8")
    expect(launcher).not.toContain(" web --hostname ")
    expect(launcher).not.toContain(" attach ")
    expect(launcher).toContain('PROJECT_DIR="${SUPERAGENT_PROJECT_DIR:-$PWD}"')
    expect(launcher).not.toContain('PROJECT_DIR="$ROOT/project"')
    expect(launcher).toContain(`DEPLOY_SCRIPT="${process.cwd()}/scripts/deploy-superagent-runtime.sh"`)
    expect(launcher).toContain('start|stop|restart|status)')
    expect(launcher).toContain('exec "$DEPLOY_SCRIPT" "$1"')
    expect(launcher).toContain('--agent "superpowers-agent"')
  }, 180_000)

  test("stop falls back to the port listener when the pid file is stale", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "sp-superagent-home-"))
    const runtimeRoot = mkdtempSync(join(tmpdir(), "sp-superagent-runtime-"))
    const port = await getAvailablePort()
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const server = Bun.serve({ hostname: "127.0.0.1", port: ${port}, fetch() { return new Response("ok") } }); console.log("ready:" + server.port); setInterval(() => {}, 1000);`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    )

    try {
      await waitForOutput(child, "ready:")
      writeFileSync(join(runtimeRoot, "superagent.pid"), "999999\n")

      const result = spawnSync("bash", ["scripts/deploy-superagent-runtime.sh", "stop"], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: tempHome,
          SUPERAGENT_ROOT: runtimeRoot,
          SUPERAGENT_PORT: String(port),
        },
        encoding: "utf8",
      })

      expect(result.status, result.stderr || result.stdout).toBe(0)
      expect(await waitForExit(child, 5_000)).toBe("exited")
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGKILL")
      }
    }
  }, 30_000)

  test("start leaves the server listening after the deploy script exits", async () => {
    const tempHome = mkdtempSync(join(tmpdir(), "sp-superagent-home-"))
    const runtimeRoot = mkdtempSync(join(tmpdir(), "sp-superagent-runtime-"))
    const port = await getAvailablePort()
    const env = {
      ...process.env,
      HOME: tempHome,
      SUPERAGENT_ROOT: runtimeRoot,
      SUPERAGENT_PORT: String(port),
    }

    try {
      const start = spawnSync("bash", ["scripts/deploy-superagent-runtime.sh", "start"], {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
      })
      expect(start.status, start.stderr || start.stdout).toBe(0)

      await sleep(2_000)

      const status = spawnSync("bash", ["scripts/deploy-superagent-runtime.sh", "status"], {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
      })
      expect(status.stdout).toContain(`Superagent running at http://127.0.0.1:${port}`)
      const response = await fetch(`http://127.0.0.1:${port}/`)
      expect(response.ok).toBe(true)
      expect(await response.text()).toContain("/assets/index-")
    } finally {
      spawnSync("bash", ["scripts/deploy-superagent-runtime.sh", "stop"], {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
      })
    }
  }, 180_000)
})

async function getAvailablePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address() as AddressInfo
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.close(() => resolve())
  })
  return address.port
}

async function waitForOutput(child: ReturnType<typeof spawn>, needle: string): Promise<void> {
  let output = ""
  await new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      output += chunk.toString("utf8")
      if (output.includes(needle)) {
        cleanup()
        resolve()
      }
    }
    const onExit = () => {
      cleanup()
      reject(new Error(`process exited before output ${needle}`))
    }
    const cleanup = () => {
      child.stdout?.off("data", onData)
      child.off("exit", onExit)
    }
    child.stdout?.on("data", onData)
    child.once("exit", onExit)
  })
}

async function waitForExit(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<"exited" | "timeout"> {
  if (child.exitCode !== null) return "exited"
  return await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off("exit", onExit)
      resolve("timeout")
    }, timeoutMs)
    const onExit = () => {
      clearTimeout(timer)
      resolve("exited")
    }
    child.once("exit", onExit)
  })
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms))
}
