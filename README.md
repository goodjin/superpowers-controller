# Superpowers Controller

Superpowers Controller 是一个面向 coding agents 的状态控制插件。

它基于 Superpowers methodology，但不等同于上游 Superpowers plugin。上游 skills 主要提供工作方法；这个插件在这些方法之上加了一层状态机、路由、门禁、会话控制和结果记录，让设计、计划、调试、TDD、审查、验证这些步骤有状态可查、有证据可追、有 gate 可拦。

一句话：

> Superpowers Controller adds state, routing, gates, session control, and result recording on top of the Superpowers methodology, so coding agents can follow disciplined development workflows without relying on prompt discipline alone.

## 边界

- This project builds on the Superpowers methodology.
- It is not the upstream Superpowers plugin.
- It is not affiliated with the upstream Superpowers project.
- Use upstream Superpowers if you only need skills; use this plugin if you want state, routing, gates, session control, and result recording.

对应到中文：

- 它借鉴并打包 Superpowers 方法论。
- 它是独立项目，不隶属于上游 Superpowers plugin。
- 它没有上游 Superpowers 项目的官方背书。
- 如果你只需要 skills，直接用上游 Superpowers 就够了；如果你希望 agent 记住流程状态、自动路由节点、在证据不足时拦住写入和完成声明，用这个插件更合适。

## 用途

很多 agent 工作流的问题不在于模型不知道流程，而在于流程只写在 prompt 里。上下文一长、任务一多、用户一句“继续”，模型就可能跳过设计、没写计划就动手、没 root cause 就修 bug、没 fresh verification 就说 done。

最终设计文档见：

```text
docs/superpowers/specs/2026-06-11-controller-final-design.md
```

这个插件把这些流程信息放进项目本地状态：

```text
.opencode/superpowers/current.json
.opencode/superpowers/runs/<run-id>/state.json
.opencode/superpowers/runs/<run-id>/artifacts/*.md
```

插件记录：

- 当前 workflow：`feature`、`debug`、`plan-only`、`review`、`verify-finish`、`parallel-investigate`
- 当前 phase 和下一步
- gate 状态，比如 `design_approved`、`plan_written`、`root_cause_found`、`red_test_seen`、`verification_fresh`
- 节点产物，比如 spec、plan、root cause、red test log、review、verification log
- history，方便恢复和解释为什么走到这一步

## 设计理念

这个插件把工作拆成四层：

```text
Command -> super-agent -> Node Session -> Node Agent -> Primary Skill
             |
             v
       State / Router / Gate / Session Control
```

各层职责：

- **Command**：用户入口，比如 `/sp-debug`、`/sp-plan`。
- **super-agent**：主会话总控，负责确认需求、恢复状态、创建/复用子会话，不直接写代码。
- **Node agent**：`sp-debugger`、`sp-implementer` 这类专门角色，只处理当前节点。
- **Skill**：节点的方法说明，比如 systematic debugging、TDD、verification。
- **Plugin state/gate/session control**：负责存状态、写 artifact、校验 gate、创建/复用会话、拦截不合规工具调用。

这套设计的关键点是：模型可以负责当前节点的思考和产出，但流程可信性由插件兜住。比如 debug 模式下，缺少 `root_cause` artifact 时，严格模式会阻止修复性写入；完成前没有 `verification_log`，就不能通过 `sp_record` 记录 done。

## Agents 和 Skills 的关系

最终设计中插件动态注入这些 agents：

| Agent | 角色 |
|---|---|
| `super-agent` | 主会话总控 |
| `sp-designer` | design 节点 |
| `sp-planner` | plan 节点 |
| `sp-debugger` | debug 节点 |
| `sp-investigator` | 并行只读调查节点 |
| `sp-implementer` | execute / TDD 节点 |
| `sp-spec-reviewer` | spec compliance review |
| `sp-code-reviewer` | code quality review |
| `sp-verifier` | verification 节点 |
| `sp-finisher` | finish / branch completion |

同时打包 13 个 `superpowers-*` skills：

- `superpowers-brainstorming`
- `superpowers-writing-plans`
- `superpowers-systematic-debugging`
- `superpowers-test-driven-development`
- `superpowers-dispatching-parallel-agents`
- `superpowers-subagent-driven-development`
- `superpowers-executing-plans`
- `superpowers-requesting-code-review`
- `superpowers-receiving-code-review`
- `superpowers-verification-before-completion`
- `superpowers-finishing-a-development-branch`
- `superpowers-using-git-worktrees`
- `superpowers-using-superpowers`

这两组没有互相替代。Agent 是角色，skill 是做事方法。

