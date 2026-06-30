# Kickoff Prompt

你现在要从零开始设计并实现一个 OpenCode 官方插件风格的项目。目标不是修改任何现有项目，而是在 `/Users/jin/github/superpowers-controller` 下创建一个独立插件，包名 `superpowers-controller`。

## 背景

我想借鉴 Superpowers 框架，但不是简单复制一堆 prompt。我要做的是一个 OpenCode 插件：插件本身维护 lightweight workflow state，半强制推进流程；每个节点由专门 agent 执行；节点执行时加载相应 skill；节点结果通过插件 tool 记录；插件根据结果和 gate 路由到下一节点。

核心目标：

- 大模型不负责整体流程可信性。
- 插件负责状态机、路由、门禁、恢复和证据记录。
- Agent 只负责当前节点的产出。
- Skill 作为节点执行说明，按需加载。
- 流程应参考 Superpowers 的规则，但要以 OpenCode 插件能力为落点。

## 参考资料

请先研究这些资料，不要直接开始写代码：

1. OMO / Oh My OpenAgent 源码参考：
   - 本地路径：`/tmp/oh-my-openagent-reference`
   - GitHub：`https://github.com/code-yeongyu/oh-my-openagent`

2. OMO 中值得学习的实现点：
   - `src/index.ts`：默认导出 `PluginModule`
   - `src/testing/create-plugin-module.ts`：插件入口组装方式
   - `src/plugin-interface.ts`：统一暴露 `tool`、`config`、`event`、`tool.execute.before/after` 等 hook
   - `src/plugin-handlers/config-handler.ts`：通过 OpenCode plugin `config` hook 注入 agents、commands、tools、mcp 等配置
   - `src/plugin-handlers/agent-config-handler.ts`：创建并合并内置 agents
   - `src/plugin/tool-registry.ts`：注册自定义 tools
   - `src/cli/config-manager/add-plugin-to-opencode-config.ts`：installer 如何修改 `opencode.json`
   - `.opencode/command`、`.opencode/skills`、`.agents/skills`：打包 commands / skills 的方式

3. OpenCode 官方能力：
   - Plugins: `https://opencode.ai/docs/plugins/`
   - Agents: `https://opencode.ai/docs/agents/`
   - Agent Skills: `https://dev.opencode.ai/docs/skills`
   - Commands: `https://opencode.ai/docs/commands/`

4. Superpowers skill 源文件：
   - `/Users/jin/.codex/plugins/cache/openai-curated/superpowers/c3319989/skills`

## 需要先分析的 Superpowers 工作流模式

请把 Superpowers 拆成工作流模式，而不是拆成孤立技能。至少覆盖这些模式：

1. `design`
   - 对应 `brainstorming`
   - 适用：新功能、创造性工作、行为变化、需求不清
   - gate：设计未批准前不能进入实现

2. `plan`
   - 对应 `writing-plans`
   - 适用：已有 spec/requirements，需要拆成可执行计划
   - gate：没有 plan artifact 不能执行实现任务

3. `execute`
   - 对应 `subagent-driven-development` 和 `executing-plans`
   - 适用：已有 implementation plan，需要逐任务执行
   - gate：每个 task 后必须经过 spec review 和 code quality review

4. `debug`
   - 对应 `systematic-debugging`
   - 适用：bug、test failure、build failure、unexpected behavior、performance issue
   - gate：没有 root cause artifact 不能提出或执行修复

5. `parallel-investigate`
   - 对应 `dispatching-parallel-agents`
   - 适用：多个相互独立的问题域
   - gate：必须证明问题域独立、无共享写入冲突

6. `review`
   - 对应 `requesting-code-review` 和 `receiving-code-review`
   - 适用：任务完成后主动审查，或收到外部 review feedback
   - gate：critical / important finding 未处理不能继续后续任务或完成

7. `verify-finish`
   - 对应 `verification-before-completion` 和 `finishing-a-development-branch`
   - 适用：准备声称完成、提交、PR、merge、交付
   - gate：没有 fresh verification evidence 不能声称 done/pass/fixed

8. `skill-authoring`
   - 对应 `writing-skills`
   - 适用：创建、修改、验证 skill
   - gate：要有 pressure scenario / baseline failure / compliance verification

横切 gate：

- `workspace-isolation`: 对应 `using-git-worktrees`
- `tdd`: 对应 `test-driven-development`
- `skill-dispatch`: 对应 `using-superpowers`

## 插件设计方向

请设计并实现一个插件包，而不是只写 agents。

建议模块：

