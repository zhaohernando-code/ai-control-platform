# AI Control Platform Plan

## 目标

建立一个能约束大模型不跑偏、尽量减少人工介入、并能自我评估和重跑的 AI 开发中台。

## P0：防跑偏基座

1. 建立独立仓库和 workspace 路由。
2. 固化宿主边界 gate：平台本体、被纳管项目、集成适配。
3. 固化 Context Pack 模板：目标、非目标、宿主、owned files、禁止动作、验收门禁。
4. 固化主进程评审循环：设计流程 -> 子进程落地 -> 主进程评估 -> 回退/调流程/重跑。
5. 把本次 `stock_dashboard` 偏移作为反例测试。

## P1：流程产品化

1. 任务 DAG 与 work package 模型。
2. Durable requirement/artifact ledger。
3. Lock domain 推断器。
4. LLM Reviewer 合同。
5. Recovery Engine MVP。

## P2：Ops Workbench

1. PC Web 单页工作台。
2. 手机独立工作台。
3. 能力成熟度、风险、自愈、人工决策统一视图。
4. 真实项目接入和周期体检。

