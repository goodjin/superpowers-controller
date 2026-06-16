# Agents Module

## Responsibility

agents 模块负责注入 Superpowers Controller 的 OpenCode agent 配置。`super-agent` 是主会话控制器；节点 agent 只执行当前节点，并按 router 指定的 primary skill 工作。

## Files

- `src/agents/index.ts`：生成 `super-agent` 和所有 `sp-*` 节点 agent 的配置。
- `src/router/modes.ts`：维护 workflow mode、phase、agent、primary skill、gate 和 next action 的映射。

## Agent Catalog

| Agent | Mode | 用途 | 适用场景 | Primary skill |
|---|---|---|---|---|
| `super-agent` | `primary` | 主会话控制器，确认用户意图、恢复或创建 workflow state，并通过插件工具推进调度。 | 用户通过 `/sp` 或 `/sp-*` 入口启动、继续、查看或推进 Superpowers workflow 时。 | 无。控制器不加载业务 skill。 |
| `sp-designer` | `subagent` | 设计和 spec 节点，澄清改动形状并产出设计产物。 | `design` mode；需要在实现前明确需求、方案、边界和验收条件时。 | `superpowers-brainstorming` |
| `sp-planner` | `subagent` | 计划节点，把已确认需求转成 implementation plan 和 `depends_on` task graph。 | `plan` mode；已有 spec 或需求，需要拆成可执行任务和依赖关系时。 | `superpowers-writing-plans` |
| `sp-debugger` | `subagent` | 调试节点，先调查症状并记录 root cause，再允许修复工作开始。 | `debug` mode；遇到 bug、测试失败或异常行为，需要先定位原因时。 | `superpowers-systematic-debugging` |
| `sp-investigator` | `subagent` | 只读调查节点，读取一个独立问题域并返回 findings，不修改文件。 | `parallel-investigate` mode；多个独立领域可以并行调查，或需要把研究工作隔离到子会话时。 | `superpowers-dispatching-parallel-agents` |
| `sp-implementer` | `subagent` | 实现节点，执行一个已分配任务，按 TDD 记录证据和补丁摘要。 | `execute` mode；已有计划和任务，需要写测试、实现、记录结果时。 | `superpowers-test-driven-development` |
| `sp-spec-reviewer` | `subagent` | spec review 节点，检查实现是否满足用户请求、spec 和 plan。 | `review` mode 的第一段；实现完成后先做需求符合性审查。 | `superpowers-requesting-code-review` |
| `sp-code-reviewer` | `subagent` | code review 节点，检查回归风险、质量问题、测试缺口和可维护性。 | `review` mode 的第二段；spec review 通过后再做代码质量审查。 | `superpowers-requesting-code-review` |
| `sp-verifier` | `subagent` | 验证节点，重新运行验证命令并记录命令证据。 | `verify-finish` mode；完成声明、提交或交付前需要 fresh verification 时。 | `superpowers-verification-before-completion` |
| `sp-finisher` | `subagent` | 收尾节点，只在验证通过后准备最终交付。 | workflow 已完成实现、审查和验证，需要决定交付、分支或清理动作时。 | `superpowers-finishing-a-development-branch` |

## Workflow Modes

| Mode | Phase | Agent | Required gates | Next action |
|---|---|---|---|---|
| `idle` | `clarify` | `super-agent` | 无 | 澄清意图、检测现有 workflow state，并在 dispatch 前请求用户确认。 |
| `design` | `explore` | `sp-designer` | `request_confirmed`, `design_approved`, `spec_written` | 创建 design/spec artifact 并记录 design gates。 |
| `plan` | `write-plan` | `sp-planner` | `request_confirmed`, `plan_written` | 写 implementation plan 和 task graph artifact。 |
| `execute` | `run-task` | `sp-implementer` | `plan_written`, `red_test_seen`, `implementation_done` | 执行一个可运行任务，按 TDD 记录证据。 |
| `debug` | `find-root-cause` | `sp-debugger` | `request_confirmed`, `root_cause_found` | 找到并记录 root cause，再进入修复。 |
| `parallel-investigate` | `investigate` | `sp-investigator` | `request_confirmed` | 对一个独立问题域做只读调查。 |
| `review` | `spec-review` | `sp-spec-reviewer` | `spec_review_passed`, `code_review_passed` | 先做 spec review，通过后再做 code review。 |
| `verify-finish` | `fresh-verification` | `sp-verifier` | `verification_fresh` | 运行 fresh verification；失败时回派实现节点。 |

## Skill Boundary

- `super-agent` 不加载业务技能，也不执行节点工作。
- `super-agent` 禁用 `tools.skill`，避免全局 skill 进入控制器上下文。
- 节点 agent 保留 `skill` tool，但 `permission.skill` 只允许 router 分配的 primary skill，并拒绝其它全局 skill。
- 节点 agent prompt 只声明一个 primary skill；需要其他 skill 时，由控制器创建或复用另一个节点 session。

## Notes

- `src/router/modes.ts` 是 agent 到 primary skill 的运行时真相；文档变更需要和该文件同步。
- `src/agents/index.ts` 是 agent prompt、permission 和 OpenCode mode 的运行时真相。
- review workflow 当前用 `sp-spec-reviewer` 作为 mode 入口；code review 的串行推进由 transition 和后续 dispatch 决定。
