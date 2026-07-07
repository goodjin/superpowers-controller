import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { mergePermissionRules, resolveGlobalPermission } from "../src/config/permissions"

let tempRoots: string[] = []

afterEach(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true })
  }
  tempRoots = []
})

describe("resolveGlobalPermission", () => {
  test("prefers the host config hook permission when present", () => {
    const root = tempRoot()
    const configHome = join(root, "config")
    mkdirSync(join(configHome, "opencode"), { recursive: true })
    writeFileSync(join(configHome, "opencode", "opencode.json"), `${JSON.stringify({ permission: "allow" }, null, 2)}\n`)

    expect(resolveGlobalPermission("ask", { XDG_CONFIG_HOME: configHome })).toBe("ask")
  })

  test("falls back to XDG OpenCode config when hook input omits permission", () => {
    const root = tempRoot()
    const configHome = join(root, "config")
    mkdirSync(join(configHome, "opencode"), { recursive: true })
    writeFileSync(join(configHome, "opencode", "opencode.json"), `${JSON.stringify({ permission: "allow" }, null, 2)}\n`)

    expect(resolveGlobalPermission(undefined, { XDG_CONFIG_HOME: configHome })).toBe("allow")
  })
})

describe("mergePermissionRules", () => {
  test("inherits granular permission objects and applies explicit overrides last", () => {
    const merged = mergePermissionRules(
      { edit: "ask", bash: "allow", task: "deny" },
      {
        edit: { "*": "ask", "src/**": "allow" },
        external_directory: { "/tmp/*": "allow" },
        task: "allow",
      },
      { task: "deny" },
    )

    expect(merged.edit).toEqual({ "*": "ask", "src/**": "allow" })
    expect(merged.bash).toBe("allow")
    expect(merged.external_directory).toEqual({ "/tmp/*": "allow" })
    expect(merged.task).toBe("deny")
  })
})

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "sp-config-permission-"))
  tempRoots.push(root)
  return root
}
