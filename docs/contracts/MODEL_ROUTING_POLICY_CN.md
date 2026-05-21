# 多 LLM 协同与模型路由合同

状态：draft
宿主：`ai-control-platform`

## 1. 目标

中台不应固定使用某一个最高级模型，也不应把 Claude+DeepSeek 当作临时人工习惯。模型选择必须成为可审计、可测试、可展示的调度策略。

本合同定义三类模型能力：

| 模型 | 成本 | 准确度 | 默认用途 |
| --- | --- | --- | --- |
| `gpt` | high | very_high | 高风险规划、平台核心实现、复杂架构、最终仲裁 |
| `deepseek-v4-pro` | medium | high | 独立审查、代码审计、第二意见、中高风险推理 |
| `deepseek-v4-flash` | low | medium | 路由分类、摘要、低风险批量检查、回归信号预筛 |

## 2. 路由输入

`selectModelForTask` / `buildModelCollaborationPlan` 的输入至少包含：

| 字段 | 含义 |
| --- | --- |
| `goal` / `requirement` / `summary` | 任务目标 |
| `stage` | `intake`、`classification`、`planning`、`implementation`、`review`、`recovery` 等 |
| `risk` | `low`、`medium`、`high`、`critical` |
| `budget_tier` | `low`、`medium`、`high` |
| `host` | `platform_core`、`managed_project` 或 `integration_adapter` |
| `tags` | `architecture`、`independent_review`、`boundary_sensitive` 等 |

## 3. 默认选择规则

- 低风险分类、摘要、批量预筛：优先 `deepseek-v4-flash`。
- 独立审查、代码审计、第二意见：优先 `deepseek-v4-pro`。
- 高风险平台核心实现、Recovery、架构、最终仲裁：优先 `gpt`。
- 高风险任务必须加入独立 reviewer；当 primary 是 `gpt` 时，reviewer 默认 `deepseek-v4-pro`。
- 当 primary 是 `deepseek-v4-pro` 且任务仍是高风险 review 时，加入 `gpt` 作为 arbiter。
- 预算不足时可以降级，但必须记录 `preferred_model`、`selected_model` 与 `downgraded_for_budget`，不能静默降级。

## 4. 与 Reviewer Gate 的关系

`llm-reviewer-gate` 负责把外部审查请求和 findings 结构化；`model-router` 负责决定是否需要 reviewer、用哪个 reviewer、是否需要 arbiter。

工作流：

```text
Context Pack
-> model-router 生成 collaboration plan
-> 主模型或子进程执行
-> reviewer gate 按 plan 发起只读审查
-> findings 写入 run manifest
-> autonomous-run 决定 pass/rerun/rollback/human_intervention
-> Ops Workbench 展示 model routing 与 reviewer gate 状态
```

## 5. 工作台展示

`summarizeModelRouting` 输出：

- selected model 与 preferred model。
- role count。
- 每个模型承担的角色数量。
- 是否有 independent reviewer。
- 是否有 arbiter。

工作台应让用户看到“为什么这次用了便宜模型/高准确模型/双模型审查”，而不是只看到某个 agent 名称。
