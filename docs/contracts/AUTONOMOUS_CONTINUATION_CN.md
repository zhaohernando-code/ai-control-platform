# Autonomous Continuation 合同

状态：draft
宿主：`ai-control-platform`

## 1. 目标

Autonomous Continuation 解决“每轮完成后停在总结，等待用户继续”的问题。对中台来说，完成一轮测试、提交或 projection 生成不等于任务结束；只要项目状态里仍有 `next_step`、`next_work_packages` 或未完成 `global_goals`，且没有真实人工阻塞，系统必须自动生成下一轮执行指令。

## 2. 输入

`decideContinuation` 的输入可以来自：

- `project_status`：项目、blockers、next_step、global_goals。
- `run_evaluation`：`pass`、`rerun`、`rollback`、`human_intervention` 及 next work packages。
- `blockers`：凭据、破坏性动作、需求冲突、恢复失败耗尽等。
- `owned_files` / `acceptance_gates` / `rollback_conditions`：用于生成下一轮 Context Pack seed。

`prepareContinuationFromProjectStatus` / `tools/prepare-project-status-continuation.mjs` 是从仓库 durable status 进入自治循环的标准入口：

- 输入为 `PROJECT_STATUS.json`。
- 输出为 `continuation_input`，包含规范化后的 `project_status`、默认 `run_evaluation.source=PROJECT_STATUS.json` 和可选 workflow state。
- CLI：`npm run prepare:project-status-continuation -- --project-status PROJECT_STATUS.json --output <continuation-input.json>`。
- 项目不是 `ai-control-platform`、缺少 `next_step` 且没有 `global_goals` 时必须失败闭合。
- 输出仍必须交给 `decideContinuation`，不能由 CLI 自己绕过 global goal / blocker / completion 规则。
- `tools/create-scheduler-dispatch-plan.mjs --project-status PROJECT_STATUS.json --output <dispatch-plan.json>` 可以直接从仓库状态创建 scheduler dispatch plan。没有具体 scheduler action 时输出 `phase=no_dispatchable_scheduler_actions`，但 plan 必须保留 decision/global goal completion 读数，供后续工作台或 loop 继续判断。

## 3. 决策

| 条件 | action | should_continue |
| --- | --- | --- |
| `next_step` 存在且无 blocker | `continue` | true |
| `global_goals` 存在且仍有 pending goal | `continue` | true |
| `global_goals` 全部 complete，且没有 next step/work package | `complete` | false |
| `global_goals` 存在 blocked/human_intervention goal | `stop_for_human` | false |
| `run_evaluation.status=rerun` | `rerun` | true |
| `run_evaluation.status=rollback` | `rollback` | true |
| reviewer timeout 等可恢复失败 | `rerun` | true |
| 凭据缺失、破坏性动作、需求冲突、恢复失败耗尽 | `stop_for_human` | false |
| continuation 指向错误宿主 | `stop_for_human` | false |

核心规则：**总结、提交、推送、测试通过都不是停止条件**。停止必须来自两类机器可读事实：全局目标明确全部完成，或自动系统缺少安全前提。

`global_goals` 是总目标完成判断的 durable source。每个 goal 至少应包含：

- `id`
- `title`
- `status`：`pending` / `in_progress` / `completed` / `blocked` 等。
- `next_step` 或 `next_work_packages`：goal 未完成时如何继续。
- 可选 `owned_files`、`acceptance_gates`、`rollback_conditions`、`blockers`。

当单个需求完成且 `run_evaluation.status=pass` 时，`decideContinuation` 必须重新计算 `global_goal_completion`：

- pending goal 会被转换为 `continue_global_goal` work package，进入下一轮 `context_pack_seed.subtasks`。
- complete goal 不再产生任务。
- blocked goal 变成 `global_goal_blocked` blocker，防止系统把未完成目标误报为完成。
- 只有所有已配置 global goals 都是完成态，且没有其他 next step/work package，才允许 `action=complete`。

## 4. 输出

`decideContinuation` 输出：

- `action`
- `should_continue`
- `reasons`
- `blockers`
- `next_step`
- `next_work_packages`
- `global_goal_completion`
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

`run_context_work_packages` 是 Context Pack work packages 的执行入口。它必须先运行 fixed-development-mode dispatch gate 和 work-package-execution-governance gate，再根据显式执行请求选择 adapter：

