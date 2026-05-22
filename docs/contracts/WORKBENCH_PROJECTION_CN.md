# Workbench Projection 合同

状态：draft
宿主：`ai-control-platform`

## 1. 目标

Workbench Projection 是 PC / mobile 工作台的一屏状态输入。它不直接执行业务逻辑，而是把以下平台事实汇总成稳定的展示对象：

- Run Manifest：本轮目标、Context Pack、work packages、events。
- Artifact Ledger：需求、patch、测试、review、evaluation 等证据计数。
- Model Routing：本轮为什么选择 GPT、DeepSeek V4 Pro 或 DeepSeek V4 Flash。
- LLM Reviewer Gate：外部 reviewer 的 provider、model、finding 计数和推荐决策信号。
- Closeout Evidence：最近一次工作台 snapshot 发布事件和证据 artifact。
- Resume Health：最近一次 replay validation blocker、恢复健康状态和 evidence artifact。
- Reviewer Provider Health：DeepSeek / reviewer provider 的 smoke、tool timeout、retry 和 fallback 调度事实。
- Scheduler Dispatch：最近一次自动调度执行状态、step 数量、失败 step 和 dry-run 信号。
- Global Goal Completion：总目标完成度、pending/blocked goal 和下一目标。
- Autonomous Run Evaluation：pass / rerun / rollback / human intervention 决策。
- Task DAG：任务节点状态和可派发节点。

## 2. PC Projection

`createWorkbenchProjection` 输出 `workbench.v1`：

| 字段 | 含义 |
| --- | --- |
| `run_id` / `cycle_id` | 当前运行与周期 |
| `goal` | 本轮目标 |
| `status` / `decision` | 汇总状态与调度决策 |
| `manifest` | manifest 校验状态、work package 数、event 数 |
| `artifacts` | artifact total / by_type / by_status |
| `closeout` | latest closeout publish status、event、artifact、snapshot 与 evidence path |
| `resume_health` | latest replay validation status、issue count、latest issue 与 evidence artifact |
| `reviewer_provider_health` | latest provider health、retry strategy、next action 与 evidence artifact |
| `reviewer_scope_split` | latest reviewer split plan、shard_count、pending_shards、next_shard |
| `reviewer_shard_review` | latest shard aggregate、completed_shards、pending_shards、failed_finding_count |
| `scheduler_dispatch` | latest scheduler dispatch status、phase、step_count、failed_step_count、dry_run |
| `scheduler_loop` | latest autonomous scheduler loop status、iteration count、run count、invalid count、recovery action、resume projection 与 latest resume attempt |
| `global_goal_completion` | 总目标完成状态、完成/待办/阻塞计数和 next goal |
| `operations_timeline` | scheduler / loop / reviewer recovery facts 的最近 manifest 顺序摘要，含 group、next action role、driver counts |
| `next_action_readout` | 从 latest automation driver 派生的单一推荐自治动作 |
| `model_routing` | selected model、preferred model、角色分布、是否有 reviewer / arbiter |
| `reviewer_gate` | reviewer provider、model、finding counts、max severity、recommended signal |
| `autonomous_run` | evaluateRunResult 的工作台摘要 |
| `task_dag` | DAG 节点总数、状态计数、可派发节点 |
| `one_screen` | PC 工作台首屏可直接展示的 headline、status、next actions 和 counters |

如果缺少 manifest、artifact ledger 或 model plan，projection 进入 `human_intervention`，因为工作台没有足够事实判断系统是否仍在正确目标上。

`next_action_readout` 是工作台和调度器共享的推荐动作读出，不是执行授权本身。实际执行必须走 `/api/workbench/next-action`，由服务端重新计算 projection、校验 `expected_action`，并只执行已接入的白名单动作。当前已接入动作为 `enqueue_scheduler_next_cycle`、`run_autonomous_scheduler_loop`、`run_reviewer_scope_shard`。

`operations_timeline.latest` 与 `latest_driver` 必须按 manifest event 追加顺序判断，而不是按 `created_at` 排序。`created_at` 可能来自不同进程、fixture 或外部模型，存在时钟偏移；manifest 顺序才是当前平台内的因果顺序。

如果输入包含 `operator_event_ledger`，`createWorkbenchProjection` 必须先把 operator events 原子摄入 Run Manifest 与 Artifact Ledger，再计算 manifest、artifacts 和 autonomous_run 摘要。此时不得使用外部传入的旧 `run_result` 或 `run_evaluation` 覆盖摄入后的事实。

工作台服务从 history `input_path` 动态生成 projection 时，必须叠加仓库 `PROJECT_STATUS.json` 的 `project_status/global_goals`。这保证 PC/mobile 与 next-action 读到的是当前 repo-level 总目标，而不是旧 snapshot 内手工复制的 goal 列表。测试或隔离场景可以通过 `createWorkbenchServer({ projectStatusPath: null })` 显式关闭该叠加。

## 3. Mobile Projection

`createMobileWorkbenchProjection` 输出 `workbench.mobile.v1`，只保留移动端第一屏需要的信息：

- run / cycle / status / decision。
- headline。
- counters。
- 最多 3 个 next actions。
- 最多 3 个 blockers。
- 当前 selected model 和是否有 independent reviewer。
- reviewer status、max severity、recommended decision signal。
- closeout status、publish status、artifact id、snapshot id。
- provider health status、retry strategy、next action。
- scope split status、shard_count、pending_shards、next_shard。
- shard review status、completed_shards、pending_shards、failed_finding_count。
- scheduler dispatch status、phase、step_count、failed_step_count、dry_run。
- scheduler loop status、iteration count、recovery status/action 和 resume projection。
- global goal completion status、pending count 和 next goal。
- operations timeline 的最近事件摘要。
- next action readout 的 status、action、source type、target projection。
- resume health status、replay status、issue count 和 latest issue。
- provider health status、retry strategy 和 next action。

手机端不是 PC 页面压缩版，它消费同一个 projection 的移动子集，后续可以独立设计信息架构。

## 4. 设计边界

Projection 只汇总状态，不直接调用 agent、模型、CI 或发布系统。它的职责是给工作台和调度器提供同一份事实视图，避免 UI 从零散日志或聊天记录里推断状态。

## 5. Schema Gate

`validateWorkbenchProjectionSchema` / `check-workbench-projection.mjs` 是前端渲染前的门禁：

- PC projection 必须包含 manifest、artifacts、closeout、resume health、reviewer provider health、scheduler dispatch、scheduler loop、global goal completion、operations timeline、next action readout、model routing、reviewer gate、autonomous run、task DAG 和 one-screen 摘要。
- Mobile projection 必须包含 headline、counters、next actions、closeout、resume health、provider health、scheduler dispatch、scheduler loop、global goal completion、operations timeline、next action readout、model 和 reviewer 摘要。
- `status` 只能是 `pass`、`rerun`、`rollback`、`human_intervention`。
- 未知 projection version 或缺少关键对象时必须失败。

后续 PC / mobile 工作台开发不得直接消费未通过 schema gate 的 projection JSON。
