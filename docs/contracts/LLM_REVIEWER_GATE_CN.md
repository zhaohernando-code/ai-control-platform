# LLM Reviewer Gate 合同

状态：draft
宿主：`ai-control-platform`

## 1. 目标

LLM Reviewer Gate 把 Claude Code + DeepSeek V4 Pro 这类外部模型审视模式固定为中台流程能力，而不是主进程临时手工调用的 skill。

它在流程中的位置：

```text
子进程完成
-> run manifest 记录 reviewer request
-> 外部 LLM reviewer 只读审查
-> reviewer findings 写回 run manifest / artifact ledger
-> autonomous-run 消费 findings
-> 工作台展示 reviewer gate 状态与推荐决策信号
```

## 2. Reviewer Request

`createReviewerGateRequest` 生成机器可读请求：

| 字段 | 含义 |
| --- | --- |
| `run_id` / `cycle_id` | 对应一次运行和开发周期 |
| `provider.provider` | 例如 `claude-code` |
| `provider.model` | 例如 `deepseek-v4-pro` |
| `provider.cost_tier` | 成本层级，用于调度选择 |
| `provider.accuracy_tier` | 准确度层级，用于高风险任务选择 |
| `provider.tooling` | 默认 `read-only` |
| `scope` | 本次审查范围 |
| `files` | 允许读取的文件集合 |
| `questions` | 审查问题 |
| `forbidden_actions` | 禁止动作 |
| `output_contract` | 结构化输出要求 |

门禁要求：

- 默认 `read_only=true`。
- 只允许 `Read,Grep,Glob` 这类只读工具。
- 禁止 `Bash`、`Edit`、`Write`、server、browser 等写入或执行型工具。
- 缺少 scope、files、questions 时不得派发 reviewer。

## 3. Reviewer Findings

`normalizeReviewerFindings` 将外部审查结果归一为 `autonomous-run` 可消费的 `review_findings`：

| 字段 | 含义 |
| --- | --- |
| `finding_id` | finding id |
| `status` | `pass` 或 `fail` |
| `category` | `reviewer`、`host_boundary`、`owned_files`、`credentials` 等 |
| `severity` | `info`、`medium`、`critical` 等 |
| `message` | 可展示消息 |
| `requires_rollback` | 是否触发自动回退 |
| `requires_human` | 是否需要人工介入 |
| `evidence` | 文件、行号、命令或摘要证据 |
| `provider` / `model` | 来源模型 |

严重 host boundary、owned files、安全或数据损坏类 finding 会变成 `requires_rollback=true`。凭据缺失、需求冲突或明确人工阻塞会变成 `requires_human=true`。

Reviewer 超时不应默认卡成人工等待。`createReviewerTimeoutFinding` 将外部 reviewer 超时归一成：

- `status=fail`
- `category=reviewer_timeout`
- `severity=medium`
- `requires_rollback=false`
- `requires_human=false`

因此 `autonomous-run` 会把它视为可恢复失败，进入 `rerun`，由调度器选择缩小范围、换模型或降级执行。

## 4. Provider Health 与 Retry Scheduling

Reviewer timeout 不得直接变成人工阻塞，也不得无限重试同一个工具路径。平台必须把 timeout recovery 写成 durable scheduler facts：

- `reviewer_provider_health` event：写入 Run Manifest，记录 provider、model、provider_health、recovery_status、retry_strategy 和 scheduled_actions。
- `reviewer-provider-health` evaluation artifact：写入 Artifact Ledger，作为调度器和工作台共同读取的 evidence。
- smoke 未运行：`status=needs_smoke_check`，`next_action=provider_smoke_check`。
- smoke 通过且原 reviewer 带工具：`status=retry`，优先 `rerun_without_tools`，其次 `split_scope`。
- smoke 通过且无工具：`status=retry`，下一步 `split_scope`。
- smoke 失败或超时：`status=blocked`，下一步 `fallback_model_or_defer_external_review`，不能继续排 DeepSeek reviewer 任务。

持久化必须原子完成：manifest 与 artifact ledger 的 run/cycle identity 不一致时，不能写入半状态。

`tools/record-reviewer-provider-health.mjs` / `npm run record:reviewer-provider-health` 是当前 CLI 入口，用于把 DS smoke 结果或 reviewer timeout recovery 写回 workflow state。CLI 必须：

- 要求 `--input` 和 `--output`，或显式 `--in-place`。
- 输入不可读、JSON 损坏或 workflow identity 不一致时非零退出。
- 成功时输出 artifact id、provider health、retry strategy 和 scheduled actions。

