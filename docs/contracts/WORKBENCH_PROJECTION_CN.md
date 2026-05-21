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
| `model_routing` | selected model、preferred model、角色分布、是否有 reviewer / arbiter |
| `reviewer_gate` | reviewer provider、model、finding counts、max severity、recommended signal |
| `autonomous_run` | evaluateRunResult 的工作台摘要 |
| `task_dag` | DAG 节点总数、状态计数、可派发节点 |
| `one_screen` | PC 工作台首屏可直接展示的 headline、status、next actions 和 counters |

如果缺少 manifest、artifact ledger 或 model plan，projection 进入 `human_intervention`，因为工作台没有足够事实判断系统是否仍在正确目标上。

如果输入包含 `operator_event_ledger`，`createWorkbenchProjection` 必须先把 operator events 原子摄入 Run Manifest 与 Artifact Ledger，再计算 manifest、artifacts 和 autonomous_run 摘要。此时不得使用外部传入的旧 `run_result` 或 `run_evaluation` 覆盖摄入后的事实。

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

手机端不是 PC 页面压缩版，它消费同一个 projection 的移动子集，后续可以独立设计信息架构。

## 4. 设计边界

Projection 只汇总状态，不直接调用 agent、模型、CI 或发布系统。它的职责是给工作台和调度器提供同一份事实视图，避免 UI 从零散日志或聊天记录里推断状态。

## 5. Schema Gate

`validateWorkbenchProjectionSchema` / `check-workbench-projection.mjs` 是前端渲染前的门禁：

- PC projection 必须包含 manifest、artifacts、closeout、model routing、reviewer gate、autonomous run、task DAG 和 one-screen 摘要。
- Mobile projection 必须包含 headline、counters、next actions、closeout、model 和 reviewer 摘要。
- `status` 只能是 `pass`、`rerun`、`rollback`、`human_intervention`。
- 未知 projection version 或缺少关键对象时必须失败。

后续 PC / mobile 工作台开发不得直接消费未通过 schema gate 的 projection JSON。
