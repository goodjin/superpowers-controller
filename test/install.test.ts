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
    expect(output).toContain('"default_agent": "superpowers-agent"')
    expect(output).toContain('"permission": "allow"')
    expect(output).toContain('"agent"')
  })

  test("does not overwrite an existing host permission setting", () => {
    const input = `{
  "permission": {
    "bash": "ask"
  }
}
`
    const output = mergePluginEntry(input, "superpowers-controller")
    expect(output).toContain('"bash": "ask"')
    expect(output).not.toContain('"permission": "allow"')
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

  test("sets the OpenCode default agent to superpowers-agent", () => {
    const output = mergeDefaultAgent(`{
  "default_agent": "general"
}
`)

    expect(output).toContain('"default_agent": "superpowers-agent"')
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
    expect(output).toContain('"superpowers-controller"')
    expect(output).not.toContain('"superpowers-controller/tui"')
    expect(output).toContain('"$schema": "https://opencode.ai/tui.json"')
  })

  test("migrates legacy package/tui TUI entry to the npm package name", () => {
    const output = mergeTuiPluginEntry(`{
  "plugin": ["superpowers-controller/tui", "other-tui-plugin"]
}
`)

    expect(output).toContain('"other-tui-plugin"')
    expect(output).toContain('"superpowers-controller"')
    expect(output).not.toContain('"superpowers-controller/tui"')
  })

  test("installs skills without copying command assets", () => {
    const configDir = mkdtempSync(join(tmpdir(), "sp-install-"))

    install(configDir)

    expect(existsSync(join(configDir, "superpowers-controller.jsonc"))).toBe(true)
    expect(readFileSync(join(configDir, "tui.jsonc"), "utf8")).toContain('"superpowers-controller"')
    expect(readFileSync(join(configDir, "tui.jsonc"), "utf8")).not.toContain('"superpowers-controller/tui"')
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
    const temp = join(home, "tmp")
    const binDir = join(home, "bin")
    const fakeOpencode = join(binDir, "opencode")
    const cacheRoot = join(home, ".cache", "opencode", "packages")
    const uid = process.getuid?.() ?? 0
    mkdirSync(binDir, { recursive: true })
    mkdirSync(temp, { recursive: true })
    mkdirSync(join(cacheRoot, "superpowers-controller", "node_modules", "superpowers-controller"), { recursive: true })
    mkdirSync(join(cacheRoot, "superpowers-controller@latest", "node_modules", "superpowers-controller"), { recursive: true })
    mkdirSync(join(cacheRoot, "opencode-superpowers-controller@latest"), { recursive: true })
    mkdirSync(join(cacheRoot, "node_modules", "superpowers-controller"), { recursive: true })
    mkdirSync(join(cacheRoot, "node_modules", "oh-my-opencode"), { recursive: true })
    mkdirSync(join(cacheRoot, "node_modules", "oh-my-opencode-darwin-arm64"), { recursive: true })
    mkdirSync(join(cacheRoot, "node_modules", ".bin"), { recursive: true })
    writeFileSync(join(cacheRoot, "node_modules", ".bin", "superpowers-controller"), "#!/usr/bin/env bash\n", { mode: 0o755 })
    mkdirSync(join(temp, `bunx-${uid}-superpowers-controller@latest`), { recursive: true })
    mkdirSync(join(temp, `bunx-${uid}-oh-my-opencode@latest`), { recursive: true })
    mkdirSync(join(temp, `bunx-${uid}-opencode-superpowers-controller@latest`), { recursive: true })
    mkdirSync(join(cacheRoot, "other-plugin"), { recursive: true })
    mkdirSync(join(home, ".config", "opencode", "node_modules", "@opencode-ai", "plugin"), { recursive: true })
    mkdirSync(join(home, ".config", "opencode", "node_modules", "@mem9", "opencode"), { recursive: true })
    mkdirSync(join(home, ".config", "opencode", "node_modules", "oh-my-openagent"), { recursive: true })
    mkdirSync(join(home, ".opencode", "node_modules", "@opencode-ai", "plugin"), { recursive: true })
    mkdirSync(join(home, ".opencode", "node_modules", "opencode-superpowers-controller"), { recursive: true })
    writeFileSync(join(cacheRoot, "package.json"), JSON.stringify({ dependencies: { "superpowers-controller": "0.0.1", "oh-my-opencode": "latest", "other-plugin": "latest" } }, null, 2))
    writeFileSync(join(cacheRoot, "node_modules", ".bin", "oh-my-opencode"), "#!/usr/bin/env bash\n", { mode: 0o755 })
    writeFileSync(join(home, ".config", "opencode", "package.json"), JSON.stringify({ dependencies: { "@opencode-ai/plugin": "1.3.10", "@mem9/opencode": "file:///tmp/mem9", "superpowers-controller": "0.0.1", "oh-my-openagent": "latest" } }, null, 2))
    writeFileSync(join(home, ".config", "opencode", "package-lock.json"), "{}\n")
    writeFileSync(join(home, ".config", "opencode", "oh-my-openagent.json"), "{}\n")
    writeFileSync(join(home, ".opencode", "package.json"), JSON.stringify({ dependencies: { "@opencode-ai/plugin": "1.4.0", "superpowers-controller": "0.0.1", "opencode-superpowers-controller": "latest" } }, null, 2))
    writeFileSync(join(home, ".opencode", "package-lock.json"), "{}\n")
    writeFileSync(join(home, ".opencode", "oh-my-opencode.jsonc"), "{}\n")
    writeFileSync(fakeOpencode, "#!/usr/bin/env bash\nprintf 'opencode 1.16.2\\n'\n", { mode: 0o755 })

    const env = {
      ...process.env,
      HOME: home,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
      TMPDIR: `${temp}/`,
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
    const matches = config.match(/"superpowers-controller"/g) ?? []
    const tuiMatches = tuiConfig.match(/"superpowers-controller"/g) ?? []
    expect(matches).toHaveLength(1)
    expect(tuiMatches).toHaveLength(1)
    expect(tuiConfig).not.toContain("superpowers-controller/tui")
    expect(config).toContain('"default_agent": "superpowers-agent"')
    expect(existsSync(join(home, ".config", "opencode", "superpowers-controller.jsonc"))).toBe(true)
    expect(readdirSync(join(home, ".config", "opencode", "skills")).filter((entry) => entry.startsWith("superpowers-")).length).toBeGreaterThan(0)
    expect(existsSync(join(cacheRoot, "superpowers-controller", "node_modules", "superpowers-controller", "package.json"))).toBe(true)
    expect(existsSync(join(cacheRoot, "superpowers-controller@latest", "node_modules", "superpowers-controller", "package.json"))).toBe(true)
    expect(existsSync(join(cacheRoot, "opencode-superpowers-controller@latest"))).toBe(true)
    expect(existsSync(join(cacheRoot, "node_modules", "superpowers-controller"))).toBe(true)
    for (const seeded of [
      join(cacheRoot, "node_modules", "superpowers-controller"),
      join(cacheRoot, "superpowers-controller", "node_modules", "superpowers-controller"),
      join(cacheRoot, "superpowers-controller@latest", "node_modules", "superpowers-controller"),
    ]) {
      expect(existsSync(join(seeded, "node_modules", "@opencode-ai", "plugin", "package.json")), seeded).toBe(true)
      expect(existsSync(join(seeded, "node_modules", "@opencode-ai", "plugin", "dist", "tool.js")), seeded).toBe(true)
    }
    expect(existsSync(join(cacheRoot, "node_modules", "oh-my-opencode"))).toBe(true)
    expect(existsSync(join(cacheRoot, "node_modules", "oh-my-opencode-darwin-arm64"))).toBe(true)
    expect(existsSync(join(cacheRoot, "node_modules", ".bin", "superpowers-controller"))).toBe(false)
    expect(existsSync(join(cacheRoot, "node_modules", ".bin", "oh-my-opencode"))).toBe(true)
    expect(existsSync(join(cacheRoot, "other-plugin"))).toBe(true)
    const cacheManifest = JSON.parse(readFileSync(join(cacheRoot, "package.json"), "utf8"))
    expect(cacheManifest.dependencies["superpowers-controller"]).toBe("latest")
    expect(cacheManifest.dependencies["other-plugin"]).toBe("latest")
    expect(cacheManifest.dependencies["oh-my-opencode"]).toBe("latest")
    const directCacheManifest = JSON.parse(readFileSync(join(cacheRoot, "superpowers-controller", "package.json"), "utf8"))
    const latestCacheManifest = JSON.parse(readFileSync(join(cacheRoot, "superpowers-controller@latest", "package.json"), "utf8"))
    expect(directCacheManifest.dependencies["superpowers-controller"]).toBeTruthy()
    expect(latestCacheManifest.dependencies["superpowers-controller"]).toBeTruthy()
    const userPackage = JSON.parse(readFileSync(join(home, ".config", "opencode", "package.json"), "utf8"))
    expect(userPackage.dependencies["@opencode-ai/plugin"]).toBe("1.3.10")
    expect(userPackage.dependencies["@mem9/opencode"]).toBe("file:///tmp/mem9")
    expect(userPackage.dependencies["superpowers-controller"]).toBeUndefined()
    expect(userPackage.dependencies["oh-my-openagent"]).toBe("latest")
    expect(existsSync(join(home, ".config", "opencode", "package-lock.json"))).toBe(false)
    expect(existsSync(join(home, ".config", "opencode", "node_modules", "@opencode-ai", "plugin"))).toBe(true)
    expect(existsSync(join(home, ".config", "opencode", "node_modules", "@mem9", "opencode"))).toBe(true)
    expect(existsSync(join(home, ".config", "opencode", "node_modules", "oh-my-openagent"))).toBe(true)
    expect(existsSync(join(home, ".config", "opencode", "oh-my-openagent.json"))).toBe(true)
    const homePackage = JSON.parse(readFileSync(join(home, ".opencode", "package.json"), "utf8"))
    expect(homePackage.dependencies["@opencode-ai/plugin"]).toBe("1.4.0")
    expect(homePackage.dependencies["superpowers-controller"]).toBeUndefined()
    expect(homePackage.dependencies["opencode-superpowers-controller"]).toBe("latest")
    expect(existsSync(join(home, ".opencode", "package-lock.json"))).toBe(false)
    expect(existsSync(join(home, ".opencode", "node_modules", "@opencode-ai", "plugin"))).toBe(true)
    expect(existsSync(join(home, ".opencode", "node_modules", "opencode-superpowers-controller"))).toBe(true)
    expect(existsSync(join(home, ".opencode", "oh-my-opencode.jsonc"))).toBe(true)
    expect(existsSync(join(temp, `bunx-${uid}-superpowers-controller@latest`))).toBe(false)
    expect(existsSync(join(temp, `bunx-${uid}-oh-my-opencode@latest`))).toBe(true)
    expect(existsSync(join(temp, `bunx-${uid}-opencode-superpowers-controller@latest`))).toBe(true)
  }, 120_000)

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
    const tuiConfig = readFileSync(join(home, ".config", "opencode", "tui.jsonc"), "utf8")
    expect(tuiConfig).toContain('"superpowers-controller"')
    expect(tuiConfig).not.toContain("superpowers-controller/tui")
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
printf '%s\\n' '{"name":"superpowers-controller","version":"9.9.9","dependencies":{"@opencode-ai/plugin":"^1.15.4"}}' > "$package_dir/package.json"
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
    expect(readFileSync(join(home, ".cache", "opencode", "packages", "superpowers-controller", "node_modules", "superpowers-controller", "package.json"), "utf8")).toContain('"version":"9.9.9"')
    expect(readFileSync(join(home, ".cache", "opencode", "packages", "superpowers-controller@latest", "node_modules", "superpowers-controller", "package.json"), "utf8")).toContain('"version":"9.9.9"')
    for (const seeded of [
      join(home, ".cache", "opencode", "packages", "node_modules", "superpowers-controller"),
      join(home, ".cache", "opencode", "packages", "superpowers-controller", "node_modules", "superpowers-controller"),
      join(home, ".cache", "opencode", "packages", "superpowers-controller@latest", "node_modules", "superpowers-controller"),
    ]) {
      expect(existsSync(join(seeded, "node_modules", "@opencode-ai", "plugin", "package.json")), seeded).toBe(true)
      expect(existsSync(join(seeded, "node_modules", "@opencode-ai", "plugin", "dist", "tool.js")), seeded).toBe(true)
    }
    const packageRoot = JSON.parse(readFileSync(join(cacheRoot, "package.json"), "utf8"))
    expect(packageRoot.dependencies["superpowers-controller"]).toBe("latest")
    expect(packageRoot.dependencies["oh-my-opencode"]).toBe("latest")
  }, 60_000)

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
