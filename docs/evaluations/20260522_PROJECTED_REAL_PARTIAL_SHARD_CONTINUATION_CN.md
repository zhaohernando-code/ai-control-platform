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

浏览器门禁增加 `projected_real_partial_shard_readout`：

- PC 工作台渲染 `shard_review_next=reviewer-scope-shard-002`
- 渲染 executor：`browser_test_real_reviewer`
- 渲染 external budget：`1`
- 渲染推荐动作：`run_reviewer_scope_shard`
- 1440px 宽度下无横向溢出

Closeout 证据：

- `tools/check-workbench-browser-events.mjs --output <path>` 写出 `workbench-browser-events-run.v1`
- `tools/check-closeout.mjs` 读取该 artifact，校验 `projected_real_partial_shard_readout`、`next_action_readout=run_reviewer_scope_shard` 和无横向溢出
- 本轮 artifact smoke：`version=workbench-browser-events-run.v1`，`status=pass`，`scenario_count=10`

Projection 证据：

- `workbench_browser_events_run` fact 进入 `workbench_browser_events` projection 摘要
- 摘要包含 `artifact_id`、`scenario_count`、`partial_shard_ready`、`overflow_count`
- PC/mobile 工作台可渲染 UI verification 状态，避免 scheduler/closeout 只能读取 raw artifact

## 结论

单片预算真实 reviewer loop 可以通过重复 bounded projected loop 自主推进，不需要人工选择 shard，也不会重复调用已完成 shard。
