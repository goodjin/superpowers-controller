import type { WorkflowMode } from "../state/types"

const COMMAND_MODES: Record<string, WorkflowMode> = {
  "/sp": "idle",
  "/sp-design": "design",
  "/sp-plan": "plan",
  "/sp-debug": "debug",
  "/sp-execute": "execute",
  "/sp-review": "review",
  "/sp-verify": "verify-finish",
}

const MODE_PATTERNS: Array<{ mode: WorkflowMode; patterns: RegExp[] }> = [
  {
    mode: "parallel-investigate",
    patterns: [/\bparallel\b/i, /\bindependent\b/i, /\bmultiple.+domains?\b/i],
  },
  {
    mode: "debug",
    patterns: [/\bbug\b/i, /\bfail(?:s|ed|ure)?\b/i, /\bcrash\b/i, /\berror\b/i, /\bunexpected\b/i, /\bperformance\b/i],
  },
  {
    mode: "skill-authoring",
    patterns: [/\bcreate skill\b/i, /\bupdate skill\b/i, /\bwrite(?:ing)? skills?\b/i],
  },
  {
    mode: "verify-finish",
    patterns: [/\bdone\b/i, /\bfinish\b/i, /\bcommit\b/i, /\bmerge\b/i, /\bverify\b/i, /\bpass(?:ed)?\b/i],
  },
  {
    mode: "review",
    patterns: [/\breview\b/i, /\bpr feedback\b/i, /\bcode review\b/i],
  },
  {
    mode: "plan",
    patterns: [/\bplan\b/i, /\bspec\b/i, /\btask breakdown\b/i],
  },
  {
    mode: "execute",
    patterns: [/\bexecute\b/i, /\bcontinue plan\b/i, /\bdo tasks?\b/i],
  },
  {
    mode: "design",
    patterns: [/\bbuild\b/i, /\badd\b/i, /\bcreate\b/i, /\bchange\b/i, /\brefactor\b/i, /\bimplement\b/i, /\bsupport\b/i],
  },
]

export function classifyRequest(request: string, command?: string): { mode: WorkflowMode; confidence: number; reason: string } {
  const normalizedCommand = command?.trim().toLowerCase()
  if (normalizedCommand && COMMAND_MODES[normalizedCommand]) {
    return { mode: COMMAND_MODES[normalizedCommand], confidence: 1, reason: `explicit command ${normalizedCommand}` }
  }

  for (const candidate of MODE_PATTERNS) {
    const matched = candidate.patterns.find((pattern) => pattern.test(request))
    if (matched) {
      return { mode: candidate.mode, confidence: 0.8, reason: `matched ${candidate.mode} intent` }
    }
  }

  return { mode: "idle", confidence: 0.2, reason: "low confidence" }
}
