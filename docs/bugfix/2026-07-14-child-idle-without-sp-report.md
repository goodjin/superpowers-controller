# Bug Fix: 子会话 idle 未 sp_report 导致主控停住

## 问题描述

- 日期: 2026-07-14
- 严重程度: High
- 影响范围: child session 结束但未调用 `sp_report` 的 workflow

## 根因分析

- 问题位置: `src/plugin.ts` liveness / session 事件处理
- 原因: designer 在写出候选设计文本后直接 idle，没有 `sp_report`；liveness 把节点标成 `interrupted` 并进入 `waiting_controller_decision`，但只弹 toast，没有 `notifyParent`
- 代码流程: child idle → 无 report → liveness timeout → state 更新 → 主控无 prompt

## 修复方案

- 新增 `session.idle` / liveness / `session.error` 共用的 unreported-exit 路径
- 采集最后助手文字 + 产出文件路径，写入 `silent-exit.md/json`
- `notifyParent` 把证据和允许的 controller decision 交给主控
- 不自动 `passed`

## 验证步骤

1. `bun test ./test/silent-exit.test.ts ./test/liveness.test.ts`
2. 复现：子会话无 `sp_report` 结束 → 主控收到 silent-exit 决策提示
