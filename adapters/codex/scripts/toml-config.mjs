import { access } from "node:fs/promises"
import { constants as fsConstants } from "node:fs"

export const MANAGED_AGENT_NAMES = new Set([
	"superpowers-agent",
	"sp-designer",
	"sp-planner",
	"sp-debugger",
	"sp-investigator",
	"sp-implementer",
	"sp-acceptance-reviewer",
	"sp-code-reviewer",
	"sp-verifier",
	"sp-finisher",
])

export async function exists(path) {
	try {
		await access(path, fsConstants.F_OK)
		return true
	} catch {
		return false
	}
}

export function ensureFeatureEnabled(config, featureName) {
	const section = findTomlSection(config, "features")
	if (!section) return appendBlock(config, `[features]\n${featureName} = true\n`)
	return replaceOrInsertSetting(config, section, featureName, "true")
}

export function ensureAgentConfig(config, agentConfig) {
	const header = `agents.${tomlKeySegment(agentConfig.name)}`
	const section = findTomlSection(config, header)
	const configFile = JSON.stringify(agentConfig.configFile)
	if (!section) return appendBlock(config, `[${header}]\nconfig_file = ${configFile}\n`)
	return replaceOrInsertSetting(config, section, "config_file", configFile)
}

export function removeManagedAgentBlocks(config) {
	return splitTomlSections(config)
		.filter((section) => {
			if (section.header === null) return true
			const agentName = parseAgentHeaderName(section.header)
			if (agentName === null || !MANAGED_AGENT_NAMES.has(agentName)) return true
			return !section.text.includes(`config_file = ${JSON.stringify(`./agents/${agentName}.toml`)}`)
		})
		.map((section) => section.text)
		.join("")
		.replace(/\n{3,}/g, "\n\n")
}

export function findTomlSection(config, header) {
	const sections = splitTomlSections(config)
	const match = sections.find((section) => section.header === header)
	if (!match) return null
	let start = 0
	for (const section of sections) {
		if (section === match) {
			return { ...match, start, end: start + match.text.length }
		}
		start += section.text.length
	}
	return null
}

export function replaceOrInsertSetting(config, section, key, value) {
	const lines = section.text.split("\n")
	const headerLine = lines[0] ?? ""
	const body = lines.slice(1)
	const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`)
	let replaced = false
	const nextBody = body.map((line) => {
		if (!keyPattern.test(line)) return line
		replaced = true
		return `${key} = ${value}`
	})
	if (!replaced) {
		const insertAt = nextBody.findIndex((line) => line.trim() === "")
		if (insertAt === -1) nextBody.push(`${key} = ${value}`)
		else nextBody.splice(insertAt, 0, `${key} = ${value}`)
	}
	const nextSection = [headerLine, ...nextBody].join("\n")
	return config.slice(0, section.start) + nextSection + config.slice(section.end)
}

export function appendBlock(config, block) {
	const trimmed = config.trimEnd()
	if (trimmed.length === 0) return `${block.trimEnd()}\n`
	return `${trimmed}\n\n${block.trimEnd()}\n`
}

function splitTomlSections(config) {
	const lines = config.match(/[^\n]*\n?|$/g) ?? []
	const sections = []
	let current = { header: null, text: "" }
	for (const line of lines) {
		if (line.length === 0) break
		const header = parseTomlHeader(line)
		if (header !== null) {
			if (current.text.length > 0) sections.push(current)
			current = { header, text: line }
		} else {
			current.text += line
		}
	}
	if (current.text.length > 0) sections.push(current)
	return sections
}

function parseTomlHeader(line) {
	const trimmed = line.trim()
	if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return null
	if (trimmed.startsWith("[[")) return null
	return trimmed.slice(1, -1)
}

function parseAgentHeaderName(header) {
	const prefix = "agents."
	if (!header.startsWith(prefix)) return null
	const key = header.slice(prefix.length)
	return key.startsWith('"') ? parseLeadingJsonString(key) : key
}

function parseLeadingJsonString(value) {
	try {
		const parsed = JSON.parse(value)
		return typeof parsed === "string" ? parsed : null
	} catch {
		return null
	}
}

function tomlKeySegment(value) {
	return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value)
}

function escapeRegExp(value) {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}
