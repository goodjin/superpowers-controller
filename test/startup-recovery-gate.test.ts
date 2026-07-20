import { describe, expect, test } from "bun:test"
import { isShortLivedCliInvocation, shouldWriteStartupRecovery } from "../src/runtime/startup-recovery-gate"

describe("startup recovery gate", () => {
  test("skips write recovery for short-lived CLI subcommands", () => {
    expect(isShortLivedCliInvocation(["opencode", "agent", "list"])).toBe(true)
    expect(isShortLivedCliInvocation(["opencode", "debug", "config"])).toBe(true)
    expect(isShortLivedCliInvocation(["node", "opencode", "session", "list"])).toBe(true)
    expect(shouldWriteStartupRecovery(["opencode", "agent", "list"], {})).toBe(false)
  })

  test("allows write recovery for interactive TUI-style argv", () => {
    expect(isShortLivedCliInvocation(["opencode"])).toBe(false)
    expect(isShortLivedCliInvocation(["opencode", "/Users/jin/vpn"])).toBe(false)
    expect(isShortLivedCliInvocation(["opencode", "."])).toBe(false)
    expect(shouldWriteStartupRecovery(["opencode"], {})).toBe(true)
  })

  test("honors force and skip environment overrides", () => {
    expect(shouldWriteStartupRecovery(["opencode", "agent", "list"], { SUPERPOWERS_FORCE_STARTUP_RECOVERY: "1" })).toBe(true)
    expect(shouldWriteStartupRecovery(["opencode"], { SUPERPOWERS_SKIP_STARTUP_RECOVERY: "1" })).toBe(false)
  })
})