- 未请求 provider/model-routed mode 时，继续使用默认 `local_bounded` 路径；但该路径只能完成本地安全的、非产品实现类 work package。
- 默认 `local_bounded` 只能消费“无显式执行身份”或显式身份全为 `local_bounded` 的请求；显式未知 `execution_profile` / `adapter_profile` / `executor_profile`、非 local `executor_kind`、provider-like 或非 local `execution_mode` 必须 blocked closed，不能被 local fallback 写成 completed。
- `context_pack -> work_packages -> task_dag` 物化必须保留 `reason`、`acceptance_gates`、`depends_on` 和 `source`。这些字段不是展示信息，而是执行前治理、child prompt、验收和依赖重写的输入。
- 需求实现类 work package 必须是具体可执行切片。硬门禁不解析中文步骤文本；它只读取 `source.execution_governance` 中的 `granularity`、`decomposition.required/status/evidence`、`verification.status/gate_count`。需要拆包的步骤必须先由 manager 产出带 completed decomposition evidence 的工作包，并为后续依赖重写到最后一个切片。
- work-package-execution-governance gate 必须在 already-satisfied preflight、provider/model-routed adapter 和 child-worker 启动之前执行；失败时返回 blocked，不得写 completed，也不得启动外部模型。
- `continue_requirement_intake` 和 broad `continue_global_goal` 属于 implementation-bearing work package；没有 verified child-worker/provider completion authority 时，`local_bounded` 必须 blocked closed，并保持原 work package 状态。
- 请求 provider/model-routed mode 时，必须提供已注册 `execution_profile`。当前可用于测试和工作台试跑的 profile 是 `bounded_mock_multi_agent`，它只做 deterministic mock execution，不调用真实 GPT/DeepSeek/Claude。
- 工作台 `/api/workbench/next-action` 执行 `run_context_work_packages` 时必须把 `execution_mode`、`execution_profile`、`risk`、`budget_tier`、`codex_plan_pressure`、`tags`、`stage` 等 adapter 字段透传给 `/api/workbench/context-work-packages-run`，不能只支持代码 API 直接调用。
- adapter 结果必须显式携带 `completion_authority` / `allows_work_package_completion`。runner 只能让同时具备顶层 completion authority 和 package-result completion authority 的 `status=pass` 结果驱动 `work_packages[].status=completed`。
- `bounded_mock_multi_agent` 属于 non-completing profile：它只能返回可展示的 `status=validated` / `phase=simulated_execution`，包含 `execution_plan`、`package_results`、`executor_provenance`、`issues` 和无完成授权的 `completion_authority`；不得返回 `workflow_state`，不得写 completed/result pass，不得生成 pass completion artifact。
- `bounded_mock_multi_agent`、`deterministic_mock_multi_agent` 和任何 mock/simulation 类 token 即使只出现在 `adapter_profile`、`executor_profile` 或 `executor_kind` 中，也不得落入 local completion fallback。
- adapter 只有在具备 completion authority 并真实完成后，才允许写入 durable completion artifact metadata：`execution_mode`、`execution_profile`、`package_results`、`executor_provenance`、`completion_authority` 和 `model_routing`。
- profile 缺失、未知、adapter blocked，或模拟/复审型 adapter 缺少 completion authority 时，必须保持原 work package 状态。
- 后续真实 provider adapter 应复用同一接口和 metadata 结构，不能直接在 continuation 或 workbench next-action 中调用外部模型。

如果 workflow state 或 projection 中已经存在 `reviewer_scope_split` fact，continuation 必须优先消费具体 shard：

- 未完成 shard -> `run_reviewer_scope_shard` work package。
- work package 的 `owned_files` 来自 shard.files，reviewer 元数据保留 provider、model、profile、allowed_tools 和 dispatch_mode。
- 已有 concrete shards 时，不再重复生成抽象 `reviewer-provider-split-scope`。
- 已有 `reviewer_shard_result` 的 shard 视为完成，不再重复派发。

如果 workflow state 中已经存在完成态 `reviewer_shard_aggregate` fact，continuation 必须以 aggregate 的 `merged_findings` 重新计算 run evaluation：

- `pending_shards > 0` 或 `status=pending` 时，不得把 aggregate 当成最终决策。
- `status=fail` 且存在失败 finding 时，必须覆盖旧的 pass evaluation，进入 `rerun`、`rollback` 或 `human_intervention` 的统一决策路径。
- `status=pass` 时，可以覆盖旧的 reviewer timeout rerun，避免已经被 split/shard 恢复的问题继续制造无效重试。
- `status=pass` 后生成的 `context_pack_seed` 必须清理过期的 reviewer provider health、timeout recovery、scope split 和 shard result 恢复包，避免把 aggregate 前的恢复动作带进下一轮 seed。
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
- deterministic trial 可以显式传 `--reviewer-mock-status` / `--reviewer-mock-findings-json`，但这必须出现在 dispatch plan 中，不能在执行阶段临时篡改命令。

