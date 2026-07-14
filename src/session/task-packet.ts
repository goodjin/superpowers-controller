export type NodeTaskPacket = {
  run_id: string
  node_id: string
  workflow: string
  phase: string
  agent: string
  primary_skill: string
  task_id?: string
  objective: string
  context_sections?: Array<{ title: string; body: string }>
  required_artifacts: Array<{ name: string; path: string }>
  source_artifacts?: Array<{ name: string; path: string; body?: string; missing?: string }>
  retry_context?: string
  recovery_context?: string
  record_contract: {
    event: string
    expected_artifacts: string[]
    allowed_gates: string[]
  }
}