`POST /api/workbench/reviewer-provider-health` 是工作台服务入口，用于浏览器或 operator action 写入同一类 fact。服务端必须：

- 只写入 projection history item 的 `input_path` workflow state。
- 没有 `input_path` 时失败闭合，不能修改静态 projection。
- 成功后返回 fact 和重新生成的 projection。

PC/mobile 工作台可以通过 Smoke OK / Smoke Timeout 控件调用该 API。浏览器门禁必须验证控件点击后页面状态刷新为最新 provider health，并且不产生横向溢出。

## 5. Scope Split Layer

`reviewer_scope_split` 是 DS tool review 超时后的拆分层，不是人工临时把 prompt 拆小。它的输入是原始 Reviewer Request，输出是可调度的 bounded shards：

- 每个 shard 继承 run/cycle、provider、model、profile、output contract 和 forbidden actions。
- 每个 shard 的 files、questions、prompt chars 都不能超过 `createReviewerInvocationPolicy` 给出的 profile limits。
- smoke 通过但 tool review 超时时，平台可以进入 `tool_timeout_recovery`：默认强制一文件一 shard，并可生成 `no_tools` shard，避免原样重跑同一个工具路径。
- 拆分计划必须写入 `reviewer_scope_split` manifest event 和 `reviewer-scope-splitter` evaluation artifact。
- manifest 与 artifact ledger 的 run/cycle identity 不一致时，不能写入半状态。

调度含义：

- `reviewer_provider_health.scheduled_actions` 中出现 `split_scope` 但还没有 split plan 时，下一步是生成 split plan。
- 已有 split plan 时，continuation 必须优先消费具体 shard，生成 `run_reviewer_scope_shard` work packages，而不是继续调度抽象的 `split_scope`。
- 工作台 projection 必须显示 shard_count、pending_shards 和 next_shard，保证 operator 能看到 DS reviewer 是否正在按分片推进。

## 6. Shard Result Aggregation

每个 reviewer shard 的执行结果必须写成 durable fact，不能只存在于 DS/Claude Code 的命令输出里：

- `reviewer_shard_result` event：记录 shard_id、provider、model、files、questions、findings 和失败 finding 数。
- `reviewer-shard-result` review artifact：保存同一份结构化结果。
- `reviewer_shard_aggregate` event：汇总本轮 split plan 的全部 shard 结果。
- `reviewer-shard-aggregate` review artifact：保存 merged_findings、completed_shards、pending_shards、failed_finding_count。

聚合规则：

- 只能聚合同一个 split plan 中已知的 shard；未知 shard_id 必须失败闭合。
- pending shard 存在时，aggregate status 为 `pending`，不得提前把 findings 写入 `manifest.review_findings`。
- 全部 shard 完成后，merged_findings 追加到 `manifest.review_findings`，由 `evaluateRunResult` 统一决定 `pass`、`rerun`、`rollback` 或 `human_intervention`。
- continuation 必须跳过已有 `reviewer_shard_result` 的 shard，避免重复派发已经完成的分片。

`tools/record-reviewer-shard-result.mjs` / `npm run record:reviewer-shard-result` 是当前 CLI 入口，用于把真实 DS shard 输出写回 workflow state。CLI 必须：

- 要求 `--input`、`--shard-id`，以及 `--output` 或显式 `--in-place`。
- 支持 `--findings-json` 或 `--findings-file`。
- 支持 `--aggregate`，在记录 shard 后尝试写入 aggregate。
- 输入不可读、JSON 损坏、workflow identity 不一致或 shard_id 不在当前 split plan 中时非零退出。

`POST /api/workbench/reviewer-shard-result` 是工作台服务入口，用于浏览器或 operator action 写入同一类 shard result。服务端必须：

- 只写入 projection history item 的 `input_path` workflow state。
- 没有 `input_path` 时失败闭合，不能修改静态 projection。
- `aggregate=true` 时，记录 shard result 后立即尝试写入 aggregate。
- 成功后返回 fact、可选 aggregate 和重新生成的 projection。

`reviewer-shard-runner` 是 provider-neutral 执行层：

