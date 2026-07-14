import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { modify, applyEdits, parse } from "jsonc-parser"
import { DEFAULT_CONFIG } from "../config/defaults"

export const PACKAGE_NAME = "superpowers-controller"
/** OpenCode TUI config should use the npm package name; `exports["./tui"]` is resolved by the host. */
export const TUI_PACKAGE_ENTRY = PACKAGE_NAME
/** Older installs wrote `package/tui`, which OpenCode treats as GitHub `owner/repo`. */
export const LEGACY_TUI_PACKAGE_ENTRY = `${PACKAGE_NAME}/tui`
export const CONFIG_FILE_NAME = "superpowers-controller.jsonc"
export const LEGACY_CONFIG_FILE_NAME = "opencode-superpowers.jsonc"
const EXCLUDED_SKILL_DIRS = new Set([
  "superpowers-executing-plans",
  "superpowers-receiving-code-review",
  "superpowers-subagent-driven-development",
  "superpowers-using-git-worktrees",
  "superpowers-using-superpowers",
  "superpowers-writing-skills",
])

export function mergePluginEntry(content: string, pluginEntry = PACKAGE_NAME): string {
  let output = mergePluginArray(content, pluginEntry)
  output = mergeDefaultPermission(output)
  const defaultAgentEdits = modify(output, ["default_agent"], "superpowers-agent", {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  return applyEdits(output, defaultAgentEdits)
}

export function mergeDefaultPermission(content: string): string {
  const parsed = parse(content)
  if (parsed?.permission !== undefined) return content
  const edits = modify(content || "{}", ["permission"], "allow", {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  return applyEdits(content || "{}", edits)
}

export function mergeTuiPluginEntry(content: string, pluginEntry = TUI_PACKAGE_ENTRY): string {
  let output = mergePluginArray(content, pluginEntry, [LEGACY_TUI_PACKAGE_ENTRY])
  if (!parse(output)?.$schema) {
    const schemaEdits = modify(output, ["$schema"], "https://opencode.ai/tui.json", {
      formattingOptions: { insertSpaces: true, tabSize: 2 },
    })
    output = applyEdits(output, schemaEdits)
  }
  return output
}

function mergePluginArray(content: string, pluginEntry: string, removeEntries: string[] = []): string {
  const parsed = parse(content)
  const plugins: string[] = Array.isArray(parsed?.plugin)
    ? parsed.plugin.filter((entry: unknown): entry is string => typeof entry === "string")
    : []
  const withoutRemoved = plugins.filter((entry: string) => !removeEntries.includes(entry))
  const nextPlugins = withoutRemoved.includes(pluginEntry) ? withoutRemoved : [...withoutRemoved, pluginEntry]
  let output = content || "{}"
  const formattingOptions = { insertSpaces: true, tabSize: 2 }
  const pluginEdits = modify(output, ["plugin"], nextPlugins, {
    formattingOptions,
  })
  return applyEdits(output, pluginEdits)
}

export function mergeDefaultAgent(content: string, agent = "superpowers-agent"): string {
  const edits = modify(content || "{}", ["default_agent"], agent, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  return applyEdits(content || "{}", edits)
}

export function install(configDir = join(homedir(), ".config", "opencode")): string[] {
  mkdirSync(configDir, { recursive: true })
  const opencodeJsonc = join(configDir, "opencode.jsonc")
  const opencodeJson = join(configDir, "opencode.json")
  const target = existsSync(opencodeJsonc) || !existsSync(opencodeJson) ? opencodeJsonc : opencodeJson
  const current = existsSync(target) ? readFileSync(target, "utf8") : "{}\n"
  writeFileSync(target, ensureTrailingNewline(mergePluginEntry(current)))

  const tuiJsonc = join(configDir, "tui.jsonc")
  const tuiJson = join(configDir, "tui.json")
  const tuiTarget = existsSync(tuiJsonc) || !existsSync(tuiJson) ? tuiJsonc : tuiJson
  const currentTui = existsSync(tuiTarget) ? readFileSync(tuiTarget, "utf8") : "{}\n"
  writeFileSync(tuiTarget, ensureTrailingNewline(mergeTuiPluginEntry(currentTui)))

  const pluginConfigPath = join(configDir, CONFIG_FILE_NAME)
  const legacyPluginConfigPath = join(configDir, LEGACY_CONFIG_FILE_NAME)
  if (!existsSync(pluginConfigPath)) {
    const content = existsSync(legacyPluginConfigPath)
      ? ensureTrailingNewline(readFileSync(legacyPluginConfigPath, "utf8"))
      : `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`
    writeFileSync(pluginConfigPath, content)
  }

  mkdirSync(join(configDir, "skills"), { recursive: true })
  copyAssetTree("skills", join(configDir, "skills"))

  return [target, tuiTarget, pluginConfigPath]
}

export function copyFileEnsuringDir(source: string, destination: string): void {
  mkdirSync(dirname(destination), { recursive: true })
  writeFileSync(destination, readFileSync(source))
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`
}

function copyAssetTree(kind: "skills", destinationRoot: string): void {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "assets", kind)
  if (!existsSync(sourceRoot)) return
  copyDirectory(sourceRoot, destinationRoot)
}

function copyDirectory(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true })
  for (const entry of readdirSync(source)) {
    if (EXCLUDED_SKILL_DIRS.has(entry)) continue
    const sourcePath = join(source, entry)
    const destinationPath = join(destination, entry)
    if (statSync(sourcePath).isDirectory()) {
      copyDirectory(sourcePath, destinationPath)
    } else {
      copyFileEnsuringDir(sourcePath, destinationPath)
    }
  }
}
