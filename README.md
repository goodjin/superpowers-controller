# Superpowers Controller

Superpowers Controller 是一个面向 coding agents 的任务控制插件。它把 Superpowers methodology 从“靠 skill 提醒模型怎么做”推进到“由插件维护状态、调度节点、记录结果”的运行方式。

很多 agent 框架都把工作方法放在 skill 里。这个方式轻，也容易扩展，但长程任务会遇到几个现实问题：同一个会话加载太多 skill 后，上下文会变长，噪音会增多；把不同 skill 放到 subagent 里执行可以隔离一部分上下文，但任务编排、下一步判断和异常恢复通常还是落回主会话。

Superpowers Controller 的做法是让大模型负责理解任务、拆分任务和完成节点产出；插件负责程序化推进 workflow，持久化执行状态，并在重启或中断后恢复。它的目标很直接：节点一个不少，顺序不乱，结果有记录，日志能审计。

它基于 Superpowers methodology，是独立于上游 Superpowers plugin 的项目，也不隶属于上游 Superpowers 项目。上游 skills 主要提供工作方法；这个插件在这些方法之上加了一层状态机、路由、门禁、会话控制和结果记录，让设计、计划、调试、TDD、审查、验证这些步骤有状态可查、有证据可追、有 gate 可拦。

## 怎么使用

安装后在 OpenCode 中选择 `super-agent` 作为入口。后续需求确认、设计、计划、执行、验证、review、取消和恢复都通过 `super-agent` 调用插件工具推进。

最常见的使用路径：

```text
用户选择 super-agent
  -> super-agent 理解需求并调用 sp_prepare
  -> 插件生成任务摘要、需要的文档和可执行 workflow
  -> 用户确认后调用 sp_start
  -> 插件创建或复用节点会话
  -> 节点 agent 执行当前任务并通过 sp_report 汇报
  -> 插件记录 artifact、更新 gate、调度下一步
```

插件使用项目本地状态保存执行过程：

```text
.opencode/superpowers/current.json
.opencode/superpowers/runs/<run-id>/state.json
.opencode/superpowers/runs/<run-id>/artifacts/*.md
```

插件记录：

- 当前 workflow 和节点图
- 当前 phase 和下一步
- gate 状态，比如 `design_approved`、`plan_written`、`root_cause_found`、`red_test_seen`、`verification_fresh`
- 节点产物，比如 spec、plan、root cause、red test log、review、verification log
- history，方便恢复和解释为什么走到这一步

## 设计理念

Superpowers skills 的价值在于把成熟的工作方法写清楚，例如 brainstorming、planning、systematic debugging、TDD、code review 和 verification。问题在于，skill 本身只是方法文本。它能提醒模型，但不天然保存状态，也不会自动判断下一步该由谁做、什么时候该停、哪些证据已经满足。

当任务变长时，这个限制会放大。主会话里加载多个 skill，模型要同时记住目标、上下文、流程、历史决策和下一步动作，噪音会慢慢压过关键信息。使用 subagent 后，单个节点的上下文会干净一些，但主会话仍要负责拆任务、派发、收结果、处理失败和继续推进。时间一长，主会话还是会背上越来越多的流程负担。

Superpowers Controller 把这部分负担交给插件 runtime。模型继续做它擅长的事：理解用户意图、写设计、查 root cause、实现代码、做验证。插件负责把这些节点串起来：保存 workflow state，校验 gate，记录 artifacts，恢复中断任务，并把结果交给下一个节点。

可以把它看作一种动态工作流实现方案。workflow 可以由主控根据任务生成或裁剪；一旦进入执行，推进顺序、节点状态、结果记录和异常处理由插件接管。

## 组成部分

这个插件把执行链路拆成四层：

```text
super-agent -> Node Session -> Node Agent -> Primary Skill
      |
      v
State / Router / Gate / Session Control
```

各层职责：

