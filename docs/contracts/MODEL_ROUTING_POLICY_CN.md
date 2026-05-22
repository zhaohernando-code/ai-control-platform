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
- 当出现 `codex_plan_pressure` / `plan_budget_pressure` 或平台流程门禁任务时，必须前置 `deepseek-v4-pro` 的 `process_guard` 角色，用于在 GPT 消耗实现/仲裁预算前审查流程偏移、replay 安全和 gate 完整性。
- 预算不足时可以降级，但必须记录 `preferred_model`、`selected_model` 与 `downgraded_for_budget`，不能静默降级。

## 4. 与 Reviewer Gate 的关系

`llm-reviewer-gate` 负责把外部审查请求和 findings 结构化；`model-router` 负责决定是否需要 reviewer、用哪个 reviewer、是否需要 arbiter。

DeepSeek reviewer 调用必须同时生成 invocation policy，而不是只保存“超时了”：

- Anthropic 兼容入口固定记录为 `https://api.deepseek.com/anthropic`。
- Claude Code 运行模型记录为 `deepseek-v4-pro[1m]`，低成本子进程模型记录为 `deepseek-v4-flash`。
- DeepSeek 官方说明在等待期间可能通过流式 SSE keep-alive 或非流式空行保持连接；10 分钟未开始推理服务端才会关闭连接。因此中台 wrapper 超时不能随意设为 120 秒的全局常量。
- `process_guard` 默认使用 300 秒 timeout、`high` effort、最多 3 个文件 / 3 个问题 / 2200 字 prompt；超过上限时必须拆分 review，而不是扩大单次上下文。
- `full_audit` 可使用 600 秒 timeout 和 `max` effort，但仍必须有文件、问题、prompt 上限。
- reviewer 超时后不能立即判定 DeepSeek 不可用；必须先运行无工具 smoke prompt。smoke 通过时优先无工具重试或拆分文件复审，smoke 失败时才把 provider 标记为 unhealthy 并切换 fallback。
- 手动 `./start-claude-deepseek-no-proxy.sh` 默认是交互模式；平台 reviewer wrapper 使用同一个 launcher，但额外启用 `--bare -p --no-session-persistence --tools --add-dir`。任何健康诊断都必须区分“provider 通道可用”和“非交互工具审查路径卡住”。

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

## 5. Context Work Package 执行 Adapter

`run_context_work_packages` 的 provider/model-routed 执行必须挂在 fixed-development-mode dispatch gate 后面：

