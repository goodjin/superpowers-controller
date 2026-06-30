import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("package entrypoints", () => {
  test("builds and exports the TUI plugin entry", () => {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as {
      name: string
      bin: Record<string, string>
      files: string[]
      types: string
      scripts: Record<string, string>
      exports: Record<string, unknown>
    }

    expect(pkg.name).toBe("superpowers-controller")
    expect(pkg.bin).toEqual({
      "superpowers-controller": "dist/cli/index.js",
    })
    expect(pkg.files).toContain("scripts/install.sh")
    expect(pkg.types).toBe("./dist/src/index.d.ts")
    expect(pkg.scripts.build).toContain("src/tui.ts")
    expect(pkg.exports["./tui"]).toEqual({
      types: "./dist/src/tui.d.ts",
      import: "./dist/tui.js",
    })
  })
})
