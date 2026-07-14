# Feature: 侧栏扫读排版收敛

## 背景

有 workflow 时 sidebar 把摘要、child 行、foreground transcript、Sessions 列表叠在一起，同一状态重复多遍，thinking/msg id 占空间过大。

## 目标

有 workflow 时侧栏改为短结构：

```text
SP verify-finish · verification
● [⌘1] sp-verifier  running
  last Bash flutter build… (1s)

Sessions
● sp-verifier child: last Bash …
  superpowers-agent: idle
```

## 取舍

1. 顶栏只保留 workflow 名 + 阶段（不再塞 nodes/children/latest 长摘要）
2. child 行：状态一行 + 活动一行；去掉 node id、完整 session id、冗余 `attention running`
3. 去掉 `foreground child` / `recent` transcript 整段（活动改由 Sessions 行与 child 活动行承担）
4. 有 child 列表时不再单独展示 `selectors` / `sessions total` 计数行
5. 不展示 absolute path / `sidebar-debug.log` 类 detail

## 非目标

- 不恢复 `app_bottom`
- 不改 host Sessions 列表本身的排序逻辑

## 验收

- 单测覆盖 compact 侧栏文本
- 不再出现 `foreground child` / `selectors:`（有 child 时）
- `install:local` 后重启可看到收敛排版