Agent prompt 没有整段复制 skill 内容。它是新设计的轻量角色规则：说明这个 agent 的职责、权限、primary skill 和结束时要调用 `sp_record`。具体流程细节仍然来自 skill 文件。最终设计要求一个节点会话只加载一个 primary skill；需要另一个 skill 时，插件创建另一个节点会话。

插件会在创建节点会话时注入运行时 skill 上下文。它来自同一份节点定义，包含当前 workflow、phase、agent、`primary_skill` 和节点任务模板。这样 agent prompt、router、节点任务包和运行时系统消息看到的是同一份 skill map。

最终控制权边界是：大模型只执行节点任务并通过 `sp_record` 提交规范化结果；插件负责保存状态、判断结果、创建或复用下一步会话。

例子：

```text
/sp-debug
  -> super-agent 确认 debug workflow
  -> 插件创建 workflow run
  -> sp-debugger
  -> 加载一个 primary skill: superpowers-systematic-debugging
  -> sp_record 提交 root_cause artifact
  -> 插件写 artifact、打开 root_cause_found gate、调度下一步
```

如果用户在 OpenCode 里直接选择某个节点 agent，比如 `sp-debugger`，它仍然会看到自己的角色 prompt：聚焦 debug、加载 `superpowers-systematic-debugging`、结束时调用 `sp_record`。但直接选择节点 agent 会绕过 super-agent 的需求确认和恢复逻辑，所以推荐通过 `/sp` 或 `/sp-debug` 进入。

## Commands

Commands 以动态注入为主，不再由 installer 复制 markdown command 文件。

插件注入这些 slash commands：

- `/sp`
- `/sp-design`
- `/sp-plan`
- `/sp-debug`
- `/sp-execute`
- `/sp-review`
- `/sp-verify`
- `/sp-reset`

这样用户 config 更干净，插件升级时 command 文案也跟着更新。

## 相比直接使用 Superpowers skills 的优势

直接使用 Superpowers skills，适合已经很熟悉流程的人。它轻、直接、没有额外状态。

这个插件适合更长、更复杂、更容易中断的工作：

- 用户说“继续”时，插件先看当前 workflow state，而不是重新猜意图。
- 写入、修复、完成声明会经过 gate 检查。
- 每个节点要用 `sp_record` 记录 artifact 和证据。
- 并行调查先要求证明问题域独立、没有共享写入冲突。
- 多 agent 分工固定，review / verification 不容易被实现 agent 自己带过。
- 项目本地有 `state.json` 和 artifacts，后续恢复时有依据。

## 安装

当前 OpenCode adapter 的开发包和命令仍使用 `opencode-superpowers-controller`。品牌名已经定为 `Superpowers Controller`，发布包名后续可以单独同步到 `superpowers-controller`。

```bash
bunx opencode-superpowers-controller install
```

检查安装：

```bash
bunx opencode-superpowers-controller doctor
```

## 配置

默认配置是 guided：遇到 gate 问题会提示，但不直接阻断。可以切到 strict：

```jsonc
{
  "mode": "guided",
  "tdd": "strict",
  "design_gate": "guided",
  "debug_gate": "guided",
  "verification_gate": "guided",
  "state": {
    "scope": "project",
    "retention_days": 30
  }
}
```

`strict` 会阻断工具调用；`guided` 记录 warning；`off` 关闭对应 gate。

## 开发和验证

安装依赖：

```bash
bun install
```

单元测试：

```bash
bun run test
```

构建：

```bash
bun run build
```

项目内已经下载了隔离的 OpenCode 1.16.2：

```text
tools/opencode-1.16.2/
```

运行 OpenCode 1.16.2 smoke e2e：

```bash
bun run e2e:opencode
```

这个 e2e 使用临时 `HOME` 和 `XDG_CONFIG_HOME`，通过 `file://dist/index.js` 加载插件，验证 OpenCode 1.16.2 能启动插件并看到 10 个动态注入 agents。它不需要模型账号，也不会改真实 OpenCode 配置。

运行带 mock LLM 的 OpenCode e2e：

```bash
bun run e2e:opencode:mock-llm
```

这个 e2e 启动本地 OpenAI-compatible mock 服务，把临时 OpenCode provider 指向 `llm-mock/test-model`。测试 prompt 使用 `[llm_request_id:<id>]` marker 选择预设响应，用来稳定验证真实 OpenCode runtime 下的模型请求路径。

运行 workflow e2e：

```bash
bun run test:e2e:opencode
```

这个命令会先构建插件，再运行可复用 harness smoke 和 workflow 场景。当前覆盖 debug root cause、strict debug gate、完整 feature lifecycle、`sp_record` 校验恢复、completion verification、active waiting reroute 和 strict execute gate 顺序。
