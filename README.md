# Superpowers Controller

Superpowers Controller 是一种通过 Agent 来使用 Superpowers 框架的插件。

安装后默认入口会设为 `super-agent`。

这个 Agent 会按 Superpowers 框架的规则和流程执行任务，并自动使用相关 Skill，不需要手动触发。

大模型负责理解任务、拆分任务和完成节点产出。

插件通过程序控制各个环节的执行，维护状态、调度节点、记录结果，减少大上下文污染和注意力漂移带来的中断或流程跑偏问题。

## 怎么使用

一行命令安装：

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install.sh | bash
```

安装后检查：

```bash
bunx superpowers-controller doctor
opencode agent list
```

安装器会把 OpenCode 的 `default_agent` 设为 `super-agent`。之后正常启动即可：

```bash
opencode
```

也可以显式指定：

```bash
opencode --agent super-agent
```

如果要从本项目源码编译后安装可以这样：

```bash
git clone https://github.com/goodjin/superpowers-controller.git
cd superpowers-controller
bun install
bun run build
bash scripts/install.sh
```

这个本地安装路径会使用当前 checkout 的源码 CLI 写入 OpenCode 配置，并同步插件打包的 primary skills。

## 设计理念

Superpowers 原本主要通过 Skill 承载工作方法。Skill 很轻，也容易扩展，但长程任务会把问题放大：同一个主会话加载太多 Skill 后，上下文变长、噪音变多；改用 subagent 可以隔离单个节点，但任务编排、结果回收、失败处理和继续推进仍会压回主会话。

Superpowers Controller 把 Skill 的使用封装进 Agent 流程里。用户只选择 `super-agent`，Agent 负责按流程调用合适的 Skill；插件 runtime 负责保存 workflow state、校验 gate、记录 artifacts、调度下一步，并在重启后恢复。

持久化是这套方案的关键。每次 prepare、start、report、gate、节点结果和异常状态都会落到项目本地文件里，方便中断后恢复，也方便回头跟踪任务为什么走到某一步、哪个节点提交了什么证据。

可以把它看作动态工作流方案：workflow 可以由主控根据任务生成或裁剪；进入执行后，节点顺序、执行状态、结果记录和异常处理由插件接管。

## 组成部分

```text
super-agent -> Node Session -> Node Agent -> Primary Skill
      |
      v
State / Router / Gate / Session Control
```

- **super-agent**：用户入口，负责理解需求、准备任务、恢复状态、创建或复用节点会话。
- **Node agent**：专门角色，例如 `sp-debugger`、`sp-implementer`、`sp-verifier`。
- **Primary skill**：节点使用的方法，例如 systematic debugging、TDD、verification。
- **Plugin runtime**：负责状态、路由、gate、会话控制、artifact 记录和恢复。

核心工具：

- `sp_status`：查看当前 workflow、节点、进度和可用能力。
- `sp_prepare`：准备任务、生成摘要和执行方案。
- `sp_start`：启动、继续或裁决 workflow。
- `sp_cancel`：取消当前 workflow。
- `sp_report`：节点 agent 提交结构化结果、证据和后续建议。

内置工作流程：

- `feature`：设计/计划、实现、验收、验证、代码审查、收尾。
- `bugfix` / `debug`：先定位根因，再修复、回归验证、审查、收尾。
- `review`：围绕已有改动做验收、验证、代码审查和收尾。
- `verify-finish`：完成前运行新鲜验证并收口。
- `design-only` / `plan-only` / `review-only`：只产出对应结果，默认不自动扩展到实现。
- `parallel-investigate`：并行调查多个独立方向，再汇总。
- `single-agent`：只派发一个指定节点，适合范围很小的任务。

插件状态保存在项目本地：

```text
.opencode/superpowers/current.json
.opencode/superpowers/runs/<run-id>/state.json
.opencode/superpowers/runs/<run-id>/artifacts/*.md
```

## 配置

这里配置的是 Superpowers Controller 的运行策略，文件位于 OpenCode 配置目录下的 `superpowers-controller.jsonc`。它不配置模型、provider 或 API key，只控制 workflow gate、状态保留和插件行为。

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

## 开发验证

```bash
bun install
bun run test
bun run build
bun run e2e:opencode
```

更多设计细节见：

```text
docs/superpowers/specs/2026-06-11-controller-final-design.md
docs/superpowers/specs/2026-06-28-controller-prd-v5.md
```
