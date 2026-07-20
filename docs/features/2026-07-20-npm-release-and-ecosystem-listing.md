# npm Release and OpenCode Ecosystem Listing

## Goal

把当前未发布改动收成一版 npm release，并提交社区上架，让用户能从官方 Ecosystem 和 awesome-opencode 发现 `superpowers-controller`。

## Scope

1. **Release（本仓库）**
   - 合并当前未提交改动（Codex 弱增强适配、install seed deps、startup recovery CLI skip / TUI heal 等）
   - 版本 bump：`0.1.11` → `0.1.12`
   - 编译与测试通过后提交、推送 `main`
   - 通过 GitHub Actions `publish.yml`（trusted publishing）发布到 npm `latest`

2. **Official Ecosystem PR**
   - 目标仓库：`anomalyco/opencode`，基线分支 `dev`
   - 改动文件：`packages/web/src/content/docs/ecosystem.mdx`
   - 在 Plugins 表增加一行 `superpowers-controller`
   - 按官方 CONTRIBUTING：先开 Issue，再开 PR；标题用 `docs(ecosystem): ...`

3. **awesome-opencode PR**
   - 目标仓库：`awesome-opencode/awesome-opencode`
   - 新增 `data/plugins/superpowers-controller.yaml`

## Non-Goals

- 不把插件源码合入 OpenCode 核心
- 不改 OpenCode 运行时行为
- 不依赖本机 `npm login`（本机已无有效 npm 会话）

## Acceptance

- npm 上存在 `superpowers-controller@0.1.12`
- 已向 `anomalyco/opencode` 提交 Ecosystem 文档 PR（含关联 Issue）
- 已向 `awesome-opencode/awesome-opencode` 提交 plugins YAML PR
- 本仓库 deployment / 相关模块文档已反映发布与上架路径
