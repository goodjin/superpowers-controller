# Superpowers Controller for OpenCode

Superpowers Controller for OpenCode 是一个面向 OpenCode 的流程控制插件。

它基于 Superpowers methodology，但不等同于上游 Superpowers plugin。上游 skills 主要提供工作方法；这个插件在这些方法之上加了一层轻量状态机、路由和门禁，让设计、计划、调试、TDD、审查、验证这些步骤有状态可查、有证据可追、有 gate 可拦。

一句话：

> Superpowers Controller for OpenCode adds a lightweight workflow state machine and gate system on top of the Superpowers methodology, so OpenCode agents follow design, planning, debugging, TDD, review, and verification flows without relying on prompt discipline alone.

## 边界

- This project builds on the Superpowers methodology.
- It is not the upstream Superpowers plugin.
- Use upstream Superpowers if you only need skills; use this plugin if you want stateful workflow routing and gates.

对应到中文：

- 它借鉴并打包 Superpowers 方法论。
- 它不是上游 Superpowers plugin。
- 如果你只需要 skills，直接用上游 Superpowers 就够了；如果你希望 OpenCode 记住流程状态、自动路由节点、在证据不足时拦住写入和完成声明，用这个插件更合适。

## 用途

很多 agent 工作流的问题不在于模型不知道流程，而在于流程只写在 prompt 里。上下文一长、任务一多、用户一句“继续”，模型就可能跳过设计、没写计划就动手、没 root cause 就修 bug、没 fresh verification 就说 done。

这个插件把这些流程信息放进项目本地状态：

```text
.opencode/superpowers/current.json
.opencode/superpowers/runs/<run-id>/state.json
.opencode/superpowers/runs/<run-id>/artifacts/*.md
```

插件记录：

- 当前 workflow mode：`design`、`plan`、`execute`、`debug`、`parallel-investigate`、`review`、`verify-finish`、`skill-authoring`
- 当前 phase 和下一步
- gate 状态，比如 `design_approved`、`plan_written`、`root_cause_found`、`red_test_seen`、`verification_fresh`
- 节点产物，比如 spec、plan、root cause、red test log、review、verification log
- history，方便恢复和解释为什么走到这一步

## 设计理念

这个插件把工作拆成四层：

```text
Command -> Controller Agent -> Node Agent -> Skill
             |
             v
       State / Router / Gate
```

各层职责：

- **Command**：用户入口，比如 `/sp-debug`、`/sp-plan`。
- **Controller agent**：`superpowers`，负责看状态、调用 `sp_route` / `sp_next`，不直接写代码。
- **Node agent**：`sp-debugger`、`sp-implementer` 这类专门角色，只处理当前节点。
- **Skill**：节点的方法说明，比如 systematic debugging、TDD、verification。
- **Plugin state/gate**：负责存状态、写 artifact、校验 gate、拦截不合规工具调用。

这套设计的关键点是：模型可以负责当前节点的思考和产出，但流程可信性由插件兜住。比如 debug 模式下，缺少 `root_cause` artifact 时，严格模式会阻止修复性写入；完成前没有 `verification_log`，就不能通过 `sp_record` 记录 done。

## Agents 和 Skills 的关系

当前插件动态注入 9 个 agents：

| Agent | 角色 |
|---|---|
| `superpowers` | controller / primary agent |
| `sp-designer` | design 节点 |
| `sp-planner` | plan / skill-authoring 节点 |
| `sp-debugger` | debug 节点 |
| `sp-implementer` | execute / TDD 节点 |
| `sp-spec-reviewer` | spec compliance review |
| `sp-code-reviewer` | code quality review |
| `sp-verifier` | verification 节点 |
| `sp-finisher` | finish / branch completion |

同时打包 14 个 `superpowers-*` skills：

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
- `superpowers-writing-skills`

这两组没有互相替代。Agent 是角色，skill 是做事方法。

Agent prompt 没有整段复制 skill 内容。它是新设计的轻量角色规则：说明这个 agent 的职责、权限、要加载哪些 skill、结束时要调用 `sp_record`。具体流程细节仍然来自 skill 文件。运行时，节点 agent 应按 prompt 加载对应 skill。

插件还会在活动 workflow 存在时注入一段运行时 skill 上下文。它来自同一份 `MODE_DEFINITIONS`，包含当前 mode、phase、agent、`primary_skill`、`supporting_skills` 和 session policy。这样 agent prompt、router、`sp_next` 和运行时系统消息看到的是同一份 skill map。

当前策略是：一个会话优先承接一个 primary skill；如果 supporting skill 需要独立工作，创建或路由到新的 subagent session。这个策略现在是运行时注入和 agent 规则，尚未做到硬性拦截第二个 skill load。要做到硬保证，需要继续拦截 OpenCode 的 `skill` tool 调用，并按 session 记录已加载 skill。

例子：

```text
/sp-debug
  -> superpowers controller
  -> sp_route 判断为 debug
  -> sp-debugger
  -> 加载 superpowers-systematic-debugging
  -> 记录 root_cause artifact
  -> root_cause_found gate 打开
```

如果用户在 OpenCode 里直接选择某个节点 agent，比如 `sp-debugger`，它仍然会看到自己的角色 prompt：聚焦 debug、加载 `superpowers-systematic-debugging`、结束时调用 `sp_record`。但直接选择节点 agent 会绕过 controller 的初始路由体验，所以更推荐通过 `/sp` 或 `/sp-debug` 进入。gate 仍在插件层；只要工具调用经过 OpenCode plugin hook，缺证据时仍会被提示或阻断。

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

这个 e2e 使用临时 `HOME` 和 `XDG_CONFIG_HOME`，通过 `file://dist/index.js` 加载插件，验证 OpenCode 1.16.2 能启动插件并看到 9 个动态注入 agents。它不需要模型账号，也不会改真实 OpenCode 配置。
