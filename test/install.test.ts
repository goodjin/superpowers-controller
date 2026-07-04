import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawnSync } from "node:child_process"
import { install, mergeDefaultAgent, mergePluginEntry, mergeTuiPluginEntry } from "../src/cli/install"
import { doctor, MIN_OPENCODE_VERSION } from "../src/cli/doctor"

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
    expect(output).toContain('"default_agent": "super-agent"')
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

  test("sets the OpenCode default agent to super-agent", () => {
    const output = mergeDefaultAgent(`{
  "default_agent": "general"
}
`)

    expect(output).toContain('"default_agent": "super-agent"')
    expect(output).not.toContain('"general"')
  })

  test("adds the TUI plugin entry while preserving existing TUI config", () => {
    const output = mergeTuiPluginEntry(`{
  // keep theme
  "theme": "system",
  "plugin": ["other-tui-plugin"]
}
`)

    expect(output).toContain("// keep theme")
    expect(output).toContain('"theme": "system"')
    expect(output).toContain('"other-tui-plugin"')
    expect(output).toContain('"superpowers-controller/tui"')
    expect(output).toContain('"$schema": "https://opencode.ai/tui.json"')
  })

  test("installs skills without copying command assets", () => {
    const configDir = mkdtempSync(join(tmpdir(), "sp-install-"))

    install(configDir)

    expect(existsSync(join(configDir, "superpowers-controller.jsonc"))).toBe(true)
    expect(readFileSync(join(configDir, "tui.jsonc"), "utf8")).toContain('"superpowers-controller/tui"')
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
    const cacheRoot = join(home, ".cache", "opencode", "packages")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(join(cacheRoot, "superpowers-controller", "node_modules", "superpowers-controller"), { recursive: true })
    mkdirSync(join(cacheRoot, "superpowers-controller@latest", "node_modules", "superpowers-controller"), { recursive: true })
    mkdirSync(join(cacheRoot, "opencode-superpowers-controller@latest"), { recursive: true })
    mkdirSync(join(cacheRoot, "other-plugin"), { recursive: true })
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
    const tuiConfig = readFileSync(join(home, ".config", "opencode", "tui.jsonc"), "utf8")
    const matches = config.match(/superpowers-controller/g) ?? []
    const tuiMatches = tuiConfig.match(/superpowers-controller\/tui/g) ?? []
    expect(matches).toHaveLength(1)
    expect(tuiMatches).toHaveLength(1)
    expect(config).toContain('"default_agent": "super-agent"')
    expect(existsSync(join(home, ".config", "opencode", "superpowers-controller.jsonc"))).toBe(true)
    expect(readdirSync(join(home, ".config", "opencode", "skills")).filter((entry) => entry.startsWith("superpowers-")).length).toBeGreaterThan(0)
    expect(existsSync(join(cacheRoot, "superpowers-controller"))).toBe(false)
    expect(existsSync(join(cacheRoot, "superpowers-controller@latest"))).toBe(false)
    expect(existsSync(join(cacheRoot, "opencode-superpowers-controller@latest"))).toBe(false)
    expect(existsSync(join(cacheRoot, "other-plugin"))).toBe(true)
  }, 30_000)

  test("one-click install script works when piped into bash", () => {
    const home = mkdtempSync(join(tmpdir(), "sp-install-pipe-home-"))
    const temp = join(home, "tmp")
    const binDir = join(home, "bin")
    const cacheRoot = join(home, ".cache", "opencode", "packages")
    const fakeOpencode = join(binDir, "opencode")
    const fakeBunx = join(binDir, "bunx")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(temp, { recursive: true })
    mkdirSync(cacheRoot, { recursive: true })
    writeFileSync(join(cacheRoot, "package.json"), JSON.stringify({ dependencies: { "oh-my-opencode": "latest" } }, null, 2))
    writeFileSync(fakeOpencode, "#!/usr/bin/env bash\nprintf 'opencode 1.17.13\\n'\n", { mode: 0o755 })
    writeFileSync(fakeBunx, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "superpowers-controller@latest" ]]; then
  echo "unexpected bunx package: $1" >&2
  exit 2
fi
shift
exec bun run "${process.cwd()}/src/cli/index.ts" "$@"
`, { mode: 0o755 })

    const script = readFileSync("scripts/install.sh", "utf8")
    const result = spawnSync("bash", {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TMPDIR: `${temp}/`,
      },
      input: script,
      encoding: "utf8",
    })

    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stderr).not.toContain("BASH_SOURCE")
    expect(result.stdout).toContain("Superpowers Controller installed.")
    expect(readFileSync(join(home, ".config", "opencode", "tui.jsonc"), "utf8")).toContain("superpowers-controller/tui")
  }, 30_000)

  test("one-click install script fails fast when remote bunx times out", () => {
    const home = mkdtempSync(join(tmpdir(), "sp-install-timeout-home-"))
    const temp = join(home, "tmp")
    const binDir = join(home, "bin")
    const fakeBunx = join(binDir, "bunx")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(temp, { recursive: true })
    writeFileSync(fakeBunx, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" != "superpowers-controller@latest" ]]; then
  echo "unexpected bunx package: $1" >&2
  exit 2
fi
exit 124
`, { mode: 0o755 })

    const script = readFileSync("scripts/install.sh", "utf8")
    const result = spawnSync("bash", {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TMPDIR: `${temp}/`,
        SUPERPOWERS_CONTROLLER_INSTALL_TIMEOUT_SECONDS: "1",
      },
      input: script,
      encoding: "utf8",
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("bunx timed out after 1s")
    expect(result.stderr).toContain("install command failed")
  }, 30_000)

  test("one-click install script fails fast when OpenCode plugin refresh times out", () => {
    const home = mkdtempSync(join(tmpdir(), "sp-install-opencode-timeout-home-"))
    const temp = join(home, "tmp")
    const binDir = join(home, "bin")
    const fakeOpencode = join(binDir, "opencode")
    const fakeBunx = join(binDir, "bunx")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(temp, { recursive: true })
    writeFileSync(fakeOpencode, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "plugin" ]]; then
  exit 124
fi
printf 'opencode 1.17.13\\n'
`, { mode: 0o755 })
    writeFileSync(fakeBunx, `#!/usr/bin/env bash
set -euo pipefail
shift
exec bun run "${process.cwd()}/src/cli/index.ts" "$@"
`, { mode: 0o755 })

    const script = readFileSync("scripts/install.sh", "utf8")
    const result = spawnSync("bash", {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TMPDIR: `${temp}/`,
        SUPERPOWERS_CONTROLLER_INSTALL_TIMEOUT_SECONDS: "1",
      },
      input: script,
      encoding: "utf8",
    })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("OpenCode plugin refresh timed out after 1s")
    expect(result.stderr).toContain("failed to refresh OpenCode plugin cache")
  }, 30_000)

  test("one-click install script seeds OpenCode cache from the bunx package cache", () => {
    const home = mkdtempSync(join(tmpdir(), "sp-install-seed-cache-home-"))
    const temp = join(home, "tmp")
    const binDir = join(home, "bin")
    const cacheRoot = join(home, ".cache", "opencode", "packages")
    const fakeOpencode = join(binDir, "opencode")
    const fakeBunx = join(binDir, "bunx")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(temp, { recursive: true })
    mkdirSync(cacheRoot, { recursive: true })
    writeFileSync(join(cacheRoot, "package.json"), JSON.stringify({ dependencies: { "oh-my-opencode": "latest" } }, null, 2))
    writeFileSync(fakeOpencode, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "plugin" ]]; then
  echo "plugin refresh should have used bunx cache" >&2
  exit 2
fi
printf 'opencode 1.17.13\\n'
`, { mode: 0o755 })
    writeFileSync(fakeBunx, `#!/usr/bin/env bash
set -euo pipefail
package_dir="\${TMPDIR%/}/bunx-\$(id -u)-superpowers-controller@latest/node_modules/superpowers-controller"
mkdir -p "$package_dir"
printf '{"name":"superpowers-controller","version":"9.9.9"}\\n' > "$package_dir/package.json"
shift
exec bun run "${process.cwd()}/src/cli/index.ts" "$@"
`, { mode: 0o755 })

    const script = readFileSync("scripts/install.sh", "utf8")
    const result = spawnSync("bash", {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TMPDIR: `${temp}/`,
      },
      input: script,
      encoding: "utf8",
    })

    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain("Seeded OpenCode plugin cache from bunx package cache")
    expect(readFileSync(join(home, ".cache", "opencode", "packages", "node_modules", "superpowers-controller", "package.json"), "utf8")).toContain('"version":"9.9.9"')
    const packageRoot = JSON.parse(readFileSync(join(cacheRoot, "package.json"), "utf8"))
    expect(packageRoot.dependencies["superpowers-controller"]).toBe("latest")
    expect(packageRoot.dependencies["oh-my-opencode"]).toBeUndefined()
  }, 30_000)

  test("one-click install script can skip OpenCode plugin cache refresh", () => {
    const home = mkdtempSync(join(tmpdir(), "sp-install-skip-refresh-home-"))
    const temp = join(home, "tmp")
    const binDir = join(home, "bin")
    const fakeOpencode = join(binDir, "opencode")
    const fakeBunx = join(binDir, "bunx")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(temp, { recursive: true })
    writeFileSync(fakeOpencode, `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "plugin" ]]; then
  echo "plugin refresh should have been skipped" >&2
  exit 2
fi
printf 'opencode 1.17.13\\n'
`, { mode: 0o755 })
    writeFileSync(fakeBunx, `#!/usr/bin/env bash
set -euo pipefail
shift
exec bun run "${process.cwd()}/src/cli/index.ts" "$@"
`, { mode: 0o755 })

    const script = readFileSync("scripts/install.sh", "utf8")
    const result = spawnSync("bash", {
      cwd: process.cwd(),
      env: {
        ...process.env,
        HOME: home,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        TMPDIR: `${temp}/`,
        SUPERPOWERS_CONTROLLER_SKIP_OPENCODE_REFRESH: "1",
      },
      input: script,
      encoding: "utf8",
    })

    expect(result.status, result.stderr || result.stdout).toBe(0)
    expect(result.stdout).toContain("Skipping OpenCode plugin cache refresh")
    expect(result.stdout).toContain("Superpowers Controller installed.")
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

  test("doctor reports missing TUI plugin entry", () => {
    const home = mkdtempSync(join(tmpdir(), "sp-doctor-tui-"))
    const binDir = join(home, "bin")
    const configDir = join(home, ".config", "opencode")
    mkdirSync(binDir, { recursive: true })
    mkdirSync(configDir, { recursive: true })
    writeFileSync(join(binDir, "opencode"), "#!/usr/bin/env bash\nprintf '1.17.13\\n'\n", { mode: 0o755 })

    install(configDir)
    writeFileSync(join(configDir, "tui.jsonc"), '{\n  "plugin": []\n}\n')

    const tuiCheck = doctor(
      configDir,
      home,
      { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    ).find((check) => check.name === "tui-plugin-entry")

    expect(tuiCheck?.ok).toBe(false)
    expect(tuiCheck?.detail).toBe(join(configDir, "tui.jsonc"))
  })

  test("doctor rejects OpenCode versions older than the verified runtime", () => {
    const home = mkdtempSync(join(tmpdir(), "sp-doctor-home-"))
    const binDir = join(home, "bin")
    mkdirSync(binDir, { recursive: true })
    writeFileSync(join(binDir, "opencode"), "#!/usr/bin/env bash\nprintf '1.3.10\\n'\n", { mode: 0o755 })

    install(join(home, ".config", "opencode"))
    const opencodeCheck = doctor(
      join(home, ".config", "opencode"),
      home,
      { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
    ).find((check) => check.name === "opencode")
    expect(opencodeCheck?.ok).toBe(false)
    expect(opencodeCheck?.detail).toContain(`requires >= ${MIN_OPENCODE_VERSION}`)
  })

})
