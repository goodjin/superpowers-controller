import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
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

    const output = mergePluginEntry(input, "opencode-superpowers-controller")

    expect(output).toContain("// keep this comment")
    expect(output).toContain('"model": "anthropic/claude"')
    expect(output).toContain('"other-plugin"')
    expect(output).toContain('"opencode-superpowers-controller"')
    expect(output).toContain('"agent"')
  })

  test("does not duplicate existing plugin entry", () => {
    const input = `{
  "plugin": ["opencode-superpowers-controller"]
}
`

    const output = mergePluginEntry(input, "opencode-superpowers-controller")
    const matches = output.match(/opencode-superpowers-controller/g) ?? []

    expect(matches).toHaveLength(1)
  })

  test("installs skills but does not copy command assets because commands are dynamically injected", () => {
    const configDir = mkdtempSync(join(tmpdir(), "sp-install-"))

    install(configDir)

    const skills = readdirSync(join(configDir, "skills")).filter((entry) => entry.startsWith("superpowers-"))
    const commandsDir = join(configDir, "commands")
    const commands = existsSync(commandsDir) ? readdirSync(commandsDir).filter((entry) => entry.startsWith("sp")) : []

    expect(skills.length).toBeGreaterThan(0)
    expect(commands).toHaveLength(0)
  })
})
