#!/usr/bin/env node
import { rm, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { MANAGED_AGENT_NAMES, removeManagedAgentBlocks, exists } from "./toml-config.mjs"

export async function uninstallCodexAgents(options = {}) {
	const homeDir = resolve(options.homeDir ?? homedir())
	const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homeDir, ".codex"))
	const log = options.log ?? console.log

	const agentsDir = join(codexHome, "agents")
	const removed = []
	for (const name of [...MANAGED_AGENT_NAMES].sort()) {
		const target = join(agentsDir, `${name}.toml`)
		if (await exists(target)) {
			await rm(target, { force: true })
			removed.push(`${name}.toml`)
			log(`removed agent: ${name}.toml`)
		}
	}

	const configPath = join(codexHome, "config.toml")
	if (await exists(configPath)) {
		const config = await readFile(configPath, "utf8")
		const next = removeManagedAgentBlocks(config)
		if (next !== config) {
			await writeFile(configPath, `${next.trimEnd()}\n`)
			log(`updated config: ${configPath}`)
		}
	}

	log("Left features.multi_agent unchanged (may still be used by other agents).")
	return { codexHome, removed, configPath }
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
	uninstallCodexAgents().catch((error) => {
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	})
}
