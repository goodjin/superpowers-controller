#!/usr/bin/env node
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
	MANAGED_AGENT_NAMES,
	ensureAgentConfig,
	ensureFeatureEnabled,
	removeManagedAgentBlocks,
	exists,
} from "./toml-config.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const adapterRoot = resolve(here, "..")
const agentsSourceDir = join(adapterRoot, "agents")

export async function installCodexAgents(options = {}) {
	const homeDir = resolve(options.homeDir ?? homedir())
	const codexHome = resolve(options.codexHome ?? process.env.CODEX_HOME ?? join(homeDir, ".codex"))
	const log = options.log ?? console.log

	const agentFiles = (await readdir(agentsSourceDir))
		.filter((name) => name.endsWith(".toml"))
		.sort()

	if (agentFiles.length === 0) {
		throw new Error(`No agent TOML files found in ${agentsSourceDir}`)
	}

	const names = agentFiles.map((file) => file.replace(/\.toml$/, ""))
	for (const name of names) {
		if (name === "default") {
			throw new Error("Refusing to install an agent named default")
		}
		if (!MANAGED_AGENT_NAMES.has(name)) {
			throw new Error(`Unexpected agent file ${name}.toml; update MANAGED_AGENT_NAMES if intentional`)
		}
	}

	const agentsDir = join(codexHome, "agents")
	await mkdir(agentsDir, { recursive: true })

	const installed = []
	for (const file of agentFiles) {
		const source = join(agentsSourceDir, file)
		const target = join(agentsDir, file)
		await copyFile(source, target)
		installed.push(file)
		log(`installed agent: ${file}`)
	}

	const configPath = join(codexHome, "config.toml")
	let config = ""
	if (await exists(configPath)) {
		config = await readFile(configPath, "utf8")
	}

	config = removeManagedAgentBlocks(config)
	config = ensureFeatureEnabled(config, "multi_agent")
	for (const name of names) {
		config = ensureAgentConfig(config, {
			name,
			configFile: `./agents/${name}.toml`,
		})
	}

	await mkdir(dirname(configPath), { recursive: true })
	await writeFile(configPath, `${config.trimEnd()}\n`)
	log(`updated config: ${configPath}`)
	log("Codex will not switch its default session agent. Spawn or select superpowers-agent explicitly.")

	return { codexHome, installed, configPath }
}

const isMain = process.argv[1] != null && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
	installCodexAgents().catch((error) => {
		console.error(error instanceof Error ? error.message : error)
		process.exitCode = 1
	})
}