- 从最新 `reviewer_scope_split` 中选择尚无 `reviewer_shard_result` 的 pending shard。
- 为 shard 构造只读 prompt，明确 files、questions、allowed tools、forbidden actions 和 JSON findings 输出合同。
- 必须通过显式 executor adapter 执行，不能在 runner 内硬编码某个模型或脚本。
- executor 返回后立即复用 shard result recording path。
- 如果这是最后一个 pending shard，runner 自动写入 aggregate。
- 缺少 executor 或请求的 shard 不在 pending 集合中时失败闭合。

Agent reviewer executor adapter 约束：

- 必须通过项目内 `src/workflow/agent-invocation.js` 和 `config/agent-profiles.json` 的 `reviewer_shard` profile 调用。
- 不允许调用仓库外个人 launcher 或历史 wrapper。
- shard.allowed_tools 为空时传空 tools；只读 shard 可传 `Read,Grep,Glob` 等只读工具。
- 默认候选模型由 profile 决定，当前优先 `deepseek-v4-pro[1m]`，并可按 key 健康/超时 fallback 到 Claude、DeepSeek Flash 或 MiMo。
- executor stdout 中的 JSON array 或 `{ findings: [...] }` 解析为 shard findings。
- 非结构化成功输出转成 `evidence_gap` finding，不能当作通过。
- timeout 转成 `category=reviewer_timeout` 的 fail finding，由 shard result/aggregate 进入现有恢复流程。

`tools/run-reviewer-shard.mjs` / `npm run run:reviewer-shard` 是 scheduler CLI 入口：

- 从 workflow state 中读取最新 split plan，默认执行第一个 pending shard，也可用 `--shard-id` 指定。
- 默认 executor 为项目内 `agent_invocation` reviewer adapter。
- 成功后写回 workflow state；最后一个 shard 完成时自动写入 aggregate。
- `--all` 会在安全上限内连续消费 pending shard，直到生成 aggregate、无 pending shard，或 provider health recovery fact 被写入。
- `--max-shards` 是 `--all` 的硬上限，避免调度器因为异常 split plan 无限循环。
- `--all` 默认用于无显式 `--shard-id` 的自动推进；如果传入 `--shard-id`，runner 只执行指定 shard 后返回，避免人工指定范围被扩大。
- `--record-provider-health` 打开后，runner 遇到 `category=reviewer_timeout` 的 shard finding 必须写入 `reviewer_provider_health`。
- 如果没有传 `--provider-smoke-status`，provider health 进入 `needs_smoke_check`，scheduled action 为 `provider_smoke_check`。
- 支持 `--mock-findings-json` / `--mock-status`，用于确定性流程测试，不触发真实外部模型。
- `--run-artifact-output` 写出 `reviewer-shard-loop-run.v1` envelope，包含输入 workflow state、runner 参数、runs、aggregate/provider health 停止点和输出 workflow state。
- 输入不可读或 shard 不可执行时非零退出。

`reviewer-shard-loop-run.v1` 是 scheduler replay artifact：

- artifact run/cycle identity 必须与输入和输出 workflow state 一致。
- `phase=aggregated` 时 aggregate 必须无 pending shard。
- `phase=provider_health_recorded` 时必须包含 provider health fact。
- pass artifact 必须包含输出 workflow state，供后续 closeout/continuation 复用。

`tools/prepare-reviewer-shard-loop-continuation.mjs` / `npm run prepare:reviewer-shard-loop-continuation` 是 artifact 复用入口：

- 只接受通过 validation 的 `reviewer-shard-loop-run.v1`。
- 只把 pass artifact 转成 continuation input。
- continuation input 必须包含 `project_status.project=ai-control-platform`、`run_evaluation.source=reviewer-shard-loop-run.v1` 和 artifact 输出 workflow state。
- 失败 artifact、版本错误或 identity drift 必须非零退出，不能生成半可信 continuation input。

## 7. 工作台状态

`summarizeReviewerGate` 输出工作台可展示状态：

- provider / model。
- pass/fail 状态。
- finding 总数、失败数、rollback 数、human 数。
- max severity。
- `recommended_decision_signal`：`pass`、`rerun`、`rollback` 或 `human_intervention`。
- `reviewer_provider_health`：最近一次 provider health、retry strategy 和 next action。
- `reviewer_scope_split`：最近一次 split plan 的 shard_count、pending_shards 和 next_shard。
- `reviewer_shard_review`：最近一次 shard aggregate 的 completed_shards、pending_shards、failed_finding_count。

工作台不直接展示“某个 skill 被调用了”，而展示“本轮是否经过外部 LLM Reviewer Gate、审查模型是谁、发现了什么、建议调度器下一步做什么”。
