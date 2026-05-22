# 自主开发流程合同

状态：draft
宿主：`ai-control-platform`

## 1. 目标

建立一个让 AI 项目组在低人工介入下持续推进的流程：主进程负责流程设计和评审，子进程负责受限落地，系统负责门禁、状态、恢复和证据固化。

## 2. 标准循环

```text
用户需求
-> 宿主边界判定
-> Context Pack
-> 子任务拆解
-> 子进程实现
-> 主进程评审
-> 不合格则回退/修 gate/重跑
-> 合格则合并/发布/固化流程
```

固定职责：

- 主进程负责目标判断、任务拆解、Context Pack、调度、验收、流程修正和下一轮 continuation。
- 子进程负责受限实现，只能写 Context Pack 声明的 owned files，并在完成后自评需求是否跑偏、结果是否符合预期、证据是否足够。
- 主进程验收必须同时检查子进程自评、host-boundary、global-goal completion、process-hardening、durable 状态和 workbench continuation。
- 文档合同和 AGENTS 是压缩恢复入口；`run_context_work_packages` 是调度执行点，必须在执行前运行 fixed-development-mode runtime gate。
- 不合格时先把失败固化为不变量、gate、schema、测试、fixture 或 workbench projection，再重跑；不得只补一句流程总结。

## 3. 宿主边界

| 分类 | 含义 | 允许落点 |
| --- | --- | --- |
| `platform_core` | 中台本体能力 | `ai-control-platform` |
| `managed_project` | 被纳管业务项目功能 | 对应业务项目 |
| `integration_adapter` | 平台与业务项目之间的适配 | 双方明确 owns files 后执行 |

平台本体能力包括：Ops Workbench、任务 DAG、agent 调度、Recovery Engine、LLM Reviewer、CI/CD 门禁、周期体检、代码地图和流程治理。

## 4. Context Pack 必填项

- 原始需求摘要。
- 宿主分类和目标仓库。
- 非目标和禁止动作。
- owned files 或允许写入范围。
- 依赖能力成熟度。
- 子进程输入。
- 评审标准。
- 回退条件。

## 5. 主进程评审

主进程必须检查：

- 文件是否写在正确宿主。
- 是否遵守 owned files。
- 是否把 scaffold/partial 能力冒充 production。
- 是否通过测试、构建、registry、视觉或服务验收。
- 是否需要回退和重跑。
- 子进程是否给出跑偏评估和结果符合预期评估。
- 是否留下可压缩恢复的 durable 状态、run/artifact/task DAG 证据和下一轮 continuation。
- `run_context_work_packages` artifact metadata 或 blocked issues 中是否包含 fixed-development-mode runtime gate 结果。

## 6. 代码化要求

成功流程必须沉淀到以下至少一类：

- gate 代码。
- JSON schema。
- 测试。
- generator/template。
- Workbench 可见状态。

仅写入总结文档不算完成。

## 7. 压缩恢复和禁止事项

上下文压缩、新会话或工作台恢复后，必须先读取 `AGENTS.md`、`PROCESS.md`、`PROJECT_RULES.md`、`PROJECT_STATUS.json` 和本合同，再从 durable 状态继续。恢复依据包括当前 phase、global_goals、next_step、Context Pack seed、run manifest、artifact ledger、task DAG、review findings、process-hardening items 和 workbench next_action_readout。

恢复入口和运行时拦截的关系：doc-lint/字符串测试只能证明规则仍在仓库中；fixed-development-mode runtime gate 必须在 dispatchable work packages 执行前检查平台宿主、`target_project_id`、Context Pack root `owned_files`、`context_pack.subtasks[*].owned_files`、selected work package `owned_files`、subtasks/work_packages 是否存在，以及任一 owned file 是否误指向 `stock_dashboard`、`lobechat` 等 managed project 路径。gate 失败时必须 blocked closed，不能写 completed 状态。

禁止事项：

- 禁止主进程绕过调度/验收闭环直接实现平台本体能力。
- 禁止子进程扩大 owned files、修改未授权业务项目或把 managed project 当作平台宿主。
- 禁止用聊天上下文、临时日志或单模型输出替代 durable 状态。
- 禁止在 pending global goals、next work packages 或可执行 continuation 存在时声明整体完成。
- 禁止多模型协同绕过 model routing plan、reviewer gate、provider health、预算和只读审查策略。
