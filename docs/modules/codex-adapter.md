# Codex Adapter Module

## Responsibility

为 Codex 提供 Superpowers **弱增强**适配：只安装可选用的 Agent 定义，由用户自行选择主控或节点角色。编排规则与落盘约定写在 Agent `developer_instructions` 中，不使用 hooks、MCP 或程序控会话。

## Files

- `adapters/codex/agents/*.toml`：Codex agent 角色定义
- `adapters/codex/scripts/install.mjs`：拷贝 agent 到 `~/.codex/agents/`，并注册 `config.toml`
- `adapters/codex/scripts/uninstall.mjs`：移除本适配器管理的 agent 与 config 条目
- `adapters/codex/README.md`：安装与使用说明
- `scripts/install-codex.sh`：在线 / 本地一键安装（`curl | bash`）
- `scripts/uninstall-codex.sh`：在线 / 本地一键卸载
- `docs/features/2026-07-17-codex-weak-enhancement-agents.md`：feature 设计

## Online Install

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install-codex.sh | bash
```

行为：

1. 若当前是仓库 checkout 且含 `adapters/codex/`，直接用本地文件
2. 否则从 `codeload.github.com/<repo>/tar.gz/<ref>` 下载并定位 `adapters/codex/`
3. 用 `node`（或 `bun`）执行 `adapters/codex/scripts/install.mjs`

环境变量：`CODEX_HOME`、`SUPERPOWERS_CONTROLLER_REPO`、`SUPERPOWERS_CONTROLLER_REF`。

## Install Behavior

参考 omo-codex：

1. 复制 `adapters/codex/agents/*.toml` → `$CODEX_HOME/agents/`（默认 `~/.codex/agents/`）
2. 在 `$CODEX_HOME/config.toml` 写入：
   - `[features] multi_agent = true`
   - `[agents.<name>] config_file = "./agents/<name>.toml"`
3. **不**覆盖 `default.toml` / 内置 `default` 角色
4. **不**改主会话 `AGENTS.md`，不设默认入口

## Persistence

主控提示词要求在项目下维护：

```text
.superpowers/current.md
.superpowers/runs/<run-id>/{checklist,request,spec,plan,notes,artifacts}/...
```

这是约定落盘，不是 OpenCode Controller 的硬状态机。

## Notes

- 与 OpenCode 强控制面（`sp_*`、session orchestrator）分离，勿混称同等能力。
- 节点 agent 依赖 Codex `spawn_agent`；需 `multi_agent = true`。
- 官方 Superpowers skills 可选安装；本适配器不强制捆绑 skill 包。
