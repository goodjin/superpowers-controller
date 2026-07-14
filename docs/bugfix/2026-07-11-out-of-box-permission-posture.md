# Bugfix: Out-of-Box Permission Posture

## 问题

用户安装插件后仍可能遇到权限确认死循环，尤其是：

- 主控 `superpowers-agent` 自己跑 bash（默认 `bash: ask`）
- 每条新命令都要确认，「总是允许」只记住当前 pattern
- 子节点若继承 host 的 granular `bash: ask`，也会出现连环确认

用户不应为了正常使用 Superpowers 去手改 `opencode.json`。

## 方案

### 1. 主控禁止 shell

- `superpowers-agent` 默认 `bash: deny`
- `tool.execute.before` 对主控 bash 直接 `blocked`
- 主控应通过 `sp_start` 派子会话执行，而不是自己跑 `codesign` / `open` / `pgrep`

### 2. 子节点强制放行 bash

- `sp-*` 在 merge overrides 中固定 `bash: allow`
- 即使 host 配了 granular `bash: ask`，子会话执行 workflow 时也不连环弹窗
- 控制面限制不变：`task` / child `question` 仍 deny

### 3. 安装时补 host 默认 permission

- `install` / `mergePluginEntry` 仅在用户**尚未配置** `permission` 时写入 `"permission": "allow"`
- 已有自定义 permission 的用户不受影响
- 插件仍通过 agent permission + gate 保留控制面边界

## 验收

- 新安装：无需手改配置即可跑 workflow 子会话 bash
- 主控调 bash：被 permission + gate 双层拒绝，并提示用 `sp_start` 派发
- host 已有 `permission.bash: ask`：子节点 bash 仍为 allow
- host 已有完整 `permission` 对象：安装不覆盖
