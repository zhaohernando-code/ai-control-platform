# Autonomous Run Evaluation 合同

状态：draft
宿主：`ai-control-platform`

## 1. 目标

`src/workflow/autonomous-run.js` 提供平台中立的自主运行评估基座。它只接收机器可读的 run 结果，不依赖业务项目、GitHub、CI 厂商或具体执行器，用于把一次子进程运行归约为后续调度可执行的决策。

标准输入需要能表达：

- `run_id`、`cycle_id`。
- `work_packages`：本轮派发的工作包、执行状态、负责人或 agent。
- `artifacts`：补丁、文档、构建物、发布物等证据状态。
- `gate_results`：host boundary、owned files、测试、构建、发布验收等门禁结果。
- `review_findings`：主进程或 LLM reviewer 的结构化发现。
- `recovery_attempts`：已经自动重跑、修复或回退的历史尝试。

标准输出包含：

- `status` / `decision`：`pass`、`rerun`、`rollback`、`human_intervention`。
- `reasons`：可展示给工作台和后续调度器的原因列表。
- `next_work_packages`：下一轮自动执行的工作包建议。
- `projection`：工作台可直接消费的运行摘要。

## 2. 决策原则

决策优先级从高到低为：

1. `human_intervention`：只在自动化不应继续推进时触发，包括破坏性动作需要人工确认、凭据或密钥缺失、需求互相冲突、连续恢复失败达到阈值，或门禁 / reviewer 明确标记 `requires_human`。
2. `rollback`：用于可以自动回退的严重失败，包括 host boundary、owned files、严重 reviewer 发现、安全或数据损坏类失败。回退后调度器应生成干净上下文再重跑。
3. `rerun`：用于普通测试失败、构建失败、非严重 reviewer 失败、artifact 生成失败或工作包未完成。它不会等待人工，而是把失败证据带入下一轮工作包。
4. `pass`：所有工作包、证据、门禁和 reviewer 结果都通过。

核心约束是“不把普通失败卡成人工等待”。测试失败、reviewer 普通失败和 artifact 失败应进入 `rerun` 或 `rollback`，只有自动系统缺少安全前提或已经连续失败时才进入 `human_intervention`。

## 3. 工作台 Projection

`summarizeWorkbenchProjection` 将 run 结果和 decision 汇总为工作台状态：

- 当前 `run_id`、`cycle_id`、`status`、`decision`。
- `summaries`：工作包、artifact、gate、review finding、recovery attempt 的 total / passed / failed / unknown 计数。
- `current_work_packages`：本轮工作包的 id、标题、owner。
- `next_work_packages`：调度器可以继续派发的下一轮建议。
- `recovery`：连续恢复失败次数、最后一次恢复尝试 id 和状态。
- `blockers`：只有人工介入时才表示自动系统不能自行解除的阻塞项。

工作台不需要理解业务项目细节，只展示 run 的决策、证据计数和下一步动作；具体执行器再根据 `next_work_packages` 映射到任务队列、CI job 或子进程调用。

## 4. 后续调度接入

调度器的最小接入流程：

```text
子进程 run 完成
-> 收集 work_packages / artifacts / gate_results / review_findings / recovery_attempts
-> evaluateRunResult
-> 写入工作台 projection
-> status=pass：进入合并、发布或流程固化
-> status=rerun：派发 next_work_packages，保留失败证据
-> status=rollback：先执行回退工作包，再用干净上下文重跑
-> status=human_intervention：暂停自动推进，只暴露 blockers 和人工所需信息
```

这个模块不执行回退、不启动测试、不读写仓库，也不发布结果。它只负责做可复用、可测试、平台中立的 evaluation / recovery decision。
