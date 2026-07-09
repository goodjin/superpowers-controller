# Skills Module

## Responsibility

skills 模块负责打包 Superpowers methodology 中会被节点 agent 直接加载的 primary skill 文件。Agent 是角色，skill 是方法；插件控制 workflow state、gate 和 session 调度。Support skills 不进入 runtime bundle，只保留在官方归档中供查阅。

## Files

- `assets/skills/*/SKILL.md`：runtime primary skill 的正文和 frontmatter 描述。
- `docs/superpowers/official-skills/`：官方 Superpowers 插件缓存中的完整 skill 归档，用于查阅和对比，不参与运行时安装。
- `src/router/modes.ts`：运行时 primary skill 映射。
- `src/skills/runtime-injection.ts`：workflow active 时注入当前 mode、phase、agent 和 primary skill 上下文。
- `src/cli/install.ts`：安装 runtime primary skills 到 OpenCode config 的 `skills/` 目录。

## Skill Catalog

| Skill | 用途 | 适用场景 | Workflow usage |
|---|---|---|---|
| `superpowers-brainstorming` | 把想法澄清成设计和 spec，先理解目标、约束和验收标准。 | 创建功能、修改行为、做有设计空间的改动，且尚未进入实现时。 | `sp-designer` 的 primary skill。 |
| `superpowers-writing-plans` | 把 spec 或需求拆成详细 implementation plan。 | 已有确认过的需求，需要列出文件、任务、测试和执行顺序时。 | `sp-planner` 的 primary skill。 |
| `superpowers-systematic-debugging` | 对 bug、测试失败和异常行为做系统化 root cause 调查。 | 需要先证明原因，再开始修复，避免只改症状时。 | `sp-debugger` 的 primary skill。 |
| `superpowers-test-driven-development` | 先写失败测试，再写最小实现，并记录 TDD 证据。 | 实现功能或修 bug，尤其是需要可验证行为变化时。 | `sp-implementer` 的 primary skill。 |
| `superpowers-dispatching-parallel-agents` | 把多个互不依赖的问题域分派给隔离上下文的 agent。 | 有两个以上独立调查或修复方向，可以并行推进时。 | `sp-investigator` 的 primary skill。 |
| `superpowers-requesting-code-review` | 请求独立 code review，检查需求符合性、风险和测试缺口。 | 任务完成、重要功能完成或合并前需要审查时。 | `sp-acceptance-reviewer` 和 `sp-code-reviewer` 的 primary skill；具体审查重点由 agent prompt 区分。 |
| `superpowers-verification-before-completion` | 在声明完成、提交或创建 PR 前重新运行验证命令并确认输出。 | 准备说 done、fixed 或 passing 之前。 | `sp-verifier` 的 primary skill。 |
| `superpowers-finishing-a-development-branch` | 在实现和验证都完成后，引导 merge、PR、清理或交付选择。 | workflow 到收尾阶段，需要整理最终交付动作时。 | `sp-finisher` 的 primary skill。 |

## Runtime Assignment

| Agent | Primary skill |
|---|---|
| `sp-designer` | `superpowers-brainstorming` |
| `sp-planner` | `superpowers-writing-plans` |
| `sp-debugger` | `superpowers-systematic-debugging` |
| `sp-investigator` | `superpowers-dispatching-parallel-agents` |
| `sp-implementer` | `superpowers-test-driven-development` |
| `sp-acceptance-reviewer` | `superpowers-requesting-code-review` |
| `sp-code-reviewer` | `superpowers-requesting-code-review` |
| `sp-verifier` | `superpowers-verification-before-completion` |
| `sp-finisher` | `superpowers-finishing-a-development-branch` |

## Boundaries

- `superpowers-agent` 没有 primary skill，也禁用 `tools.skill`。
- 每个节点 agent 只允许加载 router 分配的 primary skill。
- support skills 不随插件默认安装；如果后续要变成一等节点，需要先更新 `src/router/modes.ts`、agent prompt、transition 和测试。
- `docs/superpowers/official-skills/` 保存的是官方来源归档，其中包含 support skills、`writing-skills` 和各类辅助文件；它只作为文档资料，不改变 `assets/skills/` 或默认安装集合。

## Notes

- 新增、删除或重命名 skill 时，同步检查 `assets/skills/`、`src/router/modes.ts`、README 和本文件。
- 修改某个 skill 的触发场景时，优先以该 `SKILL.md` frontmatter 的 `description` 为准，再同步本目录文档。
- 如果要刷新官方归档，先从当前安装的 Superpowers 插件缓存复制完整 `skills/` 树，再检查 skill 数量和 `assets/skills/` 差异。