- **super-agent**：用户入口。主会话总控负责理解需求、准备任务、恢复状态、创建或复用节点会话。
- **Node agent**：`sp-debugger`、`sp-implementer` 这类专门角色，只处理当前节点。
- **Skill**：节点的方法说明，比如 systematic debugging、TDD、verification。
- **Plugin state/gate/session control**：负责存状态、写 artifact、校验 gate、创建/复用会话、拦截不合规工具调用。

插件动态注入这些 agents：

| Agent | 角色 |
|---|---|
| `super-agent` | 主会话总控 |
| `sp-designer` | design 节点 |
| `sp-planner` | plan 节点 |
| `sp-debugger` | debug 节点 |
| `sp-investigator` | 并行只读调查节点 |
| `sp-implementer` | execute / TDD 节点 |
| `sp-acceptance-reviewer` | acceptance review |
| `sp-code-reviewer` | code quality review |
| `sp-verifier` | verification 节点 |
| `sp-finisher` | finish / branch completion |

运行时打包节点 agent 直接使用的 primary skills：

- `superpowers-brainstorming`
- `superpowers-writing-plans`
- `superpowers-systematic-debugging`
- `superpowers-test-driven-development`
- `superpowers-dispatching-parallel-agents`
- `superpowers-requesting-code-review`
- `superpowers-verification-before-completion`
- `superpowers-finishing-a-development-branch`

Agent 是角色，skill 是方法，插件 runtime 是推进和记录机制。Agent prompt 不整段复制 skill 内容，只声明职责、权限、primary skill 和结束时要调用 `sp_report`。具体流程细节仍来自 skill 文件。

最终设计要求一个节点会话只加载一个 primary skill；需要另一个 skill 时，插件创建另一个节点会话。这样可以把节点上下文控制在当前任务范围内，同时让主流程状态留在插件里。

插件会在创建节点会话时注入运行时 skill 上下文。它来自同一份节点定义，包含当前 workflow、phase、agent、`primary_skill` 和节点任务模板。这样 agent prompt、router、节点任务包和运行时系统消息看到的是同一份 skill map。

核心工具保持紧凑：

- `sp_status`：查看当前 workflow、节点、进度和可用能力。
- `sp_prepare`：准备任务、生成摘要和执行方案。
- `sp_start`：启动、继续或裁决 workflow。
- `sp_cancel`：取消当前 workflow。
- `sp_report`：节点 agent 提交结构化结果、证据和后续建议。

直接使用 Superpowers skills，适合已经熟悉流程、任务较短、状态压力不大的场景。这个插件更适合更长、更复杂、更容易中断的工作：

- 用户说“继续”时，插件先看当前 workflow state，而不是重新猜意图。
- 写入、修复、完成声明会经过 gate 检查。
- 每个节点要用 `sp_report` 记录 artifact 和证据。
- 并行调查先要求证明问题域独立、没有共享写入冲突。
- 多 agent 分工固定，review / verification 不容易被实现 agent 自己带过。
- 项目本地有 `state.json` 和 artifacts，后续恢复时有依据。

## 安装

npm 包名和 CLI 命令统一为 `superpowers-controller`。当前已验证运行环境是 OpenCode `>= 1.16.0`。

一键安装：

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install.sh | bash
```

手动安装：

```bash
bunx superpowers-controller install
```

检查安装：

```bash
bunx superpowers-controller doctor
```

也可以直接把 npm 包名加入 OpenCode 配置：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["superpowers-controller"]
}
```

如果你从早期开发包升级，请把旧的 `opencode-superpowers-controller` 配置项替换为 `superpowers-controller`。

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

这个命令会先构建插件，再运行可复用 harness smoke 和 workflow 场景。当前覆盖 debug root cause、strict debug gate、完整 feature lifecycle、`sp_report` 校验恢复、completion verification、active waiting status 查询和 strict execute gate 顺序。

## 设计文档

更多设计细节见：

```text
docs/superpowers/specs/2026-06-11-controller-final-design.md
docs/superpowers/specs/2026-06-28-controller-prd-v5.md
```