`tools/run-scheduler-dispatch-plan.mjs` / `npm run run:scheduler-dispatch` 是当前受限执行器：

- 执行前必须先 validate dispatch plan。
- 只允许 `npm run run:reviewer-shard`、`npm run prepare:reviewer-shard-loop-continuation`、`npm run run:autonomous-closeout-loop`。
- 按 step `depends_on` 顺序执行；任一步失败立即停止。
- 支持 `--dry-run`，用于 closeout 前验证计划结构。
- 输出 `scheduler-dispatch-run.v1` artifact，记录每个 step 的 status、exit code、stdout/stderr 和 dry-run 标记。
- `scheduler-dispatch-run.v1` 可以记录回 workflow state，工作台 projection 必须展示 latest scheduler dispatch status。
- 工作台服务必须提供 scheduler dispatch run 写回 API；写回前校验 artifact version、status、result.steps、history input_path 和 run/cycle identity。
- 调度 CLI 支持 `--workbench-base-url` / `--projection-id`，用于在执行完成后自动写回工作台服务；artifact 执行失败或写回失败都不能伪装为成功。
- Scheduler dispatch plan 可以内置 `writeback` 策略。`mode=service` 必须提供 workbench base URL；runner CLI 在没有显式 flag 时使用计划内策略。
- 工作台服务可以从 projection history 的 `input_path` 生成 scheduler dispatch plan，并自动注入 service writeback base URL 与 projection id；没有 `input_path` 或 Host 不可信时必须失败闭合。
- 工作台控制面可以触发受控 scheduler dispatch dry-run。服务端必须先生成计划、执行 dry-run、写回 artifact 并返回新 projection；前端不得在服务成功前乐观刷新状态。
- 非 dry-run scheduler dispatch 必须先通过 execution policy：明确 operator authorization、step 上限、reviewer call budget 和 provider cost mode。policy 失败时不得执行计划或写回 scheduler dispatch run artifact。
- 每一次工作台 scheduler dispatch policy 决策都必须写入 `scheduler_dispatch_policy` 事件和 `scheduler-dispatch-policy.v1` artifact；projection 必须展示 latest policy status、execution mode、issue count 和首个 issue，便于工作台解释为什么执行或拦截。
- 工作台非 dry-run 入口必须使用命名 profile，不允许前端拼散落的授权字段。当前允许的最小 profile 是 `approved_mock_non_dry_run`：零外部 reviewer 调用、mocked provider cost、最多三步、执行前仍写 policy decision。
- Scheduler dispatch 生成的输出路径必须自给自足：runner CLI 要创建输出目录；snapshot publisher 在受控路径内可以初始化缺失的 projection history，避免长任务因为空目录停住。
- 非 dry-run scheduler dispatch artifact 必须记录每个成功 step 的声明输出摘要。`run-autonomous-closeout-loop` 输出摘要必须包含 next continuation status/action/work package count；projection 和 PC/mobile 工作台必须展示这些字段，作为是否继续下一轮的机器可读依据。
- Scheduler dispatch 产出的下一轮 continuation input 必须通过 `prepare:scheduler-dispatch-continuation` 或等价 adapter 生成。该 adapter 只能读取 `scheduler-dispatch-run.v1` 中声明的 closeout loop artifact 路径，并必须复用 autonomous closeout loop replay validator；blocked 时不得生成 continuation input。
- `run-scheduler-dispatch-plan` 可以通过 `--continuation-output` 在同一次执行中生成下一轮 continuation input。该输出仍必须走 scheduler dispatch continuation adapter；adapter blocked 时整个 runner 必须失败。
- Scheduler dispatch plan 必须携带 `continuation_output` 文件目标；非 dry-run runner 在没有显式 CLI flag 时使用 plan 内目标，dry-run 不生成 continuation input。
- 工作台服务执行受控非 dry-run scheduler dispatch 后，必须同步生成 plan 声明的 continuation input，并把 `scheduler_dispatch_continuation` 作为 durable workflow fact 写回 manifest 和 artifact ledger；projection history 必须能展示 `continuation_ready`、`enqueue_available`、continuation input path 和 next work package count。
- 工作台服务必须提供 `POST /api/workbench/scheduler-next-cycle`：它只能消费 projection history `input_path` 中最新的 scheduler dispatch run artifact，重新运行 scheduler dispatch continuation adapter，读取并校验已生成的 continuation input，然后写入 `scheduler_next_cycle_enqueue` fact 并发布下一轮 workflow snapshot。没有 `input_path`、没有 dispatch run、adapter blocked、continuation path 越界或 generated input 身份不一致时必须失败闭合，不得写入半状态。
- 该接口校验 generated continuation input 的 work package count 时，必须优先读取生成结果里的 `next_work_packages`，而不是拿源 `workflow_state.manifest.work_packages` 当作下一轮 continuation 的数量；否则会把上一轮的旧工作包误当成新 continuation。
- `tools/run-autonomous-scheduler-loop.mjs` / `npm run run:autonomous-scheduler-loop` 是当前最小自运行 loop driver。它只能连接本机 HTTP workbench server，只允许命名 profile `approved_mock_non_dry_run`，`max_iterations` 必须在 1-5 之间，并且每轮都按 `scheduler-dispatch-plan -> scheduler-dispatch -> scheduler-next-cycle` 推进；没有 dispatchable scheduler steps、continuation 未 ready、enqueue 未返回 next history id 或达到迭代上限时必须停止并输出 `autonomous-scheduler-loop-run.v1` artifact。
- 自运行 loop 的服务端集成测试不得用同步子进程阻塞同一进程里的 workbench server；必须使用异步 child process，让本地 server 仍能处理 loop driver 的 HTTP 请求。
- 工作台服务必须能通过 `POST /api/workbench/autonomous-scheduler-loop` 触发一轮 bounded loop，并把 `autonomous_scheduler_loop_run` fact 写回发起的 history input；PC/mobile projection 必须展示 loop status、phase、iteration count 和 latest projection id，前端只能发送 bounded 参数，不能拼底层 scheduler policy 字段。
- `autonomous-scheduler-loop-run.v1` 不得作为普通摘要直接复用；恢复器和 projection history 必须先从 manifest events + artifact ledger 构建 loop run registry，校验 version、status/phase/result 一致性、iteration schema 和 queued next projection，再输出 recovery policy。invalid registry 必须 `blocked/quarantine_invalid_loop_artifact`，ready registry 才能从 latest queued projection resume。
- 工作台 projection 与 `/api/workbench/projections` history readout 必须展示 loop run count、invalid count、recovery status/action、resumable 和 resume projection id，避免进程重启后只能依赖当前聊天上下文判断是否继续。
- 工作台服务必须提供 `POST /api/workbench/autonomous-scheduler-loop-resume`：它只能读取所选 history input 的 loop registry/recovery policy，必须由服务端选择 `resume_projection_id` 作为新的 loop 起点，把新 loop artifact 写入该 resume projection 的 workflow state；recovery 不是 ready 或 resume projection 缺少受控 input_path 时必须失败闭合，不得要求操作者手工选择下一轮 id。
- PC/mobile 工作台可以传当前 history item id 作为 source context，但不得传或拼接 raw resume projection id、scheduler policy 字段或底层执行授权；resume target selection 必须保留在服务端 recovery policy。浏览器门禁必须覆盖“运行 loop -> 恢复 loop”的连续操作，并验证恢复后仍无横向溢出。
- 每一次 scheduler loop resume 尝试都必须写入源 workflow state：事件类型为 `scheduler_loop_resume_attempt`，artifact metadata version 为 `scheduler-loop-resume-attempt.v1`。blocked 尝试必须记录 recovery status/action 和 issues；成功尝试必须记录 source projection、resume projection、loop status/phase 与目标 loop artifact id。Projection 必须展示 latest resume attempt status/target/issue。
- 工作台服务必须提供 `POST /api/workbench/next-action` 作为推荐动作的唯一受控执行入口。该入口必须重新计算所选 projection 的 `next_action_readout`，校验调用方传入的 `expected_action` 未漂移，并且只允许执行白名单动作；当前白名单包含 `prepare_project_status_continuation`、`continue_after_reviewer_aggregate`、`create_context_pack_from_seed`、`run_context_work_packages`、`enqueue_scheduler_next_cycle`、`run_autonomous_scheduler_loop`、`run_reviewer_scope_shard`。resume、inspect 等尚未接入的动作必须失败闭合并返回 projection/readout，不得隐式降级为人工成功或临时脚本。`run_context_work_packages` 结束后若仍有 dispatchable work packages，继续推荐 `run_context_work_packages`；若 dispatchable 已耗尽但 `global_goal_completion.status=in_progress`，必须回到 `prepare_project_status_continuation`，不能直接停在 `inspect_context_work_packages`。
- `prepare_project_status_continuation` 是仓库级总目标兜底入口。只有在 projection 没有更具体 automation driver、且 `global_goal_completion.status=in_progress` 时才应被推荐；执行时必须读取仓库 `PROJECT_STATUS`，生成 continuation decision、next work packages 和 `context_pack_seed`，并写入 `project_status_continuation` event/artifact。它不得抢占 reviewer shard、scheduler continuation、resume recovery 等已有具体 driver。
- `create_context_pack_from_seed` 必须消费最新 ready 的 `project_status_continuation.context_pack_seed`，先通过 Context Pack gate，再生成新的 Run Manifest、Work Packages、Artifact Ledger 和 projection-ready workflow snapshot。seed 的根级 `owned_files` 必须覆盖所有子任务 `owned_files`；如果 continuation work package 声明了 owned files，`context_pack_seed` 需要自动汇总它们，不能让 materialize 阶段才暴露越界。
- `run_context_work_packages` 是当前 context pack cycle 的受控 work package 执行入口。它只能在 fixed-development-mode、work-package-execution-governance 和完成权限均成立时写回 `context_work_packages_run` event/artifact，更新 durable Run Manifest、Task DAG 和 Artifact Ledger，然后让 projection 重新判断是否仍有 dispatchable package。默认 `local_bounded` 不直接代表真实多 agent 实现，也不得完成需求实现类 work package；真实 agent 调用必须挂在这个 durable 执行点之后，并通过 verified provider/child-worker completion authority 驱动 durable completion writes，不能重新引入聊天上下文驱动的隐式执行。
- `run_reviewer_scope_shard` 必须通过工作台服务端的 reviewer shard runner 路径执行：服务端从 durable workflow state 选择 pending shard，真实执行默认使用 provider-neutral runner + Claude/DeepSeek executor，测试或受控 profile 可以显式传入 mock reviewer 输出；执行结果必须写回 reviewer_shard_result、必要时的 reviewer_shard_aggregate 或 reviewer_provider_health facts。
- `continue_after_reviewer_aggregate` 必须消费完成态 `reviewer_shard_aggregate` 后的 durable state，并通过 project status continuation 入口重新计算 continuation decision；写入 `project_status_continuation` 后，projection 必须转向 `create_context_pack_from_seed`，避免 headless/projected loop 在同一个 aggregate 上重复执行。
- Autonomous scheduler loop 必须支持两种策略：默认 `scheduler_dispatch_chain` 保留现有稳定路径；`projected_next_action` 先读取 projection 的 `next_action_readout`，再通过 `/api/workbench/next-action` 执行推荐动作。Projected strategy 用于验证平台是否能从看板状态直接推进，而不是只靠写死的 scheduler-only step sequence。
- Headless CLI projected loop 执行 `/api/workbench/next-action` 后，如果响应包含 `next_item.id`，下一轮读取 projection 和提交 next-action 时必须切换到该 projection id。不能一直使用启动时的 source projection id，否则 `create_context_pack_from_seed` 生成的新 cycle 会可执行但无人消费。Reviewer/scheduler 的 execution profile、mock reviewer 参数和 provider 预算只能传给对应动作；除非显式配置 context-work-package 专用 profile，不得把 reviewer profile 透传给 `run_context_work_packages`。
- PC/mobile 工作台必须提供 bounded projected mock loop 试运行入口，用于可视化验证 projection-driven execution 能推进 reviewer shards。该入口必须显式传 `execution_strategy=projected_next_action` 和 mock reviewer 参数，不能让 mock 行为伪装成真实 provider 成功。
- Projected loop 遇到 `inspect_*`、`wait_for_driver_event` 或非 ready 推荐动作时，必须把 `terminal_action` 和 `terminal_reason` 写入 loop iteration，并由 workbench projection 的 `scheduler_loop` 摘要暴露；`next_action_terminal` 也必须在 projection 与 mobile projection 中显式呈现。停止原因不能只存在于 transient phase 字符串。
- `autonomous-scheduler-loop-run.v1`、PC/mobile workbench projection 和 projection history readout 都必须暴露 `execution_strategy` 与 `execution_profile`。工作台不能只通过按钮文案暗示当前运行是 `scheduler_dispatch_chain`、`projected_next_action`、mock profile 还是未来真实 reviewer profile。
- `run_reviewer_scope_shard` 的 executor 选择必须先通过 reviewer execution policy。`approved_mock_non_dry_run` 必须显式提供 mock reviewer 输出并保持 `max_external_reviewer_calls=0`；`approved_bounded_real_reviewer` 必须显式提供 `max_external_reviewer_calls=1`、`provider_cost_mode=bounded` 和 30-120 秒 timeout，并由 model routing 记录 DeepSeek/GPT 协作读数。禁止通过“缺少 mock 字段”隐式触发真实 Claude/DeepSeek 调用。
- Reviewer shard result 的 executor provenance 必须进入 workbench projection 和 PC/mobile readout，至少包含 `executor_kind`、`execution_profile`、provider/model 和 external call budget used。看板必须能直接区分 mock trial 与 bounded real reviewer run，不能要求操作者打开 raw artifact 判断。
- PC/mobile 可以提供 `Projected Real Loop` 控制，但它只能发送 `approved_bounded_real_reviewer`、`execution_strategy=projected_next_action`、`max_external_reviewer_calls=1`、`provider_cost_mode=bounded` 和 bounded timeout。服务端在选择真实 executor 前必须检查最新 reviewer provider health fact 为 healthy；缺失或 unhealthy 时必须失败闭合，不得触发 Claude/DeepSeek。
- Provider health preflight 是读取条件，不应在 projected loop 即将执行前追加一个新的 automation driver；否则 `next_action_readout` 可能改为 provider recovery。真实 reviewer loop smoke 必须证明 reviewer shard 仍是当前推荐动作。
- Reviewer shard projection 在尚未 aggregate 时，必须根据 split shard ids 减去已完成 shard result ids 计算 `next_shard`；不能在 partial result 后继续展示 split plan 的初始 shard。
- Projected loop 在 `iteration_limit_reached` 后，如果 durable reviewer shard state 显示仍有 `pending_shards`，`next_action_readout` 必须继续推荐 `run_reviewer_scope_shard`，并由 reviewer shard runner 根据已完成 result 跳到下一片。只有服务返回的真实 `next_item.id` 可以成为跨 projection resume target；当前 `item.id` 不能被误判为新 resume 目标。
- PC/mobile 工作台必须把 reviewer shard review 的 `next_shard` 渲染为独立读数；浏览器门禁必须覆盖真实 reviewer 单片预算后的 partial shard readout，验证 next shard、executor、external budget 和推荐动作同时可见。
- `tools/check-workbench-browser-events.mjs --output <path>` 必须写出 `workbench-browser-events-run.v1` artifact；closeout 必须读取该 artifact 并校验 `projected_real_partial_shard_readout`、`run_reviewer_scope_shard` 和无横向溢出，不能只依赖 stdout。
- `tools/check-workbench-browser-events.mjs --record-base-url <url> --record-projection-id <id>` 必须把同一份 artifact POST 到 `/api/workbench/workbench-browser-events-run`，校验 API 返回 201、projection 中 `workbench_browser_events.partial_shard_ready=true`，否则失败闭合。
- `tools/check-workbench-browser-events.mjs --record-temp-workflow` 是 closeout 的自包含验证路径：runner 临时启动工作台服务、写回 artifact、再确认 workflow state manifest event 和 artifact ledger 已持久化。closeout 必须使用该模式，避免 UI 门禁只验证浏览器 stdout 和本地 artifact。
- 当 workflow state 中存在 `workbench_browser_events_run` fact 时，workbench projection 必须输出 `workbench_browser_events` 摘要，包含 status、artifact_id、scenario_count、partial_shard_ready 和 overflow_count；PC/mobile 工作台必须能展示最新 UI verification 状态。
- 工作台服务必须提供 `POST /api/workbench/workbench-browser-events-run`，接收 `workbench-browser-events-run.v1` artifact，校验 version、partial-shard readiness 和无横向溢出后写入 `workbench_browser_events_run` 事件与 artifact ledger。无受控 `input_path`、artifact 缺失关键场景或出现横向溢出时必须失败闭合。

## 5. 与工作台关系

Workbench Projection 展示当前轮状态；Autonomous Continuation 决定下一轮是否必须继续。后续任务创建时，如果 projection 显示 `pass` 但 `PROJECT_STATUS.next_step` 仍存在，调度器必须继续创建下一轮 Context Pack，而不是等待用户说“继续”。
