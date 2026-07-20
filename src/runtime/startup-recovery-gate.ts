/**
 * Gate write-path startup recovery so short-lived OpenCode CLI processes
 * (e.g. `opencode agent list`) do not mark live TUI child sessions interrupted.
 */

const SHORT_LIVED_CLI_COMMANDS = new Set([
  "agent",
  "auth",
  "debug",
  "export",
  "github",
  "models",
  "plugin",
  "plug",
  "pr",
  "session",
  "stats",
  "upgrade",
  "uninstall",
  "acp",
])

export function shouldWriteStartupRecovery(argv: string[] = process.argv, env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.SUPERPOWERS_FORCE_STARTUP_RECOVERY === "1") return true
  if (env.SUPERPOWERS_SKIP_STARTUP_RECOVERY === "1") return false
  if (isShortLivedCliInvocation(argv)) return false
  return true
}

export function isShortLivedCliInvocation(argv: string[] = process.argv): boolean {
  // argv[0] is the binary; scan remaining tokens for known short-lived subcommands.
  for (const token of argv.slice(1)) {
    if (!token || token.startsWith("-")) continue
    if (SHORT_LIVED_CLI_COMMANDS.has(token.toLowerCase())) return true
  }
  return false
}
