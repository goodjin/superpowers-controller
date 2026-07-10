# Feature: Build/Test 质量门禁（Phase 4）

## 背景

分析文档问题 8：节点可通过 `sp_report(passed)` 进入 finish，即使 build/test 从未执行。Phase 4 把质量纪律从 prompt 下沉到 runtime，仍不新增 public tool。

## 目标

- `StartConfig` / `workflow-spec.json` 支持 `required_checks?: ("build"|"test"|"lint")[]`
- verifier/finisher 通过 `sp_report.checks` 提交命令证据
- 配置 `quality_gate: off | guided | strict`（默认 `off`，兼容现有测试）
- 可配置 `quality_commands.build/test/lint`（默认 `bun run build` / `bun test` / `bun run lint`）
- strict 模式下 finish `sp_report(status=passed)` 缺证据时被拒绝

## 实现要点

| 模块 | 变更 |
|------|------|
| `src/runtime/quality-checks.ts` | 解析 checks、合并 state、finish 门禁评估 |
| `src/state/types.ts` | `QualityCheckRecord`、`WorkflowState.quality_checks` |
| `src/config/schema.ts` | `quality_gate`、`quality_commands` |
| `src/state/store.ts` | `recordNodeResult` 合并 quality_checks |
| `src/tools/sp-start.ts` | `required_checks` / `quality_commands` 写入 orchestration |
| `src/tools/report-handler.ts` | finish 前 provisional 校验（含同条 report checks） |
| `src/session/templates.ts` | verification/finish packet 提示 checks 格式 |

## checks 格式

行格式（推荐）：

```text
build: passed (bun run build)
test: passed (bun test)
```

或 JSON：

```json
{"build":{"status":"passed","command":"bun run build"}}
```

## 验收

- [x] strict + `required_checks: ["build"]` 时无 checks 的 finish 被拒
- [x] 同条 finish report 带 checks 可通过 strict
- [x] `sp_start` 持久化 `required_checks` 到 workflow-spec
- [x] verification/finish task prompt 含 Quality Check Evidence
- [x] 单元/集成测试覆盖 parse 与 gate 行为

## 非目标

- 不在 `transition.ts` 重复校验（enforcement 在 finish `sp_report`）
- 不自动执行 build/test（仍由 node session 跑命令后汇报）
