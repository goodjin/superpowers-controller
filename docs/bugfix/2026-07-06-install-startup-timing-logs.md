# Bug Fix: Install and Startup Timing Logs

## 问题描述

- 日期: 2026-07-06
- 严重程度: Medium
- 影响范围: 本地安装、插件缓存刷新、启动卡顿排查

## 根因分析

- 问题位置: `scripts/install.sh`, `scripts/local-install-verify.sh`
- 原因: 当前安装链路只输出阶段名称，不记录阶段耗时。用户看到 OpenCode 启动或安装卡顿时，无法区分耗时来自构建、配置写入、旧依赖清理、OpenCode 插件缓存刷新、cache seed 还是 doctor。

## 修复方案

- 在 `scripts/install.sh` 增加统一 timing helper，输出 `[timing] <step>: <ms>ms`。
- 对安装主流程拆分计时: CLI install、TUI config、旧依赖清理、OpenCode cache refresh、doctor、total。
- 对 cache refresh 内部拆分计时: cache cleanup、bunx cache seed、OpenCode plugin refresh fallback。
- 在 `scripts/local-install-verify.sh` 增加本地 wrapper 分段计时: tests、build、install、total。
- 在 `src/plugin.ts` 增加 OpenCode 插件启动期 app log 计时: config load、store init、startup recovery、runtime wiring、total。

## 验证步骤

1. Run focused install tests.
2. Run local install verify script.
3. Confirm timing lines are printed for each major step.

## 相关测试

- `bun test test/install.test.ts test/plugin-config.test.ts`
- `SUPERPOWERS_CONTROLLER_LOCAL_SKIP_TESTS=1 bun run install:local`
