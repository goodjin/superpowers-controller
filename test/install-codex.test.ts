import { mkdirSync, mkdtempSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { describe, expect, test } from "bun:test"

describe("install-codex.sh", () => {
  test("documents the public curl install entrypoint", () => {
    const script = readFileSync("scripts/install-codex.sh", "utf8")
    expect(script).toContain("raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install-codex.sh")
    expect(script).toContain("codeload.github.com")
    expect(script).toContain("adapters/codex/scripts/install.mjs")
    expect(script).not.toContain("default.toml")
  })

  test("installs and uninstalls against an isolated CODEX_HOME via local checkout", () => {
    const home = mkdtempSync(join(tmpdir(), "sp-codex-sh-"))
    const codexHome = join(home, ".codex")
    mkdirSync(codexHome, { recursive: true })

    const install = spawnSync("bash", ["scripts/install-codex.sh"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
    })
    expect(install.status).toBe(0)
    expect(install.stdout).toContain("Using local checkout")
    expect(existsSync(join(codexHome, "agents", "superpowers-agent.toml"))).toBe(true)

    const config = readFileSync(join(codexHome, "config.toml"), "utf8")
    expect(config).toContain("multi_agent = true")
    expect(config).toContain("[agents.superpowers-agent]")
    expect(config).not.toContain("[agents.default]")

    const uninstall = spawnSync("bash", ["scripts/uninstall-codex.sh"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, CODEX_HOME: codexHome },
    })
    expect(uninstall.status).toBe(0)
    expect(existsSync(join(codexHome, "agents", "superpowers-agent.toml"))).toBe(false)
  })
})
