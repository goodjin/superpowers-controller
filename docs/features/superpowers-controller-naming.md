# Superpowers Controller Naming

## 背景

项目最初围绕 OpenCode adapter 落地，文档和包名使用过 `opencode-superpowers-controller`、`Superpowers Controller for OpenCode` 等表述。这些名字能说明第一版实现位置，但会把产品边界限制在 OpenCode 上。

项目目标不是只做一个 OpenCode 插件。它要在 Superpowers methodology 之上提供控制层：状态、路由、gate、session control、agent dispatch 和结果记录。后续如果适配 Claude Code、Codex、Cursor、Factory Droid 或其他 coding-agent harness，核心定位不应该变化。

## 决策

长期展示名定为 `Superpowers Controller`。

文档第一屏不再强调 `for OpenCode`。OpenCode 只作为当前首个 adapter 和验证环境出现。

当前开发包和命令仍保留 `opencode-superpowers-controller`，因为源码、测试和安装脚本还没有同步改名。后续如果正式改包名，目标名为 `superpowers-controller`。

## 边界

- 这是基于 Superpowers methodology 的非官方项目。
- 它是独立项目，不隶属于上游 `obra/superpowers` plugin。
- 它不使用 “official” 或类似措辞暗示上游背书。
- 可以说明 “builds on / inspired by the Superpowers methodology”，但要同时说明 “not affiliated with the upstream Superpowers project”。

## 文档规范

- 产品名写 `Superpowers Controller`。
- 当前实现环境写 `OpenCode adapter`，不要写成产品名的一部分。
- 需要描述 npm/bin 现状时，可以写 `opencode-superpowers-controller` 是当前开发包名。
- 需要描述未来包名时，可以写目标为 `superpowers-controller`，但不要把未完成的包名迁移写成已经可用的安装命令。
