# Codex Weak Enhancement (Agents Only)

## Goal

为 Codex 提供 Superpowers 弱增强入口：安装一组可选用的 Agent（主控 + 节点角色），由用户自行选择；编排规则写在 Agent 定义里，并用落盘 checklist / artifacts 辅助恢复。

## Non-Goals

- 不安装 / 不使用 hooks
- 不提供 MCP / `sp_*` 工具
- 不由插件创建或控制会话
- 不覆盖 `~/.codex/agents/default.toml`
- 不自动把 Codex 主会话改成默认主控（无 OpenCode 式 `default_agent`）
- 本轮不改 OpenCode 强控制面

## Design

参考 `references/oh-my-openagent/packages/omo-codex` 的 agent 安装方式：

1. 在仓库 `adapters/codex/agents/` 维护独立 `.toml` agent 文件
2. 安装脚本把它们拷到 `~/.codex/agents/`
3. 在 `~/.codex/config.toml` 注册 `[agents.<name>] config_file = "./agents/<name>.toml"`
4. 启用 `features.multi_agent = true`（派子 agent 需要）
5. 用户在 Codex 里显式选用 / spawn 这些 agent

### Agents

| Agent | 用途 |
|---|---|
| `superpowers-agent` | 主控：澄清、编排、落盘、派节点、收结果 |
| `sp-designer` | 设计 / spec |
| `sp-planner` | 计划 / task graph |
| `sp-debugger` | 根因定位 |
| `sp-investigator` | 只读调查 |
| `sp-implementer` | 实现（倾向 TDD） |
| `sp-acceptance-reviewer` | 验收审查 |
| `sp-code-reviewer` | 代码质量审查 |
| `sp-verifier` | 新鲜验证 |
| `sp-finisher` | 收尾交付 |

### Persistence Convention

项目本地（由主控在提示词中要求维护，非程序状态机）：

```text
.superpowers/
  current.md                 # 指向当前 run-id 与一句话状态
  runs/<run-id>/
    checklist.md             # 步骤勾选
    request.md
    spec.md                  # 如有
    plan.md                  # 如有
    notes.md                 # 恢复摘要
    artifacts/               # 证据与报告
```

## Acceptance

- `adapters/codex/` 可独立安装 / 卸载
- 安装后 `~/.codex/agents/` 出现上述 agent，且不写入 `default.toml`
- `config.toml` 注册这些 agent，且开启 `multi_agent`
- 文档说明：用户需自行选择 `superpowers-agent` 或 spawn 节点角色
- OpenCode 现有插件行为不变

## Delivery

- Feature 文档：本文件
- 模块文档：`docs/modules/codex-adapter.md`
- 代码：`adapters/codex/`
- 在线安装：`scripts/install-codex.sh` / `scripts/uninstall-codex.sh`

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install-codex.sh | bash
```

本地有仓库 checkout 时，脚本优先用本地 `adapters/codex/`；否则从 GitHub 下载该目录再执行 `install.mjs`。
