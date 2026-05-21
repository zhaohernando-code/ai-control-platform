# Autonomous Continuation 合同

状态：draft
宿主：`ai-control-platform`

## 1. 目标

Autonomous Continuation 解决“每轮完成后停在总结，等待用户继续”的问题。对中台来说，完成一轮测试、提交或 projection 生成不等于任务结束；只要项目状态里仍有 `next_step`、`next_work_packages`，且没有真实人工阻塞，系统必须自动生成下一轮执行指令。

## 2. 输入

`decideContinuation` 的输入可以来自：

- `project_status`：项目、blockers、next_step。
- `run_evaluation`：`pass`、`rerun`、`rollback`、`human_intervention` 及 next work packages。
- `blockers`：凭据、破坏性动作、需求冲突、恢复失败耗尽等。
- `owned_files` / `acceptance_gates` / `rollback_conditions`：用于生成下一轮 Context Pack seed。

## 3. 决策

| 条件 | action | should_continue |
| --- | --- | --- |
| `next_step` 存在且无 blocker | `continue` | true |
| `run_evaluation.status=rerun` | `rerun` | true |
| `run_evaluation.status=rollback` | `rollback` | true |
| reviewer timeout 等可恢复失败 | `rerun` | true |
| 凭据缺失、破坏性动作、需求冲突、恢复失败耗尽 | `stop_for_human` | false |
| continuation 指向错误宿主 | `stop_for_human` | false |

核心规则：**总结、提交、推送、测试通过都不是停止条件**。只有自动系统缺少安全前提时才停止。

## 4. 输出

`decideContinuation` 输出：

- `action`
- `should_continue`
- `reasons`
- `blockers`
- `next_step`
- `next_work_packages`
- `context_pack_seed`
- `snapshot_publish_plan`

`context_pack_seed` 是下一轮 Context Pack 的种子。它默认保持：

- `host=platform_core`
- `target_project_id=ai-control-platform`
- 禁止写入业务项目。
- 禁止因为已输出 summary 而停止。
- 禁止跳过主进程评估。

如果输入包含 `workflow_state`，且决策不是 `stop_for_human`，系统必须尝试生成 `snapshot_publish_plan`：

- `action=publish_workbench_snapshot`
- `endpoint=/api/workbench/snapshots`
- `id` 优先来自 `snapshot_id`，否则使用 workflow state manifest run id。
- `input` 为 projection-ready workflow state。

只有 plan 本身和生成后的 projection 都通过 snapshot publish readiness 时，`snapshot_publish_plan` 才能存在。否则必须返回 `snapshot_publish_issues`，不能输出一个后续必然失败的可执行计划。

这个计划把 closeout 后的工作台状态发布变成机器可执行动作，而不是人工手动修改 examples。

`runCloseoutPlan` / `tools/run-closeout-plan.mjs` 是该计划的执行入口：

- local 模式直接复用 `publishWorkbenchSnapshot`，写入 snapshot input 并更新 projection history。
- http 模式向 `/api/workbench/snapshots` POST 同一份 plan，供已启动的工作台服务执行。
- 缺少 `snapshot_publish_plan` 时必须 fail closed，不能把 closeout 误报为完成。
- local 模式必须验证当前 root 是 `ai-control-platform` 平台仓，防止从业务项目 cwd 发布中台状态。
- local 模式的 history path 和 snapshots root 必须解析在平台仓内，防止显式路径污染业务项目。
- http 模式必须校验 API 返回 `status=created`、匹配的 item id、通过 schema 的 projection，且 projection 身份与本次提交的 workflow state 一致；不能把任意 2xx 当作成功。
- runner 输出必须把 closeout 结果写回 `workflow_state.manifest.events` 和 `workflow_state.artifact_ledger.artifacts`。成功与失败都要成为可审计证据，后续调度器不得只解析 CLI 日志。
- 默认情况下，成功 closeout 会再次持久化带 evidence 的 workflow state 到同一 snapshot id，使工作台 latest 直接展示 closeout publication evidence。

`runAutonomousCloseoutLoop` 是调度器可复用入口，固定执行：

```text
decideContinuation -> runCloseoutPlan -> createWorkbenchProjection -> decideContinuation
```

它必须返回当前 decision、closeout 结果、projection 和下一轮 decision。只要下一轮仍有 `next_step` 且无人工阻塞，结果必须保持 `status=pass` / `phase=next_continuation`。

`tools/run-autonomous-closeout-loop.mjs --output <path>` 会写出 `autonomous-closeout-loop-run.v1` envelope，包含原始 input 和结构化 result。该文件是后续重放、审计和工作台问题定位的 durable artifact。

在任何调度器、恢复器或后续会话复用该 artifact 之前，必须先通过 `tools/check-autonomous-closeout-loop-run.mjs <path>`。该 gate 校验：

