# Feature: Liveness Timeout 5 Minutes

## 日期

2026-07-22

## 目标

将子节点无进度超时从 60 秒调整为 5 分钟，避免写大文件、长工具调用被误杀。

## 变更

- 默认 `liveness.timeout_ms`: `60_000` → `300_000`
- 涉及：`src/runtime/liveness.ts`、`src/config/defaults.ts`、`src/config/schema.ts`

## 验收

- 默认配置为 5 分钟
- 现有 liveness 单测仍通过（使用 `DEFAULT_LIVENESS_TIMEOUT_MS`）
