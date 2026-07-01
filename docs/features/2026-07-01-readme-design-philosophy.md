# README Design Philosophy Refresh

## Goal

优化 `README.md` 和 `README.en.md` 的产品介绍结构，让读者先理解 Superpowers Controller 是什么、如何使用，再理解它为什么要用插件状态机承载长程工作流。

## Scope

- 简化 README 主结构：
  - 项目是什么
  - 怎么使用
  - 设计理念
  - 组成部分
  - 安装、配置、开发验证
- 中文和英文 README 保持相同信息层级。
- 移除对未实现能力的负向强调，把篇幅留给项目定位、使用方式和设计理念。
- 补充设计理念：skills 适合承载方法，但多个 skills 在同一主会话中容易让上下文变长、噪音增多；subagent 可以隔离执行，但长程任务的编排和推进仍会压回主会话；本插件把任务推进、状态持久化、恢复和审计交给程序化 runtime。

## Out of Scope

- 不改运行时代码。
- 不改 agent、skill、tool contract。
- 不调整安装脚本和包名。

## Acceptance

- 中文 README 和英文 README 结构一致。
- 文案避免口号式表达和二元对立模板。
- README 对插件定位、使用方式、设计理念和组成部分讲清楚。
- 文档更新后执行构建验证。
