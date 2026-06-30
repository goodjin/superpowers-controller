import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { install, mergePluginEntry } from "../src/cli/install"

describe("mergePluginEntry", () => {
  test("adds plugin entry to jsonc content while preserving user fields", () => {
    const input = `{
  // keep this comment
  "model": "anthropic/claude",
  "plugin": ["other-plugin"],
  "agent": {
    "coder": { "model": "openai/gpt-5" }
  }
}
`

    const output = mergePluginEntry(input, "superpowers-controller")

    expect(output).toContain("// keep this comment")
    expect(output).toContain('"model": "anthropic/claude"')
    expect(output).toContain('"other-plugin"')
    expect(output).toContain('"superpowers-controller"')
    expect(output).toContain('"agent"')
  })

  test("does not duplicate existing plugin entry", () => {
    const input = `{
  "plugin": ["superpowers-controller"]
}
`

    const output = mergePluginEntry(input, "superpowers-controller")
    const matches = output.match(/superpowers-controller/g) ?? []

    expect(matches).toHaveLength(1)
  })

  test("installs skills but does not copy command assets because commands are dynamically injected", () => {
    const configDir = mkdtempSync(join(tmpdir(), "sp-install-"))

    install(configDir)

    expect(existsSync(join(configDir, "superpowers-controller.jsonc"))).toBe(true)
    const skills = readdirSync(join(configDir, "skills")).filter((entry) => entry.startsWith("superpowers-"))
    const commandsDir = join(configDir, "commands")
    const commands = existsSync(commandsDir) ? readdirSync(commandsDir).filter((entry) => entry.startsWith("sp")) : []
    const primarySkills = [
      "superpowers-brainstorming",
      "superpowers-dispatching-parallel-agents",
      "superpowers-finishing-a-development-branch",
      "superpowers-requesting-code-review",
      "superpowers-systematic-debugging",
      "superpowers-test-driven-development",
      "superpowers-verification-before-completion",
      "superpowers-writing-plans",
    ]
    const supportSkills = [
      "superpowers-executing-plans",
      "superpowers-receiving-code-review",
      "superpowers-subagent-driven-development",
      "superpowers-using-git-worktrees",
      "superpowers-using-superpowers",
      "superpowers-writing-skills",
    ]

    expect(skills.sort()).toEqual(primarySkills.sort())
    for (const skill of supportSkills) {
      expect(skills).not.toContain(skill)
    }
    expect(commands).toHaveLength(0)
  })

  test("one-click install script installs idempotently through the local CLI", () => {
    const home = mkdtempSync(join(tmpdir(), "sp-install-home-"))
    const binDir = join(home, "bin")
    const fakeOpencode = join(binDir, "opencode")
    mkdirSync(binDir, { recursive: true })
    writeFileSync(fakeOpencode, "#!/usr/bin/env bash\nprintf 'opencode 1.16.2\\n'\n", { mode: 0o755 })

    const env = {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    }

    for (let i = 0; i < 2; i += 1) {
      const result = spawnSync("bash", ["scripts/install.sh"], {
        cwd: process.cwd(),
        env,
        encoding: "utf8",
      })
      expect(result.status, result.stderr || result.stdout).toBe(0)
      expect(result.stdout).toContain("Superpowers Controller installed.")
    }

    const config = readFileSync(join(home, ".config", "opencode", "opencode.jsonc"), "utf8")
    const matches = config.match(/superpowers-controller/g) ?? []
    expect(matches).toHaveLength(1)
    expect(existsSync(join(home, ".config", "opencode", "superpowers-controller.jsonc"))).toBe(true)
    expect(readdirSync(join(home, ".config", "opencode", "skills")).filter((entry) => entry.startsWith("superpowers-")).length).toBeGreaterThan(0)
  }, 30_000)

  test("migrates the legacy plugin config path to the controller config path", () => {
    const configDir = mkdtempSync(join(tmpdir(), "sp-install-legacy-"))
    const legacyConfig = join(configDir, "opencode-superpowers.jsonc")
    writeFileSync(legacyConfig, '{\n  "mode": "strict"\n}\n')

    const paths = install(configDir)

    const nextConfig = join(configDir, "superpowers-controller.jsonc")
    expect(paths).toContain(nextConfig)
    expect(readFileSync(nextConfig, "utf8")).toBe('{\n  "mode": "strict"\n}\n')
    expect(existsSync(legacyConfig)).toBe(true)
  })
})
