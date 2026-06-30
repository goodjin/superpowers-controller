# Superpowers Controller Naming

## 背景

项目最初围绕 OpenCode adapter 落地，文档和包名使用过 `opencode-superpowers-controller`、`Superpowers Controller for OpenCode` 等表述。这些名字能说明第一版实现位置，但会把产品边界限制在 OpenCode 上。

项目目标不是只做一个 OpenCode 插件。它要在 Superpowers methodology 之上提供控制层：状态、路由、gate、session control、agent dispatch 和结果记录。后续如果适配 Claude Code、Codex、Cursor、Factory Droid 或其他 coding-agent harness，核心定位不应该变化。

## 决策

长期展示名定为 `Superpowers Controller`。

文档第一屏不再强调 `for OpenCode`。OpenCode 只作为当前首个 adapter 和验证环境出现。

2026-06-30 起，npm 包名和 CLI 命令统一为 `superpowers-controller`。不采用 `superpowers-agent`，因为当前项目不是单个 agent，而是负责状态、路由、门禁、会话编排、agent 注入和结果记录的控制层。

## 边界

- 这是基于 Superpowers methodology 的非官方项目。
- 它是独立项目，不隶属于上游 `obra/superpowers` plugin。
- 它不使用 “official” 或类似措辞暗示上游背书。
- 可以说明 “builds on / inspired by the Superpowers methodology”，但要同时说明 “not affiliated with the upstream Superpowers project”。

## 文档规范

- 产品名写 `Superpowers Controller`。
- 当前实现环境写 `OpenCode adapter`，不要写成产品名的一部分。
- 需要描述 npm/bin 现状时，写 `superpowers-controller`。
- 需要描述 GitHub 仓库地址时，使用当前仓库 `goodjin/superpowers-controller`。
