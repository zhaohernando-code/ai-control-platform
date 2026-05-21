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

如果输入包含 `workflow_state`，且决策不是 `stop_for_human`，`snapshot_publish_plan` 必须存在：

- `action=publish_workbench_snapshot`
- `endpoint=/api/workbench/snapshots`
- `id` 优先来自 `snapshot_id`，否则使用 workflow state manifest run id。
- `input` 为 projection-ready workflow state。

这个计划把 closeout 后的工作台状态发布变成机器可执行动作，而不是人工手动修改 examples。

## 5. 与工作台关系

Workbench Projection 展示当前轮状态；Autonomous Continuation 决定下一轮是否必须继续。后续任务创建时，如果 projection 显示 `pass` 但 `PROJECT_STATUS.next_step` 仍存在，调度器必须继续创建下一轮 Context Pack，而不是等待用户说“继续”。
