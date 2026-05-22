# 2026-05-22 Agent Lifecycle Pool 复盘

## 目标

把本次会话暴露的问题固化为平台流程：主进程 spawn 子进程后，不能只依赖聊天上下文记住是否已经验收和关闭；子进程生命周期必须进入 durable workflow facts，并在继续下一轮前由 continuation/workbench 看见。

## 本轮已落地

- 新增 `agent-lifecycle-pool` 汇总层，可从 manifest events 和 artifact ledger 汇总最新 pool。
- PC/mobile workbench projection 暴露 `agent_lifecycle_pool`。
- operations timeline 能展示 agent lifecycle pool 事件。
- `next_action_readout` 在存在 open/unevaluated/unclosed pool 时优先给出 `cleanup_agent_lifecycle_pool`。
- autonomous continuation 会把未清理 pool 转成 `cleanup_agent_lifecycle_pool` work package，而不是停在人工介入。
- process-hardening 新增 `agent-lifecycle-pool-cleanup-gap`，并要求该规则可执行、可测试。

## 验收结论

本轮是合格的基座层，不是完整执行闭环。

已满足：

- 子进程生命周期不再只能存在于聊天上下文。
- 已有 durable facts 时，平台能判断 open、unevaluated、unclosed、blocked 和 pass。
- 未清理 pool 会抢占下一步 continuation，防止主进程继续派发下一轮。
- 工作台 PC/mobile 能显示该状态。

仍需下一轮补齐：

- 可复用的 lifecycle fact recorder，避免手写 manifest event。
- `cleanup_agent_lifecycle_pool` 的 runner/CLI/API，让调度器能记录 WorkerEvaluation、WorkerClosed、PoolIterationClosed。
- 失败或无法关闭时的 durable blocker/retry 策略。
- browser closeout 对 PC/mobile lifecycle readout 的验证。

## 流程教训

这次不能只把 `close_agent` 当成主进程习惯；它必须成为中台自身的状态模型。后续每次主进程或 scheduler 启动子进程，都应先写 `WorkerSpawned`，完成后写 `WorkerCompleted` 和 `WorkerEvaluation`，关闭后写 `WorkerClosed`，整个 iteration 收口后写 `PoolIterationClosed`。
