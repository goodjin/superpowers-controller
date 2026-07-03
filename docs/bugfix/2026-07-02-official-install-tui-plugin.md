# Bug Fix: Official install does not enable TUI sidebar surfaces

## 问题描述

- 日期: 2026-07-02
- 严重程度: High
- 影响范围: 官方 OpenCode 安装路径、一键安装脚本、`sidebar_content` workflow 展示

用户通过官方 OpenCode 和发布后的 npm 包安装插件后，`super-agent` 能出现，但右侧 `sidebar_content` 没有任何 workflow 信息。

## 根因分析

- `scripts/install.sh` 调用 `superpowers-controller install`。
- `src/cli/install.ts` 只写入 `opencode.json` / `opencode.jsonc` 的 server plugin entry、`superpowers-controller.jsonc` 和 skills。
- `sidebar_content` 由 `dist/tui.js` 注册，官方 OpenCode 需要 TUI config 加载 TUI plugin entry。
- 当前 installer 不写 `~/.config/opencode/tui.json`，因此 agent/tools 生效，但 TUI slots 不会注册。
- `doctor` 也没有检查 TUI config，导致安装后仍报告成功。

## 修复方案

- installer 同时写入 `tui.json`，添加 `superpowers-controller/tui`。
- 保持 server entry 为 `superpowers-controller`，避免改变 runtime/tool 加载路径。
- 一键 shell 脚本直接兜底写入 TUI entry，避免 raw GitHub 脚本更新后仍被旧 npm CLI 卡住。
- `doctor` 增加 TUI plugin 检查。
- 一键安装脚本输出提示用户重启 OpenCode，并在缓存旧版本时建议用 `opencode plugin superpowers-controller --global --force` 刷新。
- 更新安装测试和部署文档，防止后续回归。
- 包版本先发布到 `0.1.4`；随后发现 `curl | bash` 场景会因为 `BASH_SOURCE[0]` 不存在打印警告，继续升到 `0.1.5` 修复管道执行兼容性。

## 验证步骤

1. ✅ `bun test test/install.test.ts`：9 pass，确认 `tui.jsonc` 写入且幂等，doctor 能发现缺少 TUI entry。
2. ✅ `bun run test`：150 pass，0 fail。
3. ✅ `bun run build`：构建 `dist/index.js`、`dist/tui.js` 和 `dist/cli/index.js` 成功。
4. ✅ `npm pack --dry-run`：生成 `superpowers-controller@0.1.4` dry-run，包内包含 `dist/tui.js`、`dist/cli/index.js` 和 `scripts/install.sh`。
5. ✅ 本地 `bash < scripts/install.sh` 管道模拟：临时 `HOME` 下写入 `opencode.jsonc`、`tui.jsonc`、skills，并刷新 OpenCode 插件缓存，无 `BASH_SOURCE` 警告。

## 相关文件

- `scripts/install.sh`
- `src/cli/install.ts`
- `src/cli/doctor.ts`
- `test/install.test.ts`
- `docs/modules/deployment.md`
