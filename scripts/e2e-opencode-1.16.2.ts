import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { spawnSync } from "node:child_process"

const projectRoot = resolve(import.meta.dir, "..")
const opencodeBin = join(projectRoot, "tools", "opencode-1.16.2", "node_modules", ".bin", "opencode")
const pluginEntry = `file://${join(projectRoot, "dist", "index.js")}`
const isolatedHome = mkdtempSync(join(tmpdir(), "sp-opencode-e2e-"))
const configDir = join(isolatedHome, ".config", "opencode")
mkdirSync(configDir, { recursive: true })
writeFileSync(join(configDir, "opencode.jsonc"), `${JSON.stringify({ plugin: [pluginEntry] }, null, 2)}\n`)

const version = spawnSync(opencodeBin, ["--version"], {
  encoding: "utf8",
  env: isolatedEnv(isolatedHome),
})
if (version.status !== 0 || version.stdout.trim() !== "1.16.2") {
  throw new Error(`Expected OpenCode 1.16.2, got stdout=${version.stdout} stderr=${version.stderr}`)
}

const agents = spawnSync(opencodeBin, ["agent", "list"], {
  cwd: projectRoot,
  encoding: "utf8",
  env: isolatedEnv(isolatedHome),
})
if (agents.status !== 0) {
  throw new Error(`opencode agent list failed:\n${agents.stderr}\n${agents.stdout}`)
}

for (const name of [
  "superpowers",
  "sp-designer",
  "sp-planner",
  "sp-debugger",
  "sp-implementer",
  "sp-spec-reviewer",
  "sp-code-reviewer",
  "sp-verifier",
  "sp-finisher",
]) {
  if (!agents.stdout.includes(name)) {
    throw new Error(`Expected injected agent ${name} in OpenCode 1.16.2 agent list`)
  }
}

console.log("OpenCode 1.16.2 e2e smoke passed: plugin loaded and 9 agents were dynamically injected.")

function isolatedEnv(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
  }
}
