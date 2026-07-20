import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, test } from "bun:test"

import { installCodexAgents } from "../scripts/install.mjs"
import { uninstallCodexAgents } from "../scripts/uninstall.mjs"

describe("codex adapter install", () => {
	test("copies managed agents and registers config without touching default", async () => {
		const root = await mkdtemp(join(tmpdir(), "sp-codex-"))
		const codexHome = join(root, ".codex")
		await mkdir(codexHome, { recursive: true })
		await writeFile(
			join(codexHome, "config.toml"),
			`[features]\nplugins = true\n\n[agents.explorer]\nconfig_file = "./agents/explorer.toml"\n`,
		)

		const logs = []
		const result = await installCodexAgents({
			codexHome,
			homeDir: root,
			log: (line) => logs.push(String(line)),
		})

		const agents = (await readdir(join(codexHome, "agents"))).sort()
		expect(agents).toContain("superpowers-agent.toml")
		expect(agents).toContain("sp-implementer.toml")
		expect(agents).not.toContain("default.toml")

		const config = await readFile(join(codexHome, "config.toml"), "utf8")
		expect(config).toContain("multi_agent = true")
		expect(config).toContain("[agents.superpowers-agent]")
		expect(config).toContain('config_file = "./agents/superpowers-agent.toml"')
		expect(config).toContain("[agents.explorer]")
		expect(config).not.toContain("[agents.default]")

		await uninstallCodexAgents({
			codexHome,
			homeDir: root,
			log: () => {},
		})
		const after = (await readdir(join(codexHome, "agents"))).sort()
		expect(after).not.toContain("superpowers-agent.toml")
		const configAfter = await readFile(join(codexHome, "config.toml"), "utf8")
		expect(configAfter).toContain("[agents.explorer]")
		expect(configAfter).not.toContain("[agents.superpowers-agent]")

		expect(result.installed.length).toBe(10)
		expect(logs.some((line) => line.includes("will not switch"))).toBe(true)
	})
})