- artifact version、`run_id`、`cycle_id`、`phase`、`created_at` 和宿主项目身份。
- 原始 input 必须仍是 `ai-control-platform` workflow state。
- artifact 顶层 `status/phase` 必须与 `result.status/result.phase` 一致。
- pass artifact 必须包含 created closeout、created evidence snapshot、通过 schema 的 workbench projection、`projection.closeout.status=pass` 和继续状态的 `next_decision.snapshot_publish_plan`。

校验失败时必须 fail closed，不能把损坏、串线或半完成的 orchestration output 当作下一轮 Context Pack 输入。

`tools/run-autonomous-closeout-loop.mjs --resume-from <path>` 是当前最小 scheduler 复用入口。它必须先运行同一 replay validator：

- valid artifact 输出 `status=ready`、`phase=scheduler_continuation`、`continuation_input`、`context_pack_seed` 和 `snapshot_publish_plan`。
- invalid artifact 输出 `status=blocked`、`phase=replay_validation` 和 `replay_artifact_invalid` blocker，并以非零退出。
- 只有 `status=pass`、`phase=next_continuation` 且包含 closeout workflow state、projection、context pack seed、snapshot publish plan 的 artifact 可复用。
- artifact 不存在、JSON 损坏或 CLI mode 歧义时也必须输出结构化 blocker JSON，不能只输出 Node stack trace。
- resume mode 不得在校验失败时生成 continuation input。
- 如果 artifact 中仍包含可信的 `input.workflow_state`，blocked resume 必须把 `autonomous_loop_replay_validation` 事件和失败的 `evaluation` artifact 写回 workflow state，使工作台 projection 和 recovery evaluation 能看到这次失败，而不是只依赖 CLI stdout。
- replay blocker evidence 必须使用不覆盖历史的唯一 artifact/event id；如果 manifest 与 artifact ledger 的 run/cycle 身份不一致，不得写入半状态。
- `--resume-from` 在写入 blocker evidence 后必须发布 workflow state snapshot 并更新 projection history；发布失败要进入 `snapshot_publish` 结果，不能声称工作台已可见。

如果 workflow state 或 projection 中存在 `reviewer_provider_health` fact，continuation 必须把其中的 `scheduled_actions` 转成下一轮 work packages：

- `provider_smoke_check` -> 运行最小 provider smoke。
- `rerun_without_tools` -> 用无工具模式重跑 reviewer。
- `split_scope` -> 把 reviewer 文件/问题拆成更小批次。
- `fallback_model_or_defer_external_review` -> 切换模型或延后外部 reviewer，不继续排 unhealthy provider。

这些 work packages 必须进入 `next_work_packages` 和 `context_pack_seed.subtasks`，不能只展示在工作台上。

如果 workflow state 或 projection 中已经存在 `reviewer_scope_split` fact，continuation 必须优先消费具体 shard：

- 未完成 shard -> `run_reviewer_scope_shard` work package。
- work package 的 `owned_files` 来自 shard.files，reviewer 元数据保留 provider、model、profile、allowed_tools 和 dispatch_mode。
- 已有 concrete shards 时，不再重复生成抽象 `reviewer-provider-split-scope`。
- 已有 `reviewer_shard_result` 的 shard 视为完成，不再重复派发。

如果 workflow state 中已经存在完成态 `reviewer_shard_aggregate` fact，continuation 必须以 aggregate 的 `merged_findings` 重新计算 run evaluation：

- `pending_shards > 0` 或 `status=pending` 时，不得把 aggregate 当成最终决策。
- `status=fail` 且存在失败 finding 时，必须覆盖旧的 pass evaluation，进入 `rerun`、`rollback` 或 `human_intervention` 的统一决策路径。
- `status=pass` 时，可以覆盖旧的 reviewer timeout rerun，避免已经被 split/shard 恢复的问题继续制造无效重试。
- 显式 human/rollback evaluation 优先级仍然高于 aggregate，避免人工阻塞和边界回退被误清除。

这保证 smoke 通过但 DS tool review 超时时，下一轮会沿着“生成 split plan -> 分片复审 -> 汇总 findings”继续，而不是原样重跑同一个会超时的工具请求。

`tools/create-scheduler-dispatch-plan.mjs` / `npm run plan:scheduler-dispatch` 是当前最小 scheduler dispatch planner：

- 输入 continuation input 或 continuation decision。
- 发现 `run_reviewer_scope_shard` work packages 时，生成三步计划：
  - `run-reviewer-shard --all --record-provider-health --run-artifact-output ...`
  - `prepare-reviewer-shard-loop-continuation`
  - `run-autonomous-closeout-loop`
- 缺少 `workflow_state_input_path` 时必须失败闭合，因为 reviewer shard runner 需要明确输入/输出文件。
- dispatch plan 只生成可审计命令，不直接绕过 artifact validation 或 closeout validation。

## 5. 与工作台关系

Workbench Projection 展示当前轮状态；Autonomous Continuation 决定下一轮是否必须继续。后续任务创建时，如果 projection 显示 `pass` 但 `PROJECT_STATUS.next_step` 仍存在，调度器必须继续创建下一轮 Context Pack，而不是等待用户说“继续”。
