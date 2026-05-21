# 2026-05-22 Projected Real Partial Shard Continuation

状态：pass
宿主：`ai-control-platform`

## 目标

验证真实 reviewer 单片预算下，projected loop 完成 shard 001 后，下一轮能基于 durable shard result 继续 shard 002，而不是重复执行 shard 001 或停在 inspect/resume 状态。

## 发现

试运行先暴露了流程缺口：

- `/api/workbench/next-action` 的 reviewer shard 响应包含当前 `item.id`，loop driver 误把它当成下一 projection。
- 当最新 driver 是 `autonomous_scheduler_loop_run` 时，projection 默认推荐 inspect/resume，没有结合 pending reviewer shard 状态。

这会让单片真实 reviewer 预算无法自然续跑第二片 shard。

## 修复

- `projected_next_action` 只接受真实 `next_item.id` 作为跨 projection `next_projection_id`。
- `next_action_readout` 在 projected loop `iteration_limit_reached` 且 `reviewer_shard_review.pending_shards > 0` 时，继续推荐 `run_reviewer_scope_shard`。
- 新增回归：`workbench server continues projected real reviewer loop from durable partial shard state`。

## 结果

回归使用 injected real reviewer executor，模拟 bounded real reviewer profile：

- 第一轮执行：`reviewer-scope-shard-001`
- 第一轮后 projection：`next_shard=reviewer-scope-shard-002`，`next_action=run_reviewer_scope_shard`
- 第二轮执行：`reviewer-scope-shard-002`
- Durable state 中 shard result 顺序：001 -> 002
- 最终写入 `reviewer_shard_aggregate`，pending shards 为 0

## 结论

单片预算真实 reviewer loop 可以通过重复 bounded projected loop 自主推进，不需要人工选择 shard，也不会重复调用已完成 shard。
