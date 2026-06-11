import { accessSync, constants, existsSync, readdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { spawnSync } from "node:child_process"
import { CONFIG_FILE_NAME, PACKAGE_NAME } from "./install"

export type DoctorCheck = {
  name: string
  ok: boolean
  detail: string
}

export function doctor(configDir = join(homedir(), ".config", "opencode"), projectDir = process.cwd()): DoctorCheck[] {
  const opencode = spawnSync("opencode", ["--version"], { encoding: "utf8" })
  const configPath = existsSync(join(configDir, "opencode.jsonc")) ? join(configDir, "opencode.jsonc") : join(configDir, "opencode.json")
  const configContent = existsSync(configPath) ? readFileSync(configPath, "utf8") : ""
  const skillsDir = join(configDir, "skills")
  const stateDir = join(projectDir, ".opencode", "superpowers")

  return [
    {
      name: "opencode",
      ok: opencode.status === 0,
      detail: opencode.status === 0 ? opencode.stdout.trim() : "opencode executable not found",
    },
    {
      name: "plugin-entry",
      ok: configContent.includes(PACKAGE_NAME),
      detail: configPath,
    },
    {
      name: "plugin-config",
      ok: existsSync(join(configDir, CONFIG_FILE_NAME)),
      detail: join(configDir, CONFIG_FILE_NAME),
    },
    {
      name: "skills",
      ok: countEntries(skillsDir, "superpowers-") > 0,
      detail: skillsDir,
    },
    {
      name: "commands",
      ok: true,
      detail: "dynamically injected by plugin config hook",
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

function nearestExistingPath(path: string): string {
  let current = path
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return parent
    current = parent
  }
  return current
}
