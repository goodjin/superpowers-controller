import type { GateMode, WorkflowConfig } from "../config/schema"
import type { QualityCheckKind, QualityCheckRecord, WorkflowRecord, WorkflowState } from "../state/types"

export const DEFAULT_QUALITY_COMMANDS: Record<QualityCheckKind, string> = {
  build: "bun run build",
  test: "bun test",
  lint: "bun run lint",
}

export type ParsedQualityCheck = {
  kind: QualityCheckKind
  status: "passed" | "failed"
  command?: string
  summary?: string
}

export function requiredQualityChecks(state: WorkflowState): QualityCheckKind[] {
  const fromSpec = state.workflow_spec?.orchestration.required_checks ?? []
  return [...new Set(fromSpec)]
}

export function resolveQualityCommand(
  config: WorkflowConfig,
  state: WorkflowState,
  kind: QualityCheckKind,
): string {
  const override = state.workflow_spec?.orchestration.quality_commands?.[kind]
  if (override) return override
  return config.quality_commands[kind]
}

export function parseQualityChecksFromReport(checks: string | undefined): ParsedQualityCheck[] {
  if (!checks?.trim()) return []
  const trimmed = checks.trim()
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, { status?: string; command?: string; summary?: string }>
      return (["build", "test", "lint"] as const).flatMap((kind) => {
        const entry = parsed[kind]
        if (!entry?.status) return []
        const status = entry.status.toLowerCase() === "passed" ? "passed" : "failed"
        return [{ kind, status, command: entry.command, summary: entry.summary }]
      })
    } catch {
      return []
    }
  }

  const results: ParsedQualityCheck[] = []
  for (const line of trimmed.split("\n")) {
    const match = line.trim().match(/^(build|test|lint)\s*:\s*(passed|failed)\b(?:\s*\((.+)\))?/i)
    if (!match) continue
    results.push({
      kind: match[1]!.toLowerCase() as QualityCheckKind,
      status: match[2]!.toLowerCase() as "passed" | "failed",
      command: match[3]?.trim(),
      summary: line.trim(),
    })
  }
  return results
}

export function mergeQualityChecksFromRecord(
  state: WorkflowState,
  record: WorkflowRecord,
  nodeID?: string,
): WorkflowState["quality_checks"] {
  if (!record.checks || !["verification", "finish"].includes(record.event)) {
    return state.quality_checks
  }
  const parsed = parseQualityChecksFromReport(record.checks)
  if (parsed.length === 0) return state.quality_checks
  const now = new Date().toISOString()
  const next = { ...(state.quality_checks ?? {}) }
  for (const check of parsed) {
    next[check.kind] = {
      status: check.status,
      command: check.command,
      summary: check.summary ?? record.summary,
      node_id: nodeID,
      reported_at: now,
    }
  }
  return next
}

export function missingPassedQualityChecks(state: WorkflowState): QualityCheckKind[] {
  const required = requiredQualityChecks(state)
  if (required.length === 0) return []
  return required.filter((kind) => state.quality_checks?.[kind]?.status !== "passed")
}

export function evaluateQualityGateForFinish(args: {
  config: WorkflowConfig
  state: WorkflowState
}): { allowed: boolean; severity: "none" | "warning" | "blocked"; reason: string } {
  const missing = missingPassedQualityChecks(args.state)
  if (missing.length === 0) {
    return { allowed: true, severity: "none", reason: "allowed" }
  }
  const commands = missing.map((kind) => `${kind} (${resolveQualityCommand(args.config, args.state, kind)})`).join(", ")
  const reason = `Required quality checks missing or not passed: ${missing.join(", ")}. Expected command evidence in sp_report.checks for: ${commands}.`
  return resultForMode(args.config.quality_gate, reason)
}

export function validateQualityGateForRecord(args: {
  config: WorkflowConfig
  state: WorkflowState
  record: WorkflowRecord
  nodeID?: string
}): void {
  if (args.record.event !== "finish" || args.record.status !== "passed") return
  const provisional: WorkflowState = {
    ...args.state,
    quality_checks: mergeQualityChecksFromRecord(args.state, args.record, args.nodeID),
  }
  const gate = evaluateQualityGateForFinish({ config: args.config, state: provisional })
  if (!gate.allowed) {
    throw new Error(`sp_report rejected: ${gate.reason}`)
  }
}

export function qualityGateHint(state: WorkflowState, config: WorkflowConfig): string | undefined {
  const required = requiredQualityChecks(state)
  if (required.length === 0) return undefined
  const missing = missingPassedQualityChecks(state)
  if (missing.length === 0) return undefined
  return missing
    .map((kind) => `${kind}: run \`${resolveQualityCommand(config, state, kind)}\` and report checks as \`${kind}: passed\``)
    .join("; ")
}

function resultForMode(mode: GateMode, reason: string) {
  if (mode === "off") return { allowed: true, severity: "none" as const, reason: "allowed" }
  if (mode === "strict") return { allowed: false, severity: "blocked" as const, reason }
  return { allowed: true, severity: "warning" as const, reason }
}
