# 2026-05-22 真实 DS Projected Loop Smoke

状态：pass
宿主：`ai-control-platform`

## 目标

验证 `approved_bounded_real_reviewer` 在真实 Claude/DeepSeek executor 下，是否能通过工作台 HTTP loop 路径执行单个 reviewer shard，同时保持预算、健康预检和 projection 读数可审计。

## 前置门禁

- DS wrapper smoke：`DS_SMOKE_OK`
- Provider health：latest fact 为 `healthy`
- Projection next action：`run_reviewer_scope_shard`
- Shard：`reviewer-scope-shard-001`
- Profile：`approved_bounded_real_reviewer`
- Strategy：`projected_next_action`
- External reviewer budget：`1`
- Timeout：`90s`
- 运行方式：临时 snapshot + 本地 workbench server，未写入主 fixture

## 结果

- HTTP status：`201`
- Loop status：`created`
- Loop phase：`iteration_limit_reached`
- Scheduler loop profile：`approved_bounded_real_reviewer`
- Scheduler loop strategy：`projected_next_action`
- Reviewer executor：`claude_deepseek`
- Provider：`deepseek`
- Model：`deepseek-v4-pro`
- External call budget used：`1`
- Shard completed：`1`
- Pending shards：`1`

## 发现

真实运行暴露了一个 projection 读数问题：完成 shard 001 后，`reviewer_shard_review.next_shard` 仍显示 001。原因是 projection 在 partial shard result 下仍使用 split plan 的原始 `next_shard`，没有扣除已完成 shard。

修复：
- `reviewer_scope_split` projection 保留 `shard_ids`。
- `reviewer_shard_review.next_shard` 从 `shard_ids - completedIds` 派生。
- 增加回归：`workbench projection advances next reviewer shard after partial result`。

## 结论

真实 DS 单片 projected loop 可以在 bounded gates 下运行。后续真实执行可以继续使用同一 profile，但必须继续保持单片预算、provider health preflight、projection next-action drift check 和 closeout 门禁。
