# Bugfix: Native parentID Regression Gate (Phase 0)

## 背景

Phase 1 已切换 `interaction.mode=native` 默认行为：`session.create` 传 `parentID`，dispatch/resume 默认留在 parent，permission 不抢 child 焦点。

Phase 0 需在 **OpenCode 1.16.2+** 本地手测，确认当年 `parentID` 相关回归未复现。

## 手测清单

| # | 步骤 | 期望 |
|---|------|------|
| 1 | `bun run install:local` 后重启 OpenCode | 插件加载 `interaction.mode=native`（或项目 `.opencode/superpowers.jsonc` 显式配置） |
| 2 | 主控 `sp_start` 派发 design child | TUI **仍在 parent** route，不自动跳进 child |
| 3 | child 触发 bash/write 等需授权工具 | **parent 底部**出现 Permission UI，可 Allow |
| 4 | 授权后 workflow 继续 | child `sp_report` / progress 正常 |
| 5 | `Ctrl+Down` 进入 child | 可见完整 child transcript + SubagentFooter |
| 6 | `Ctrl+Up` 回 parent | sidebar + `app_bottom` Live Activity 仍渲染 |
| 7 | 并行 implement 多 child | sidebar 列表与 `app_bottom` 行与 `node_runs` 一致 |

## 回退

若 #3 或 #6 失败，在项目 `.opencode/superpowers.jsonc` 写入：

```json
{
  "interaction": {
    "mode": "legacy"
  }
}
```

重启 OpenCode 即恢复无 `parentID` + 自动切 child 的旧行为。

## 实测记录

| 日期 | OpenCode 版本 | 结果 | 备注 |
|------|---------------|------|------|
| _待填_ | _待填_ | _待填_ | |

## 关联

- Feature: `docs/features/2026-07-11-native-subagent-interaction.md`
- Module: `docs/modules/session-orchestrator.md`
- Config: `src/config/interaction.ts`