```text
superpowers-controller/
  package.json
  tsconfig.json
  src/
    index.ts
    plugin.ts
    config/
      schema.ts
      load.ts
      defaults.ts
    state/
      store.ts
      types.ts
      transitions.ts
    router/
      classify.ts
      route.ts
      modes.ts
      gates.ts
    tools/
      sp-state.ts
      sp-route.ts
      sp-next.ts
      sp-record.ts
      sp-reset.ts
    agents/
      index.ts
      superpowers.ts
      designer.ts
      planner.ts
      debugger.ts
      implementer.ts
      spec-reviewer.ts
      code-reviewer.ts
      verifier.ts
      finisher.ts
    skills/
      index.ts
    commands/
      index.ts
    cli/
      index.ts
      install.ts
      doctor.ts
  assets/
    skills/
      brainstorming/SKILL.md
      writing-plans/SKILL.md
      systematic-debugging/SKILL.md
      test-driven-development/SKILL.md
      dispatching-parallel-agents/SKILL.md
      subagent-driven-development/SKILL.md
      executing-plans/SKILL.md
      requesting-code-review/SKILL.md
      receiving-code-review/SKILL.md
      verification-before-completion/SKILL.md
      finishing-a-development-branch/SKILL.md
      using-git-worktrees/SKILL.md
      using-superpowers/SKILL.md
      writing-skills/SKILL.md
    commands/
      sp.md
      sp-design.md
      sp-plan.md
      sp-debug.md
      sp-execute.md
      sp-review.md
      sp-verify.md
```

这只是建议结构。如果你发现 OMO 有更适合的布局，可以调整，但要解释取舍。

## 核心运行模型

插件应维护 workflow state。建议类型：

```ts
type WorkflowMode =
  | "idle"
  | "design"
  | "plan"
  | "execute"
  | "debug"
  | "parallel-investigate"
  | "review"
  | "verify-finish"
  | "skill-authoring"

type WorkflowState = {
  id: string
  project: string
  session: string
  mode: WorkflowMode
  phase: string
  goal: string
  created_at: string
  updated_at: string
  gates: {
    design_approved?: boolean
    spec_written?: boolean
    plan_written?: boolean
    worktree_ready?: boolean
    root_cause_found?: boolean
    red_test_seen?: boolean
    implementation_done?: boolean
    spec_review_passed?: boolean
    code_review_passed?: boolean
    verification_fresh?: boolean
  }
  artifacts: {
    spec?: string
    plan?: string
    root_cause?: string
    red_test_log?: string
    patch_summary?: string
    spec_review?: string
    code_review?: string
    verification_log?: string
  }
  history: Array<{
    at: string
    event: string
    from?: string
    to?: string
    reason?: string
  }>
  next?: string
}
```

状态建议存到项目本地：

```text
.opencode/superpowers/runs/<run-id>/state.json
.opencode/superpowers/runs/<run-id>/artifacts/*.md
```

也可以支持用户全局状态，但第一版优先 project-local。

## 路由逻辑要求

请实现一个明确的路由器，不要只把判断写进 prompt。

路由优先级：

1. 显式 slash command 优先，例如 `/sp-debug`、`/sp-plan`。
2. 当前 workflow state 优先。如果正在等待 design approval，用户说“继续”不应该重新分类。
3. 工具调用 gate 优先。如果 agent 试图写入但当前 gate 不满足，插件要阻断并提示下一步。
4. 初始意图分类兜底：
   - bug/test/build/error/crash/unexpected/performance -> `debug`
   - build/add/create/change/refactor/implement/support -> `design`
   - plan/spec/task breakdown -> `plan`
   - execute/continue plan/do tasks -> `execute`
   - review/PR feedback/code review -> `review`
   - done/finish/commit/PR/merge/verify -> `verify-finish`
   - skill/create skill/update skill -> `skill-authoring`
5. 低置信度时不要猜，路由到 `clarify` phase，并让 `superpowers` agent 问一个问题。

## Gate enforcement

必须用 `tool.execute.before` 做半强制 gate。至少拦截：

- `write`
- `edit`
- `patch`
- `bash`
- 其他能修改文件、git 状态或外部系统的工具

Gate 规则：

- 如果当前是新功能/行为修改，`design_approved !== true` 时阻止写入。
- 如果当前是 execute，`plan_written !== true` 时阻止执行 task。
- 如果当前是 debug，`root_cause_found !== true` 时阻止修复性写入。
- 如果写生产代码，`red_test_seen !== true` 时阻止写入，除非配置允许 `tdd: "advisory"`。
- 如果准备完成，`verification_fresh !== true` 时阻止 done/pass/fixed 类型的完成记录。

注意：第一版不必做到语义完美。可以只做显式工具调用层面的 gate 和 `sp_record` 层面的状态 gate。

## Tools

插件至少提供这些 tools：

- `sp_state`: 读取当前 workflow state。
- `sp_route`: 根据 user request / command / current state 返回推荐 mode、phase、agent、skills、required gates。
- `sp_next`: 推进到下一个节点，返回下一步 prompt。
- `sp_record`: Agent 用来记录节点结果、artifact、evidence、gate updates。
- `sp_reset`: 用户或 agent 明确重置当前 workflow。

`sp_record` 要做状态迁移校验。不要让 agent 随便把所有 gate 设为 true。

## Agents

插件应通过 OpenCode plugin `config` hook 动态注入 agents，参考 OMO，不要只依赖用户手动复制 agent 配置。

至少需要：

