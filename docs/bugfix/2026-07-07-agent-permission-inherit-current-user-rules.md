# Bug Fix: Agent Permission Should Inherit Current User Rules

## 问题描述

- 日期: 2026-07-07
- 严重程度: High
- 影响范围: `super-agent` / `sp-*` agent 权限生成、OpenCode permission prompt、workflow 子会话执行体验

用户在 OpenCode 权限确认里选择 `Always` 后，Superpowers 子会话仍可能继续触发权限确认。现有实现只把 host permission 简化成一个布尔判断：只有全局 `permission: "allow"` 或 `{ "*": "allow" }` 时，插件才生成 workflow allow 权限；如果 host permission 是 granular object，或用户已经给某些 action/resource pattern 授权，插件生成的 agent permission 仍可能保留默认 `ask`/缺省规则。

## 根因分析

- `src/plugin.ts` 通过 `resolveGlobalPermission(hostConfig.permission)` 取得 host permission，然后传给 `createAgentConfig`。
- `src/agents/index.ts` 只用 `isGlobalPermissionAllow()` 判断是否进入全放行分支，没有继承 granular permission object。
- OpenCode 的 `Always` 语义按 permission + pattern 记忆，不等于永久写入全局 `opencode.json`。如果 host config hook 看不到运行期 approved rules，插件不能凭空恢复这些内存态授权；但插件至少应该完整继承 host 当前暴露出来的 permission 规则，而不是只识别 `"allow"`。

## 修复方案

1. 在 `src/config/permissions.ts` 增加 permission 规范化/合并逻辑：
   - 支持 string permission：`"allow"` / `"ask"` / `"deny"`。
   - 支持 object permission：保留 `read`、`edit`、`bash`、`external_directory`、`glob`、`grep`、`list`、`webfetch`、`websearch`、`lsp`、`plan_enter`、`plan_exit` 等 granular 规则。
   - 对 Superpowers 控制面强制覆盖：native `task` 仍 deny；node native `question` 仍 deny；`super-agent` 的 `skill` 仍 deny。
2. 修改 `src/agents/index.ts`：
   - 不再只用 `isGlobalPermissionAllow()` 切换两套权限。
   - 生成 agent permission 时先继承 host 当前 permission 规则，再叠加 controller/node 的安全覆盖。
   - 对没有 host allow 的默认路径，继续保留现有 workflow 边界：controller 不直接 edit，node reviewer/verifier/investigator 保持只读，node bash 继续 allow。
3. 增加测试：
   - host permission 是 granular object，例如 `external_directory: { "/tmp/*": "allow" }`、`edit: { "src/**": "allow", "*": "ask" }` 时，plugin agent 继承这些规则。
   - 控制面覆盖优先级仍生效：`task` 不会因 host allow 被放开，node `question` 不会被放开，`super-agent` `skill` 不会被放开。
   - 现有 `permission: "allow"` 测试保持通过。
4. 更新 `docs/modules/agents.md`：
   - 说明插件继承 host 当前 permission posture，包括 granular rules。
   - 说明 OpenCode 运行期 `Always` 如果没有暴露给 plugin config hook，插件无法持久化它；要跨重启/跨进程稳定生效，应写入 OpenCode config。

## 验证步骤

1. 运行 focused tests：`bun test test/agents.test.ts test/config-permissions.test.ts test/plugin-config.test.ts`
2. 运行完整测试：`bun test`
3. 编译：`bun run build`
4. 打包检查：`npm pack --dry-run`
5. 如通过，按项目规则提交并推送。

## 验收标准

- 已配置或 host 暴露的 granular allow 规则能进入 `super-agent` / `sp-*` agent permission。
- 用户给某个目录或工具配置过 allow 后，插件不会因为自身默认 agent permission 再制造额外 ask。
- native `task`、node native `question`、controller `skill` 的控制面限制不被放开。
- 文档明确区分：OpenCode 运行期内存 approval、OpenCode 配置文件 permission、插件生成的 agent permission。
