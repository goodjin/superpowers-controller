import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"

describe("deploy-superagent-runtime", () => {
  test("persists global allow permissions and writes a TUI-attaching launcher", () => {
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
    const launcherPath = join(tempHome, ".local", "bin", "superagent")
    expect(existsSync(configPath)).toBe(true)
    expect(existsSync(launcherPath)).toBe(true)

    const config = JSON.parse(readFileSync(configPath, "utf8"))
    expect(config.permission).toBe("allow")

    const launcher = readFileSync(launcherPath, "utf8")
    expect(launcher).toContain(' web --hostname "$HOSTNAME" --port "$PORT"')
    expect(launcher).toContain(' attach "http://$HOSTNAME:$PORT"')
    expect(launcher).toContain('http://$HOSTNAME:$PORT')
  }, 30_000)
})
