# Optional start_config With Workflow Default

## 背景

`sp_start(start_prepared_task)` 强制要求主控手写 `start_config`。执行期本来只按落盘的 `workflow-spec` 调度，但 prepare 往往只记下 `workflow: feature`，不写出完整执行图，于是启动时必须再传一遍配置。

主控协议说明又不够具体（prompt 举例像 `feature = …`，工具 schema 是空 object），容易写成 `kind: "feature"` 或漏传，导致反复失败。

## 目标

1. `start_config` 对 `start_prepared_task` **可选**。
2. 缺省时：用当前 prepared run 的 `state.workflow` 生成 `built_in_workflow` 执行图并落盘。
3. 兼容误写：`kind` 若等于某个内置 workflow id（如 `"feature"`），视为 `built_in_workflow` + 该 `workflow_id`。
4. 非法 `kind` 报错写清合法值；工具描述与主控 prompt 给出最小合法样例，并说明可省略。
5. 显式传入合法 `start_config` 时行为不变（覆盖默认）。

## 非目标

- 不改 resume / resolve_controller_decision 路径。
- 不删 `start_config` 能力（自定义 orchestration、auto_expansion override 仍可用）。
- 不在本次改 prepare 阶段强制写完整执行图。

## 方案

改动点：

- `src/tools/sp-start.ts`：校验不再强制 `start_config`；`buildWorkflowSpecFromStartConfig` 支持缺省与 kind 别名；收紧错误文案；更新 schema describe。
- `src/agents/index.ts`：说明可省略，并给 `{ kind, workflow_id }` 样例。
- `docs/modules/controller.md`：同步主路径说明。
- 测试：缺省从 `state.workflow` 启动；`kind: "feature"` 兼容；仍拒绝缺 confirmation / prepared_task_id。

## 验收

- 仅 `prepared_task_id` + `confirmation` 即可 `start_prepared_task`，并写出对应 `workflow-spec.json`、派发入口节点。
- `kind: "feature"` 成功启动 feature 模板。
- 显式 `built_in_workflow` / `orchestration` 回归通过。
- `bun test` 相关用例 + `bun run build` 通过；本地安装刷新插件。
