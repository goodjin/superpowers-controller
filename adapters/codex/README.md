# Superpowers Codex Adapter（弱增强）

只安装 Agent，由你在 Codex 里选用。不做 hooks、不做 MCP、不控会话、不覆盖内置 `default`。

## 安装

一行命令（在线）：

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/install-codex.sh | bash
```

卸载：

```bash
curl -fsSL https://raw.githubusercontent.com/goodjin/superpowers-controller/main/scripts/uninstall-codex.sh | bash
```

本地仓库：

```bash
bash scripts/install-codex.sh
# 或
node adapters/codex/scripts/install.mjs
# 或
bun run install:codex
```

可选环境变量：

- `CODEX_HOME`：Codex 配置根目录（默认 `~/.codex`）
- `SUPERPOWERS_CONTROLLER_REPO`：GitHub 仓库（默认 `goodjin/superpowers-controller`）
- `SUPERPOWERS_CONTROLLER_REF`：分支或 tag（默认 `main`）

在线安装会从 GitHub 下载 `adapters/codex/`；本地有 checkout 时优先用本地文件。

安装后会：

- 把 `adapters/codex/agents/*.toml` 拷到 `$CODEX_HOME/agents/`
- 在 `$CODEX_HOME/config.toml` 注册这些 agent
- 打开 `features.multi_agent = true`

## 卸载

```bash
bash scripts/uninstall-codex.sh
# 或
node adapters/codex/scripts/uninstall.mjs
# 或
bun run uninstall:codex
```

## 怎么用

1. 启动 Codex
2. 显式选用或 spawn `superpowers-agent` 作为主控  
   （不会自动变成默认入口）
3. 主控按提示词编排，并用 `spawn_agent` 派 `sp-implementer` 等节点角色
4. 进度与产物落在项目 `.superpowers/` 下，便于中断后继续

## Agent 列表

| 名称 | 角色 |
|---|---|
| `superpowers-agent` | 主控编排 |
| `sp-designer` | 设计 / spec |
| `sp-planner` | 计划 |
| `sp-debugger` | 调试根因 |
| `sp-investigator` | 只读调查 |
| `sp-implementer` | 实现 |
| `sp-acceptance-reviewer` | 验收 |
| `sp-code-reviewer` | 代码审查 |
| `sp-verifier` | 验证 |
| `sp-finisher` | 收尾 |

## 和 OpenCode 版的区别

| | OpenCode Controller | 本适配器 |
|---|---|---|
| 会话 | 插件可创建/调度 | 用户 + Codex 原生 spawn |
| 状态 | `sp_*` + state.json | checklist / artifacts 约定落盘 |
| 默认入口 | 可设 `default_agent` | 用户自选 |
