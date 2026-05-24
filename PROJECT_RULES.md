# AI Control Platform Rules

- 本仓库是新中台平台本体的唯一默认宿主。
- 任意包含“中台、平台、控制面、任务编排、多 agent、自动恢复、LLM reviewer、CI/CD 门禁、跨项目体检、工作台总览”的需求，默认路由到本仓库，除非用户明确指定旧组件仓或业务项目。
- `stock_dashboard`、`lobechat` 等业务项目只能作为被纳管项目、fixture、验收样本或集成适配对象；不得承载平台本体能力。
- 旧 `local-control-server` 和 `dashboard-ui` 可以被读取、迁移或重构，但不能继续作为新能力的默认补丁落点。
- 开工前必须生成或更新 Context Pack，并通过 `host-boundary` gate。未通过时不得派发子进程、不得写代码。
- 每一轮实现必须按固定开发模式执行：主进程负责目标判断、任务拆解、子进程调度、验收和流程修正；子进程只负责 Context Pack/owned files 授权内的受限实现。
- 每个子进程完成后必须自评需求是否跑偏、结果是否符合预期、证据是否足够；主进程必须把该自评纳入验收。
- 不合格结果必须先改流程不变量、gate、schema、测试或 workbench projection，再重跑；禁止只写普通总结或口头提醒。
- 上下文压缩或新会话恢复后，必须从 `AGENTS.md`、`PROCESS.md`、`PROJECT_STATUS.json`、global_goals、durable run/artifact/task DAG 状态和 workbench continuation 继续，不得依赖聊天记忆替代状态。
- 文档检查只证明恢复入口存在；`run_context_work_packages` 调度前必须通过 fixed-development-mode runtime gate，检查 Context Pack root/subtask/selected work package 的 `owned_files`，失败时不得把 work package 标记为 completed。
- 多模型协同必须经过 model routing plan、reviewer gate 和 durable findings/artifacts；禁止把某个模型或临时 skill 固定成绕过流程的默认实现者。
- 前端相关任务默认同时覆盖 PC Web 与手机尺寸；手机端可以独立信息架构，不得默认压缩 PC 页面。
- 用户可见功能完成前必须有真实渲染或服务验收；只通过源码或静态文档不算完成。
- Ops Workbench、任务 DAG、调度锁、事件源状态、Recovery Engine、LLM reviewer、CI/CD 门禁、周期体检和快速定位 skill 都是平台基座能力；开发前必须先明确领域模型、状态真值、契约、失败恢复、测试边界和操作员可观测面。
- 当前 watchdog 只能作为历史样本和临时观察输入，不能作为 Recovery Engine 底座。遇到自愈、恢复、错误卡死处理相关任务时，按独立 Recovery Engine 重新建模。
- 平台 UI 的目标形态是成熟 Ops Workbench，不是任务卡片集合。新增页面或字段前必须确认它服务于总览、任务流、agent 池、风险、人工决策、发布/验收证据中的哪一类。
- 重要决策写入 `DECISIONS.md`，可复用流程经验写入 `PROCESS.md`，当前状态写入 `PROJECT_STATUS.json`。
