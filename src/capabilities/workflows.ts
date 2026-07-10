import { AGENT_SKILL_MAP } from "../router/modes"
import type { WorkflowKind, WorkflowOrchestration, WorkflowSpec } from "../state/types"

export type BuiltInWorkflowTemplate = {
  id: WorkflowKind
  title: string
  description: string
  recommended_for: string[]
  default_start_config: {
    kind: "built_in_workflow"
    workflow_id: WorkflowKind
    auto_expansion: {
      allow: boolean
      reason: string
    }
  }
  customization_points: string[]
  risk_notes: string[]
  orchestration: WorkflowOrchestration
}

export const BUILT_IN_WORKFLOW_TEMPLATES: BuiltInWorkflowTemplate[] = [
  template({
    id: "feature",
    title: "Feature",
    description: "从设计/计划进入实现、验收、验证、代码审查和收尾的完整开发流程。",
    agents: [
      ["design", "sp-designer"],
      ["plan", "sp-planner"],
      ["implement", "sp-implementer"],
      ["acceptance", "sp-acceptance-reviewer"],
      ["verification", "sp-verifier"],
      ["code-review", "sp-code-reviewer"],
      ["finish", "sp-finisher"],
    ],
    recommended_for: ["多步骤功能开发", "需要计划和验证的改动", "实现后需要审查和收尾"],
    allowExpansion: true,
    customization_points: ["prepare 阶段是否引入 designer", "task graph 粒度", "验收/验证/审查是否裁剪"],
    risk_notes: ["plan 后默认允许 planner/report 生成后续任务。"],
  }),
  template({
    id: "bugfix",
    title: "Bugfix",
    description: "先定位根因，再修复、回归验证、审查和收尾。",
    agents: [
      ["debug", "sp-debugger"],
      ["implement", "sp-implementer"],
      ["verification", "sp-verifier"],
      ["code-review", "sp-code-reviewer"],
      ["finish", "sp-finisher"],
    ],
    recommended_for: ["错误诊断", "回归修复", "需要根因证据的故障"],
    allowExpansion: true,
    customization_points: ["是否先只定位根因", "回归验证命令", "是否需要 code review"],
    risk_notes: ["没有 root cause 时不应直接宣布修复完成。"],
  }),
  template({
    id: "review",
    title: "Review",
    description: "围绕已有改动运行验收、验证、代码审查和收尾。",
    agents: [
      ["acceptance", "sp-acceptance-reviewer"],
      ["verification", "sp-verifier"],
      ["code-review", "sp-code-reviewer"],
      ["finish", "sp-finisher"],
    ],
    recommended_for: ["已有实现后的复核", "发布前检查", "补充验收"],
    allowExpansion: true,
    customization_points: ["review 目标", "验证命令", "是否允许修复任务扩展"],
    risk_notes: ["review 发现问题时可能需要扩展 implementer 修复节点。"],
  }),
  template({
    id: "verify-finish",
    title: "Verify Finish",
    description: "运行新鲜验证并完成收尾。",
    agents: [
      ["verification", "sp-verifier"],
      ["finish", "sp-finisher"],
    ],
    recommended_for: ["完成前复验", "恢复后确认最终状态"],
    allowExpansion: true,
    customization_points: ["验证目标", "验证命令", "失败后是否允许修复"],
    risk_notes: ["没有明确验证目标时应阻塞并要求补充上下文。"],
  }),
  template({
    id: "design-only",
    title: "Design Only",
    description: "只做设计/方案，不自动进入计划或实现。",
    agents: [["design", "sp-designer"]],
    recommended_for: ["只要方案", "设计评审", "需求探索"],
    allowExpansion: false,
    customization_points: ["designer 是否参与 prepare", "输出 spec 范围"],
    risk_notes: ["默认不自动生成后续实现节点。"],
  }),
  template({
    id: "plan-only",
    title: "Plan Only",
    description: "只做计划和任务拆分，不自动执行。",
    agents: [["plan", "sp-planner"]],
    recommended_for: ["只要计划", "先审阅 task graph", "暂不改代码"],
    allowExpansion: false,
    customization_points: ["计划粒度", "是否引用 source workflow"],
    risk_notes: ["默认不执行 planner 输出的任务。"],
  }),
  template({
    id: "review-only",
    title: "Review Only",
    description: "只做 bounded review，不自动扩展修复任务。",
    agents: [["code-review", "sp-code-reviewer"]],
    recommended_for: ["只要审查意见", "不允许改代码", "一次性 review"],
    allowExpansion: false,
    customization_points: ["review 目标", "review 类型"],
    risk_notes: ["默认不自动派发 implementer 修复。"],
  }),
  template({
    id: "parallel-investigate",
    title: "Parallel Investigate",
    description: "运行独立调查节点，再由 finisher 汇总。",
    agents: [
      ["investigate", "sp-investigator"],
      ["finish", "sp-finisher"],
    ],
    recommended_for: ["多方向调查", "并行信息收集", "先读不改"],
    allowExpansion: true,
    customization_points: ["调查主题数量", "是否允许后续写入节点"],
    risk_notes: ["调查节点默认应保持只读，写入动作需 controller 确认。"],
  }),
  template({
    id: "single-agent",
    title: "Single Agent",
    description: "只派发一个指定 agent 节点。",
    agents: [["implement", "sp-implementer"]],
    recommended_for: ["单点实现", "单次调查", "单次审查或验证"],
    allowExpansion: false,
    customization_points: ["agent", "phase", "task_id", "输入/输出文档"],
    risk_notes: ["默认不自动生成后续节点；需要后续步骤时由 controller 明确允许。"],
  }),
]

