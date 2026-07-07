import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { parse } from "jsonc-parser"

type PermissionEnv = Record<string, string | undefined>
type PermissionRuleValue = string | Record<string, string>

export function resolveGlobalPermission(hostPermission: unknown, env: PermissionEnv = process.env): unknown {
  if (hostPermission !== undefined) return hostPermission
  return readOpenCodePermission(env)
}

export function isGlobalPermissionAllow(permission: unknown): boolean {
  if (permission === "allow") return true
  if (!permission || typeof permission !== "object" || Array.isArray(permission)) return false

  const rules = permission as Record<string, unknown>
  return rules["*"] === "allow"
}

export function mergePermissionRules(
  base: Record<string, unknown>,
  inherited: unknown,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const merged = { ...base }
  if (isPermissionRulesObject(inherited)) {
    for (const [permission, rule] of Object.entries(inherited)) {
      merged[permission] = clonePermissionRule(rule)
    }
  }
  return { ...merged, ...overrides }
}

function isPermissionRulesObject(value: unknown): value is Record<string, PermissionRuleValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false
  return Object.values(value).every((rule) => {
    if (typeof rule === "string") return true
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) return false
    return Object.values(rule).every((action) => typeof action === "string")
  })
}

function clonePermissionRule(rule: PermissionRuleValue): PermissionRuleValue {
  if (typeof rule === "string") return rule
  return { ...rule }
}

function readOpenCodePermission(env: PermissionEnv): unknown {
  for (const configPath of candidateConfigPaths(env)) {
    if (!existsSync(configPath)) continue
    const parsed = parse(readFileSync(configPath, "utf8"))
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return (parsed as Record<string, unknown>).permission
    }
  }
  return undefined
}

function candidateConfigPaths(env: PermissionEnv): string[] {
  const paths: string[] = []
  if (env.XDG_CONFIG_HOME) {
    paths.push(join(env.XDG_CONFIG_HOME, "opencode", "opencode.jsonc"))
    paths.push(join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"))
    paths.push(join(env.XDG_CONFIG_HOME, "opencode.jsonc"))
    paths.push(join(env.XDG_CONFIG_HOME, "opencode.json"))
  }
  if (env.HOME) {
    paths.push(join(env.HOME, ".config", "opencode", "opencode.jsonc"))
    paths.push(join(env.HOME, ".config", "opencode", "opencode.json"))
  }
  return paths
}
