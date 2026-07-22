import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { parse } from "jsonc-parser"
import { CONFIG_FILE_NAME, LEGACY_CONFIG_FILE_NAME, PACKAGE_NAME, TUI_PACKAGE_ENTRY } from "./install"
import { projectStateRoot } from "../state/paths"

export const MIN_OPENCODE_VERSION = "1.16.0"

export type DoctorCheck = {
  name: string
  ok: boolean
  detail: string
}

export function doctor(
  configDir = join(homedir(), ".config", "opencode"),
  projectDir = process.cwd(),
  env: NodeJS.ProcessEnv = process.env,
): DoctorCheck[] {
  const opencode = spawnSync("opencode", ["--version"], { encoding: "utf8", env })
  const opencodeVersion = opencode.status === 0 ? extractVersion(opencode.stdout) : undefined
  const opencodeVersionOk = opencodeVersion ? compareVersions(opencodeVersion, MIN_OPENCODE_VERSION) >= 0 : false
  const configPath = existsSync(join(configDir, "opencode.jsonc")) ? join(configDir, "opencode.jsonc") : join(configDir, "opencode.json")
  const configContent = existsSync(configPath) ? readFileSync(configPath, "utf8") : ""
  const parsedConfig = parse(configContent || "{}")
  const tuiConfigPath = existsSync(join(configDir, "tui.jsonc")) ? join(configDir, "tui.jsonc") : join(configDir, "tui.json")
  const tuiConfigContent = existsSync(tuiConfigPath) ? readFileSync(tuiConfigPath, "utf8") : ""
  const parsedTuiConfig = parse(tuiConfigContent || "{}")
  const skillsDir = join(configDir, "skills")
  const stateDir = projectStateRoot(projectDir)
  const pluginConfigPath = join(configDir, CONFIG_FILE_NAME)
  const legacyPluginConfigPath = join(configDir, LEGACY_CONFIG_FILE_NAME)
  const hasPluginConfig = existsSync(pluginConfigPath)
  const hasLegacyPluginConfig = existsSync(legacyPluginConfigPath)

  return [
    {
      name: "opencode",
      ok: opencode.status === 0 && opencodeVersionOk,
      detail:
        opencode.status !== 0
          ? "opencode executable not found"
          : opencodeVersionOk
            ? opencode.stdout.trim()
            : `${opencode.stdout.trim()} (requires >= ${MIN_OPENCODE_VERSION})`,
    },
    {
      name: "plugin-entry",
      ok: hasPluginEntry(parsedConfig, PACKAGE_NAME),
      detail: configPath,
    },
    {
      name: "tui-plugin-entry",
      ok: hasPluginEntry(parsedTuiConfig, TUI_PACKAGE_ENTRY),
      detail: tuiConfigPath,
    },
    {
      name: "default-agent",
      ok: parsedConfig?.default_agent === "superpowers-agent",
      detail: "default_agent should be superpowers-agent",
    },
    {
      name: "plugin-config",
      ok: hasPluginConfig || hasLegacyPluginConfig,
      detail: hasPluginConfig ? pluginConfigPath : legacyPluginConfigPath,
    },
    {
      name: "skills",
      ok: countEntries(skillsDir, "superpowers-") > 0,
      detail: skillsDir,
    },
    {
      name: "entrypoint",
      ok: true,
      detail: "select the superpowers-agent agent in OpenCode",
    },
    {
      name: "state-dir",
      ok: isWritableOrCreatable(stateDir),
      detail: stateDir,
    },
    {
      name: "package",
      ok: true,
      detail: PACKAGE_NAME,
    },
  ]
}

export function formatDoctorChecks(checks: DoctorCheck[]): string {
  return checks.map((check) => `${check.ok ? "ok" : "fail"} ${check.name}: ${check.detail}`).join("\n")
}

function countEntries(dir: string, prefix: string): number {
  if (!existsSync(dir)) return 0
  return readdirSync(dir).filter((entry) => entry.startsWith(prefix)).length
}

function isWritableOrCreatable(path: string): boolean {
  try {
    const target = nearestExistingPath(path)
    accessSync(target, constants.W_OK)
    return true
  } catch {
    return false
  }
}

function hasPluginEntry(config: unknown, pluginEntry: string): boolean {
  return isRecord(config) && Array.isArray(config.plugin) && config.plugin.includes(pluginEntry)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function nearestExistingPath(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return parent
    current = parent
  }
  return current
}

function extractVersion(output: string): string | undefined {
  return output.match(/\d+\.\d+\.\d+/)?.[0]
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split(".").map(Number)
  const rightParts = right.split(".").map(Number)
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const diff = (leftParts[index] ?? 0) - (rightParts[index] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}