export const COMMON_WORKFLOW_EXAMPLES = [
  {
    id: "feature_unclear_requirements",
    title: "Feature with unclear requirements",
    flow: ["intake", "prepare with designer", "plan/task graph", "implementation", "acceptance", "verification", "code-review", "finish"],
  },
  {
    id: "simple_scoped_implementation",
    title: "Simple scoped implementation",
    flow: ["prepare", "single implementer", "verification", "optional review", "finish"],
  },
  {
    id: "bugfix",
    title: "Bugfix",
    flow: ["reproduce/root cause", "implementation", "regression verification", "review", "finish"],
  },
  {
    id: "bounded_output",
    title: "Design-only or plan-only",
    flow: ["prepare", "designer or planner", "terminal output", "no auto expansion by default"],
  },
]

export function buildCapabilities() {
  return {
    agent_catalog: Object.entries(AGENT_SKILL_MAP).map(([agent, primary_skill]) => ({
      agent,
      primary_skill,
    })),
    workflow_schema: {
      start_config_kinds: ["built_in_workflow", "orchestration"],
      built_in_workflow_ids: BUILT_IN_WORKFLOW_TEMPLATES.map((item) => item.id),
      orchestration: {
        nodes: "Array<{ id, agent, phase?, task_id?, depends_on?, input_documents?, output_documents? }>",
        edges: "Array<{ from, to, condition? }>",
        auto_expansion: "Default follows template; *-only and single-agent default false.",
      },
      report_expansion: {
        mode: ["append", "replace"],
        fields: ["tasks", "nodes", "documents", "reason"],
      },
    },
    built_in_workflow_templates: BUILT_IN_WORKFLOW_TEMPLATES,
    workflow_examples: COMMON_WORKFLOW_EXAMPLES,
  }
}

export function findBuiltInWorkflowTemplate(id: string | undefined): BuiltInWorkflowTemplate | undefined {
  return BUILT_IN_WORKFLOW_TEMPLATES.find((item) => item.id === id)
}

export function createWorkflowSpec(args: {
  id: string
  templateID?: WorkflowKind
  kind: WorkflowSpec["kind"]
  title?: string
  orchestration: WorkflowOrchestration
  autoExpansionAllow?: boolean
  autoExpansionReason?: string
}): WorkflowSpec {
  const now = new Date().toISOString()
  const templateMatch = args.templateID ? findBuiltInWorkflowTemplate(args.templateID) : undefined
  const allow = args.autoExpansionAllow ?? templateMatch?.default_start_config.auto_expansion.allow ?? false
  return {
    id: args.id,
    template_id: args.templateID,
    kind: args.kind,
    title: args.title ?? templateMatch?.title ?? args.orchestration.title ?? "Custom workflow",
    auto_expansion: {
      allow,
      source: args.autoExpansionAllow === undefined ? "template" : "controller_override",
      reason: args.autoExpansionReason ?? templateMatch?.default_start_config.auto_expansion.reason,
    },
    orchestration: args.orchestration,
    created_at: now,
    updated_at: now,
  }
}

function template(args: {
  id: WorkflowKind
  title: string
  description: string
  recommended_for: string[]
  agents: Array<[phase: string, agent: keyof typeof AGENT_SKILL_MAP]>
  allowExpansion: boolean
  customization_points: string[]
  risk_notes: string[]
}): BuiltInWorkflowTemplate {
  return {
    id: args.id,
    title: args.title,
    description: args.description,
    recommended_for: args.recommended_for,
    default_start_config: {
      kind: "built_in_workflow",
      workflow_id: args.id,
      auto_expansion: {
        allow: args.allowExpansion,
        reason: args.allowExpansion ? "Full workflow templates allow validated planner/report expansion." : "Bounded templates default to no automatic expansion.",
      },
    },
    customization_points: args.customization_points,
    risk_notes: args.risk_notes,
    orchestration: buildTemplateOrchestration(args.id, args.title, args.agents),
  }
}

function buildTemplateOrchestration(
  id: string,
  title: string,
  agents: Array<[phase: string, agent: keyof typeof AGENT_SKILL_MAP]>,
): BuiltInWorkflowTemplate["orchestration"] {
  const nodes = agents.map(([phase, agent], index) => ({
    id: `${String(index + 1).padStart(2, "0")}-${phase}`,
    phase,
    agent,
    depends_on: index === 0 ? [] : [`${String(index).padStart(2, "0")}-${agents[index - 1]?.[0]}`],
    report_contract: ["sp_report"],
  }))
  const edges: NonNullable<BuiltInWorkflowTemplate["orchestration"]["edges"]> = []
  for (let index = 0; index < agents.length - 1; index += 1) {
    const from = `${String(index + 1).padStart(2, "0")}-${agents[index][0]}`
    const to = `${String(index + 2).padStart(2, "0")}-${agents[index + 1][0]}`
    edges.push({ from, to, condition: "passed" })
    if (["acceptance", "verification", "code-review"].includes(agents[index][0])) {
      const implementNode = nodes.find((node) => node.phase === "implement")
      if (implementNode) edges.push({ from, to: implementNode.id, condition: "failed" })
    }
  }
  return {
    id,
    title,
    nodes,
    edges,
  }
}
