import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { modify, applyEdits, parse } from "jsonc-parser"
import { DEFAULT_CONFIG } from "../config/defaults"

export const PACKAGE_NAME = "opencode-superpowers-controller"
export const CONFIG_FILE_NAME = "opencode-superpowers.jsonc"

export function mergePluginEntry(content: string, pluginEntry = PACKAGE_NAME): string {
  const parsed = parse(content)
  const plugins = Array.isArray(parsed?.plugin) ? parsed.plugin.filter((entry: unknown): entry is string => typeof entry === "string") : []
  const nextPlugins = plugins.includes(pluginEntry) ? plugins : [...plugins, pluginEntry]
  const edits = modify(content || "{}", ["plugin"], nextPlugins, {
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

  const pluginConfigPath = join(configDir, CONFIG_FILE_NAME)
  if (!existsSync(pluginConfigPath)) {
    writeFileSync(pluginConfigPath, `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`)
  }

  mkdirSync(join(configDir, "skills"), { recursive: true })
  copyAssetTree("skills", join(configDir, "skills"))

  return [target, pluginConfigPath]
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
    const sourcePath = join(source, entry)
    const destinationPath = join(destination, entry)
    if (statSync(sourcePath).isDirectory()) {
      copyDirectory(sourcePath, destinationPath)
    } else {
      copyFileEnsuringDir(sourcePath, destinationPath)
    }
  }
}
