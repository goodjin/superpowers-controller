# Bug Fix: Main Session Progress Slot

## 问题描述

- 日期: 2026-06-25
- 严重程度: Medium
- 影响范围: Superpowers TUI 主会话进度展示

上一轮为了让主会话区域显示进度，误把进度注册到了 `home_prompt` 和 `home_prompt_right`。这两个 slot 属于首页区域，不是主会话运行态区域。随后又确认 workflow 会话运行信息不应放到 prompt/right 区域，应该集中展示在 `sidebar_content`。

## 根因分析

- 问题位置: `src/tui.ts`
- 原因:
  - 把“主会话区域”误判成 `home_*` slot。
  - 测试断言也跟着验证了错误 slot，缺少 `sidebar_content` 作为主承载、prompt/right 不注册的约束。

## 修复方案

- 从 resident progress slot 名单中移除 `home_prompt`、`home_prompt_right` 和 `session_prompt_right`。
- 保留 `sidebar_content` 作为 workflow 会话运行信息的主展示区域。
- 更新 TUI 测试，断言 `sidebar_content` 存在，`session_prompt_right`、`home_prompt` 和 `home_prompt_right` 不存在。
- 更新 feature、module 和 bugfix 文档，明确 `home_*` 是首页区域，不用于主会话运行态展示。

## 验证步骤

1. 运行 targeted TUI 测试。
2. 运行完整测试。
3. 运行 build。
4. 部署 isolated superagent runtime。

## 相关测试

- `test/tui-plugin.test.ts`

## 设计建议

TUI slot 的命名容易误导。后续新增常驻 surface 时，应先按 host 语义区分首页、主会话、输入区、sidebar 和 app bottom，再决定注册位置。
