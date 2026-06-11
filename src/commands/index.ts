export type CommandConfigRecord = Record<string, Record<string, unknown>>

const COMMANDS: Array<[string, string, string]> = [
  ["sp", "Route a request through Superpowers Controller", "Classify and route this request through sp_route: $ARGUMENTS"],
  ["sp-design", "Start or resume Superpowers design workflow", "Start design workflow for: $ARGUMENTS"],
  ["sp-plan", "Start or resume Superpowers planning workflow", "Start planning workflow for: $ARGUMENTS"],
  ["sp-debug", "Start or resume Superpowers debugging workflow", "Start debugging workflow for: $ARGUMENTS"],
  ["sp-execute", "Execute the current Superpowers plan", "Execute planned workflow tasks for: $ARGUMENTS"],
  ["sp-review", "Run Superpowers review workflow", "Review current work or feedback: $ARGUMENTS"],
  ["sp-verify", "Run Superpowers verification workflow", "Verify current work before completion: $ARGUMENTS"],
  ["sp-reset", "Reset active Superpowers workflow pointer", "Call sp_reset and explain the archived run pointer was cleared."],
]

export function createCommandConfig(): CommandConfigRecord {
  return Object.fromEntries(
    COMMANDS.map(([name, description, template]) => [
      name,
      {
        description,
        agent: "superpowers",
        template,
      },
    ]),
  )
}
