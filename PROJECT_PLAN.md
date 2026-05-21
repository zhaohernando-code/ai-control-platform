# AI Control Platform Plan

## 目标

建立一个能约束大模型不跑偏、尽量减少人工介入、并能自我评估和重跑的 AI 开发中台。

## P0：防跑偏基座

1. 建立独立仓库和 workspace 路由。
2. 固化宿主边界 gate：平台本体、被纳管项目、集成适配。
3. 固化 Context Pack 模板：目标、非目标、宿主、owned files、禁止动作、验收门禁。（已落地 `src/workflow/context-pack.js`）
4. 固化主进程评审循环：设计流程 -> 子进程落地 -> 主进程评估 -> 回退/调流程/重跑。（已完成首轮自试运行评估）
5. 把本次 `stock_dashboard` 偏移作为反例测试。
6. 固化项目 onboarding/config 同步 gate，防止新增项目后 `WORKSPACE_INDEX.json`、根级入口文档、hook 路由和控制面路由测试没有同步。

## P1：流程产品化

1. 任务 DAG 与 work package 模型。
2. Durable requirement/artifact ledger。
3. Lock domain 推断器。
4. LLM Reviewer 合同与多模型路由策略。
5. Recovery Engine MVP。
6. 将 `legacy/stock-dashboard-autonomous-flow` 中迁移来的平台试验代码重构为平台中立模块。

优先顺序：

1. 把本轮评估文档升级为机器可读 run manifest。（已落地 `src/workflow/run-manifest.js`）
2. 将 `autonomous-run` 的 `next_work_packages` 接入任务 DAG。（已落地 `src/workflow/task-dag.js`）
3. 建立 artifact ledger，保存需求、Context Pack、patch、测试、reviewer 和评估证据。（已落地 `src/workflow/artifact-ledger.js`）
4. 建立 goal guard，保证整体目标、宿主和 changed files 不跑偏。（已落地 `src/workflow/goal-guard.js`）
5. 建立 LLM reviewer gate 与 model router，让 GPT / DeepSeek V4 Pro / DeepSeek V4 Flash 按任务风险和成本协同。（已落地 `src/workflow/llm-reviewer-gate.js`、`src/workflow/model-router.js`）
6. 再接入 Ops Workbench projection，而不是先做孤立 UI。（已落地 `src/workflow/workbench-projection.js`）
7. 建立 autonomous continuation gate，防止完成一轮后停在总结等待用户继续。（已落地 `src/workflow/autonomous-continuation.js`）

## P2：Ops Workbench

1. PC Web 单页工作台。（static shell 已落地）
2. 手机独立工作台。（static shell 已落地）
3. 能力成熟度、风险、自愈、人工决策统一视图。
4. 真实项目接入和周期体检。
