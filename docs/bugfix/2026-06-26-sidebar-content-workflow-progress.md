# Bug Fix: Sidebar Content Workflow Progress

## 问题描述

- 日期: 2026-06-26
- 严重程度: Medium
- 影响范围: Superpowers TUI workflow 运行信息展示

当前 workflow 的会话运行信息应该展示在 `sidebar_content`，而不是 prompt/right 区域。上一轮把主会话展示修到了 `session_prompt_right`，仍然会把运行信息放在输入区附近，不符合当前 UI 分工。

## 根因分析

- 问题位置:
  - `src/tui.ts`
  - `test/tui-plugin.test.ts`
- 原因:
  - 把“主会话区域”理解为 prompt-adjacent slot。
  - 没有把 `sidebar_content` 定义成 workflow session runtime info 的唯一主承载。

## 修复方案

- 从 resident progress slot 名单中移除 `session_prompt_right`。
- 保留 `sidebar_content` 作为 workflow 总览、运行中 child session 和 pending question 的展示区域。
- 保留 `app_bottom` / `sidebar_footer` 的整体状态摘要。
- 更新测试，断言 `session_prompt_right`、`home_prompt`、`home_prompt_right` 都不注册。

## 验证步骤

1. 运行 TUI targeted tests。
2. 运行完整测试。
3. 运行 build。
4. 部署 isolated superagent runtime。

## 相关测试

- `test/tui-plugin.test.ts`

## 设计建议

Prompt-adjacent slot 不适合承载 workflow 运行信息。后续新增进度展示时，默认优先放在 `sidebar_content`，只把极简状态摘要放到 bottom/footer。
