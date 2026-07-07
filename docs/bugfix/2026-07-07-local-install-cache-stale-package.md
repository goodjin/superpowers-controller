# Bug Fix: Local install reused stale OpenCode plugin cache

## 问题描述

- 日期: 2026-07-07
- 严重程度: Medium
- 影响范围: 本地安装、启动耗时诊断、OpenCode 插件缓存

## 根因分析

- 问题位置: `scripts/install.sh`
- 原因: 本地 checkout 下运行安装脚本时，CLI install 使用当前源码，但 OpenCode cache seed 仍优先读取 `/tmp/bunx-<uid>-superpowers-controller@latest`。如果该 bunx cache 里还是旧 npm 包，OpenCode 会继续加载旧 `dist/index.js`，导致本地新增的 startup timing 代码没有生效。

## 修复方案

- 新增 `seed_opencode_plugin_cache_from_local_checkout`。
- 当脚本从仓库 checkout 运行且 `dist/index.js`、`dist/tui.js` 已存在时，优先把当前 `package.json`、`dist/`、`assets/`、`scripts/install.sh` 写入 OpenCode package cache。
- 只有本地 checkout 不可用时才回退到 bunx cache 或 `opencode plugin ... --force`。

## 验证步骤

1. `bun test test/install.test.ts`
2. `bun run build`
3. 清理旧 cache 和旧 `oh-my-*` 残留。
4. `SUPERPOWERS_CONTROLLER_LOCAL_SKIP_TESTS=1 bun run install:local`
5. 确认 `~/.cache/opencode/packages/node_modules/superpowers-controller/dist/index.js` 包含 `[timing] startup`。
6. `opencode models` 返回模型列表。
7. `opencode agent list` 返回 `super-agent` 和 `sp-*` agents。

## 结果

- 本地安装后 OpenCode cache 不再回写旧 npm 包。
- `failed to fetch models` 在清理并重装后未复现，`opencode models` 正常返回模型列表。
