# 2026-05-22 Agent Lifecycle Recorder 复盘

## 目标

上一层已经能在 projection/continuation 中读出 `agent_lifecycle_pool`，但仍缺少可复用写入路径。本轮目标是让 `cleanup_agent_lifecycle_pool` 能通过 CLI/API/next-action 写 durable facts，而不是停留在提醒。

## 已落地

- `createAgentLifecycleFact`
- `recordAgentLifecycleFact`
- `cleanupAgentLifecyclePool`
- `npm run record:agent-lifecycle-pool`
- `POST /api/workbench/agent-lifecycle-pool`
- `projectionSource.recordAgentLifecyclePool`
- projected next-action 支持 `cleanup_agent_lifecycle_pool`

写入路径会同时更新：

- Run Manifest event
- Manifest artifact
- Artifact Ledger artifact

## 关键验收

- completed 但未 evaluated/closed 的 worker 会写入 `WorkerEvaluation`、`WorkerClosed`、`PoolIterationClosed`。
- 只有 `WorkerSpawned` 的 open worker 不会留下 cleanup 循环；cleanup 会写入 `WorkerCompleted`、`WorkerEvaluation`、`WorkerClosed`、`PoolIterationClosed`，最终 pool 为 `pass`。
- cleanup failure 会写 durable blocker fact，并保持 projection blocked/cleanup_required。
- workbench 写接口拒绝 projection-only history item，必须有 workflow-state `input_path`。
- projected next-action 可以执行 `cleanup_agent_lifecycle_pool`。

## 流程教训

本轮 DS no-tools 复审曾 hallucinate 不存在的实现符号；主进程没有采纳该结论，而是重跑带 `Read` 的小范围复审。后者基于真实文件确认本轮改动通过。

后续流程约束：

- 代码级复审必须有文件证据；no-tools 只适合作流程原则评估。
- 如果 no-tools 复审提到不存在的函数或字段，应标记为不可采纳，并用 bounded Read 复审重跑。
- 主进程验收必须主动构造失败形态。本轮就是通过只有 `WorkerSpawned` 的 open worker 发现并修复了 cleanup 循环风险。

## 下一步

把 lifecycle cleanup 写入 scheduler/autonomous loop 和 browser closeout evidence path，证明无人值守时 projected `cleanup_agent_lifecycle_pool` 会被自动执行，并在 PC/mobile served workbench 中可见。