- 先校验 Run Manifest、Task DAG 和 fixed-development-mode gate。
- gate 通过后，才允许选择 execution adapter/profile。
- 默认 `local_bounded` 路径继续保持本地有界执行，不调用外部模型。
- `local_bounded` completion 只允许在调用方没有显式执行身份时发生，或所有显式执行身份字段都为 `local_bounded` 时发生。显式 `execution_profile`、`adapter_profile`、`executor_profile`、非 local `executor_kind`、非 local/provider-like `execution_mode` 不能被默认 local fallback 消化。
- 显式请求 provider/model-routed mode 时，必须提供已注册的 `execution_profile`；缺失或未知 profile 必须 blocked closed，不能把 work package 标为完成。
- `bounded_mock_multi_agent`、`deterministic_mock_multi_agent` 以及任何 mock/simulation 类 execution token 都是非完成证据；即使调用方漏传 `execution_mode=provider_model_routed`，也必须进入 blocked/validated non-completing 路径，不得写 completed。
- 当前平台内置的 deterministic profile 是 `bounded_mock_multi_agent`。它只生成模型路由计划和模拟校验结果，`external_calls=0`，用于测试和工作台试跑；它没有 completion authority，不能作为 work package 完成证据。
- 当前真实 provider seam profile 是 `verified_provider_multi_agent`。它不在 adapter 内直接调用网络或模型；真实 GPT/DeepSeek/Claude 后续必须通过 runner/server 注入的 executor 函数接入。
- `verified_provider_multi_agent` 缺少 executor 时必须 blocked closed；executor 只能来自 `runContextWorkPackages` / `createWorkbenchServer` 的配置选项，不能从 `/api/workbench/context-work-packages-run` 或 `/api/workbench/next-action` 的 HTTP body 注入。
- 当前默认真实 executor 是 `claude_deepseek_provider_executor`，由 `context-work-package-provider-executor` 通过 Claude+DeepSeek wrapper 命令启动。它必须记录 bounded timeout、model、tools/no-tools、cwd、prompt file、wrapper script、budget、effort、command runner kind 和外部调用次数；生产默认路径只能使用真实 `spawn_sync` command runner 或不含 fake/test/mock/simulation/local/deterministic token 的外部 provider runner。
- `run:context-provider-trial` 是 bounded provider trial 入口：它读取 workflow_state JSON，固定请求 `verified_provider_multi_agent`，通过 runner options 注入 provider executor，写出 `context-work-package-provider-trial.v1` artifact；测试 fake command runner 必须标识 `fake_test_command_runner`，不得伪装成生产默认 provider 路径，也不得具备 completion authority 或写 workflow output。
- 真实 executor 的返回必须经 adapter 标准化：顶层 `status=pass`、每个 selected package result `status=pass`、合法外部 provider call provenance、顶层和 package completion evidence 全部存在时，adapter 才能合成顶层与 package result 两层 completion authority。
- 缺少 external-call provenance、completion evidence、package result，executor provenance 指向 local/mock/simulation，`command_runner_kind` 含 fake/test/mock/simulation/local/deterministic，或真实命令失败/超时/返回非结构化输出且没有后续合法 structured fallback pass 时，真实 profile 只能返回 blocked/fail non-completing 结果，不得写 `work_packages[].status=completed`。
- `run:context-provider-trial` 的 provider executor 必须支持 bounded fallback attempt：默认 primary model 是 `deepseek-v4-pro[1m]`，当 primary provider command timeout，或 primary command 退出码为 0 但输出无法解析为结构化 JSON（例如 `<bash>...</bash>`）时，低风险/no-tools smoke 可以自动重试 `deepseek-v4-flash`，CLI 可用 `--fallback-model` 显式覆盖。fallback 只允许发生在 provider timeout 或可恢复非结构化 provider 输出后；普通命令失败、provenance 不合规不能靠 fallback 静默转 pass。
- provider trial artifact 必须记录 `provider_attempts` 或等价结构：每次 attempt 的 model、timeout、`command_runner_kind`、status、issue、external call count、是否 timeout、以及是否写入 workflow output。只有最终 successful attempt 且 adapter provenance validation 合规时，runner 才能写 workflow output；Pro timeout attempt 本身不得产生 completed。
- fallback 不改变完成授权规则：如果 primary timeout 后 fallback attempt 使用 fake/test/mock/simulation/local/deterministic `command_runner_kind`，adapter 仍必须 blocked/non-completing，trial artifact 只能作为证据，不能写 workflow output。
- provider/model-routed adapter 必须在顶层结果和每个 package result 上显式声明 `completion_authority` / `allows_work_package_completion`。runner 只能使用两层都具备完成授权且 `status=pass` 的 package result 写 completed。
- non-completing profile 必须返回 `validated` / `simulated_execution` 语义，暴露 execution plan、package results、executor provenance 和 issues 供工作台展示，但不得返回 `workflow_state` 或 pass completion artifact。
- 真实 GPT/DeepSeek/Claude provider adapter 后续只能挂在同一接口后，不得绕过 fixed-development-mode gate 或直接写业务项目状态。

provider/model-routed artifact metadata 必须包含：

- `execution_mode` / `execution_profile`。
- `package_results`，且只有具备 completion authority 的 `status=pass` package result 可以驱动 work package 完成。
- `executor_provenance`，至少记录 adapter id/version、executor kind、是否 deterministic、外部调用次数。
- `completion_authority`，说明完成授权来源、证据类型和是否允许写 completed。
- `model_routing`，按 work package 记录 `buildModelCollaborationPlan` 产生的 roles、reasons、budget、risk、selected/preferred model 和 guardrails。

## 6. 工作台展示

`summarizeModelRouting` 输出：

- selected model 与 preferred model。
- role count。
- 每个模型承担的角色数量。
- 是否有 process guard。
- 是否有 independent reviewer。
- 是否有 arbiter。

工作台应让用户看到“为什么这次用了便宜模型/高准确模型/双模型审查”，而不是只看到某个 agent 名称。