- `superpowers`: primary/controller agent，只负责路由、解释状态、调用 `sp_route` / `sp_next`，不直接写代码。
- `sp-designer`: design 节点，加载 `brainstorming`。
- `sp-planner`: plan 节点，加载 `writing-plans`。
- `sp-debugger`: debug 节点，加载 `systematic-debugging`。
- `sp-implementer`: execute/tdd 节点，加载 `test-driven-development`。
- `sp-spec-reviewer`: spec compliance review。
- `sp-code-reviewer`: code quality review。
- `sp-verifier`: completion verification。
- `sp-finisher`: branch completion。

Agent prompt 必须要求节点结束时调用 `sp_record`，并给出结构化结果。

## Skills

第一版可以把 Superpowers 的 SKILL.md 作为 bundled assets 安装到：

```text
~/.config/opencode/skills/superpowers-*/SKILL.md
```

或者通过插件提供 runtime skill source。如果实现成本太高，先做 installer 复制文件。

OpenCode skill 命名要满足官方规则：小写、数字、单 hyphen、目录名和 `name` 一致。必要时把 upstream 名称加前缀，例如：

- `superpowers-brainstorming`
- `superpowers-writing-plans`
- `superpowers-systematic-debugging`

## Commands

提供 slash commands：

- `/sp`：进入 controller，自动分类
- `/sp-design`
- `/sp-plan`
- `/sp-debug`
- `/sp-execute`
- `/sp-review`
- `/sp-verify`
- `/sp-reset`

commands 可以由 installer 复制到：

```text
~/.config/opencode/commands/
```

也可以通过 `config` hook 注入 `config.command`，优先参考 OMO 的 command config handler。

## Installer

参考 OMO 的 installer 做一个最小 CLI：

```bash
bunx superpowers-controller install
bunx superpowers-controller doctor
```

`install` 至少要：

1. 检查 OpenCode 是否存在。
2. 检查或创建 `~/.config/opencode/opencode.json` / `.jsonc`。
3. 把插件包名加入 `plugin` 数组。
4. 安装或复制 bundled skills / commands。
5. 创建默认配置文件：

```text
~/.config/opencode/superpowers-controller.jsonc
```

`doctor` 至少检查：

- OpenCode 可执行文件和版本。
- 插件是否在 `opencode.json` 的 `plugin` 数组里。
- skills 是否可发现。
- commands 是否可发现。
- state 目录是否可写。
- 当前包版本。

## 配置

设计一个简洁配置：

```jsonc
{
  "$schema": "https://example.invalid/superpowers-controller.schema.json",
  "mode": "strict", // strict | guided | off
  "tdd": "strict", // strict | advisory | off
  "design_gate": "strict", // strict | advisory | off
  "debug_gate": "strict",
  "verification_gate": "strict",
  "disabled_workflows": [],
  "disabled_agents": [],
  "disabled_skills": [],
  "state": {
    "scope": "project", // project | global
    "retention_days": 30
  }
}
```

`strict` 表示阻断工具调用；`advisory` 表示只提示 toast/log；`off` 表示不启用该 gate。

## 测试要求

先写测试，再实现关键逻辑。至少覆盖：

1. `route()` 能把典型请求分到正确 workflow。
2. 当前 state 会覆盖初始分类。
3. `sp_record` 拒绝非法状态跃迁。
4. `tool.execute.before` 在缺少 design approval 时阻断写入。
5. 缺少 root cause 时阻断 debug 修复写入。
6. 缺少 red test evidence 时阻断生产代码写入。
7. fresh verification gate 生效。
8. installer 对已有 `opencode.jsonc` 进行安全合并并保留用户字段。

## 交付物

请按顺序交付：

1. 先输出一份设计说明，说明你从 OMO 学到哪些实现方式，以及哪些不采用。
2. 给出插件最小可行架构和状态机。
3. 列出需要用户确认的问题。
4. 用户确认后再开始 scaffold 和实现。

不要跳过设计直接写代码。

## 待确认问题

在开始实现前，请向我确认这些点：

1. 插件名称是否采用 `superpowers-controller`？如果不采用，请给 2-3 个命名备选。
2. 第一版是否只支持 OpenCode，不支持 Codex / Claude Code？
3. 默认 gate 模式是 `strict` 还是 `guided`？
4. bundled skills 是否保留 Superpowers 原文，还是做 opencode 命名和内容适配？
5. 状态是否只存 project-local `.opencode/superpowers/`，还是也支持 global？
6. Agent 是否通过 plugin `config` hook 动态注入，还是 installer 写入用户 config？我的倾向是动态注入。
7. 是否需要第一版就支持并行多 agent，还是先做单 workflow run？
8. 是否需要 doctor 和 uninstall 在第一版完成？

## 重要约束

- 不要修改 `/Users/jin/github/open-agent-harness`。
- OMO 源码只作参考，不要复制其专有代码。
- 保持包体小，第一版避免 MCP、tmux、model fallback、telemetry。
- 实现应优先依赖 OpenCode 官方 plugin API：`config`、`tool`、`tool.execute.before/after`、`event`。
- 所有 workflow gate 都要能从 state 和 artifacts 解释，不能只靠 prompt。
