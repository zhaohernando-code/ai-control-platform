# Reviewer Shard Loop Closeout 试运行评估

时间：2026-05-21T22:21:42+08:00

## 目标

验证中台可以把 reviewer scope split 后的 pending shards 自动跑到 aggregate，并把输出 workflow state 交给 autonomous closeout loop，形成可重放的下一轮 continuation 输入。

## 输入

- workflow state：`docs/examples/current-session-workbench-input.json`
- reviewer shard runner：`npm run run:reviewer-shard -- --all --mock-status pass --run-artifact-output ...`
- closeout runner：`npm run run:autonomous-closeout-loop -- --input ... --output ...`
- 外部模型：未调用真实 DS；本轮用 mock executor 验证流程确定性。

## 结果

Reviewer shard loop：

- `status=pass`
- `phase=aggregated`
- completed shard：2
- pending shard：0
- aggregate status：`pass`
- `reviewer-shard-loop-run.v1` validation：`pass`

Autonomous closeout loop：

- 第一次使用 `/tmp` 作为 history/snapshot 输出目录，closeout 正确失败闭合：
  - `closeout history path must stay under the platform repo root`
  - `closeout snapshots root must stay under the platform repo root`
- 第二次改用仓库内 `tmp/`，closeout 成功：
  - `status=pass`
  - `phase=next_continuation`
  - `autonomous-closeout-loop-run.v1` validation：`pass`

## 结论

当前流程已经能完成：

1. 从 split plan 自动执行 pending reviewer shards。
2. 写入 shard results 与 aggregate。
3. 生成可重放 reviewer shard loop artifact。
4. 用 aggregate-aware continuation 覆盖旧 evaluation。
5. 通过 closeout loop 发布 evidence-bearing workflow state 并进入下一轮 continuation。

## 流程约束

- closeout 发布路径必须位于平台仓库内；临时演练也不能使用 `/tmp` 作为 history/snapshot 根目录。
- reviewer shard loop artifact 只能证明 shard 执行路径；是否可进入下一轮仍必须经过 closeout loop 和 artifact validation。
- mock executor 只用于 deterministic gate；真实 DS 仍需要分片、小 prompt、no-tools 优先和 provider health recovery 保护。
