# Bug Fix: Main Session Progress Visibility

## 问题描述

- 日期: 2026-07-03
- 严重程度: High
- 影响范围: Super-Agent 主会话等待体验、TUI 常驻进度展示、runtime 部署验证

用户反馈：

1. 主会话显示 `Super-Agent · MiniMax-M3 · 42.2s`，超过 30 秒后仍没有子会话或 workflow 进度输出到主会话区域。
2. 主会话界面底部没有当前 workflow 或子会话 running 状态展示。

## 已确认事实

- `src/session/parent-progress-notifier.ts` 当前通过 `session.promptAsync` / `session.prompt` 向 parent session 再提交一条 `super-agent` prompt。
- OpenCode SDK 的 `promptAsync` 是“新消息异步提交”，不是“向当前运行中的 assistant turn 追加可见文本”。当 parent session 当前 turn 仍在 running 时，它不能保证 30 秒时插入一条可见 assistant 消息。
- OpenTUI host slot 类型显示：
  - `app_bottom: {}`，没有 `session_id`。
  - `sidebar_content` / `sidebar_footer` 才有 `session_id`。
- 当前代码给 `app_bottom` 配置了 `requireSession: true`，因此真实 host 调用 `app_bottom` 时没有 session props 会直接返回 `null`。
- 本机配置还存在旧路径：
  - `/Users/jin/.local/share/superpowers-controller-test/home/.config/opencode/opencode.json` 指向 `file:///Users/jin/github/opencode-superpowers/dist/index.js`
  - 对应 `tui.json` 指向 `file:///Users/jin/github/opencode-superpowers/dist/tui.js`
  - 全局 `/Users/jin/.config/opencode/opencode.json` 使用 npm 包名 `superpowers-controller`

## 根因分析

### 1. 底部状态不显示

问题位置：

- `src/tui.ts`
- `test/tui-plugin.test.ts`

原因：

`app_bottom` 被当成 session-specific slot 处理，要求 host 传入 `session_id`。但 OpenTUI 的 `app_bottom` slot shape 是 `{}`，不会提供 session id。当前测试也断言了 `slots.app_bottom()` 返回 `null`，所以测试覆盖把真实问题固定住了。

### 2. 主会话区域 30 秒输出不可靠

问题位置：

- `src/session/parent-progress-notifier.ts`
- `src/session/adapter.ts`

原因：

父会话周期更新当前依赖 `session.promptAsync` 给同一个 parent session 新增一条模型消息。这个 API 适合调度新 turn，不适合在 parent session 正在运行时向当前 assistant 输出区域追加文本。因此当主会话仍显示 `Super-Agent · MiniMax-M3 · 42.2s` 时，用户看不到即时进度是符合这个 API 边界的。

### 3. 当前运行时可能没有加载最新代码

问题位置：

- runtime config / deploy flow

原因：

本地 repo 已有改动不代表当前正在打开的 Super-Agent runtime 已加载。现有进程和配置显示仍可能使用旧 repo dist 或 npm 已发布版本。需要把构建、配置指向、runtime restart 明确纳入验证。

## 修复方案

1. 修复 `app_bottom` 常驻状态。
   - 移除 `app_bottom` 的 `requireSession`。
   - 让 `app_bottom` 作为全局 workflow health surface：有 active/unfinished workflow 就展示 `SP: workflow status ...`。
   - 保持 `sidebar_content` 为详细运行信息区域。

2. 调整父会话周期进度策略。
   - 保留 parent prompt notifier 作为 parent session 空闲后的补充。
   - 不再把它作为“忙碌 turn 中 30 秒可见输出”的唯一通道。
   - 每 30 秒的即时可见要求由 `app_bottom` / `sidebar_content` resident slot 承担。
   - 如果需要主会话消息流里出现文本，只能在 parent turn 空闲后由 promptAsync 排队显示；不能承诺 running turn 中插入。

3. 增加测试。
   - `app_bottom` 无 props 时也能显示 active workflow。
   - `app_bottom` refresh 后能显示新的 child progress。
   - parent notifier 文档/测试明确它调度的是 parent prompt，不是 running turn 插入。

4. 部署验证。
   - `bun run build`
   - `bun run test`
   - `npm pack --dry-run`
   - 更新或验证实际 runtime 指向 `/Users/jin/github/superpowers-controller/dist/index.js` 和 `dist/tui.js`。
   - restart 目标 Super-Agent runtime，确认日志和配置加载的是本 repo 构建。

## 验收标准

- 主会话底部 `app_bottom` 在没有 `session_id` props 时也展示当前 active workflow 或 running child session 状态。
- `sidebar_content` 继续展示 workflow 总览、running child session 列表和最新 progress detail。
- 子会话运行超过 30 秒时，用户至少能在底部看到持续刷新的 workflow/child 状态，不再空白等待。
- 文档不再暗示 `session.promptAsync` 能在 parent running turn 内插入即时 assistant 文本。
- 实际 runtime 配置和日志能证明加载的是本 repo 的最新构建，而不是旧 `/Users/jin/github/opencode-superpowers/dist` 或未更新 npm 包。

## 计划验证命令

```bash
bun test test/tui-plugin.test.ts test/parent-progress-notifier.test.ts
bun run test
bun run build
npm pack --dry-run
```

## 实际修复

- `src/tui.ts`
  - `app_bottom` 移除 `requireSession`，改为无 session props 也按 latest unfinished workflow 渲染状态。
- `test/tui-plugin.test.ts`
  - 覆盖 `app_bottom` no-props 渲染 active workflow。
  - 覆盖 `app_bottom` 定时刷新并读取最新 `progress.jsonl`。
- `test/deploy-superagent-runtime.test.ts`
  - 增加 `start` 返回后服务仍监听的回归测试，避免部署脚本假阳性。
- `docs/modules/progress.md`
  - 更新 `app_bottom` 的真实 host slot 语义。
- `docs/modules/session-orchestrator.md`
  - 明确 parent prompt notifier 不是 running assistant turn 的文本插入 API。
- `docs/modules/testing.md`
  - 更新 TUI 测试覆盖说明。

## 实际验证结果

- ✅ `bun test test/tui-plugin.test.ts`
- ✅ `bun test test/tui-plugin.test.ts test/parent-progress-notifier.test.ts test/deploy-superagent-runtime.test.ts`
- ✅ `bun run test`
- ✅ `bun run build`
- ✅ `npm pack --dry-run`
- ✅ `bash scripts/deploy-superagent-runtime.sh start`
- ✅ `bash scripts/deploy-superagent-runtime.sh status`
- ✅ `curl -fsS --max-time 3 http://127.0.0.1:5096/`
- ✅ 5096 runtime 启动后 30 秒仍保持 `Superagent running`

部署验证确认：

- isolated server plugin: `file:///Users/jin/github/superpowers-controller/dist/index.js`
- isolated TUI plugin: `file:///Users/jin/github/superpowers-controller/dist/tui.js`
- 5096 端口监听并返回 OpenCode HTML；30 秒观察窗口内未退出。
