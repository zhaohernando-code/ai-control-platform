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

## 5. 工作台状态

`summarizeReviewerGate` 输出工作台可展示状态：

- provider / model。
- pass/fail 状态。
- finding 总数、失败数、rollback 数、human 数。
- max severity。
- `recommended_decision_signal`：`pass`、`rerun`、`rollback` 或 `human_intervention`。
- `reviewer_provider_health`：最近一次 provider health、retry strategy 和 next action。

工作台不直接展示“某个 skill 被调用了”，而展示“本轮是否经过外部 LLM Reviewer Gate、审查模型是谁、发现了什么、建议调度器下一步做什么”。
