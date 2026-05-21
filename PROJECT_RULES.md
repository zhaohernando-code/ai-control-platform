# AI Control Platform Rules

- 本仓库是新中台平台本体的唯一默认宿主。
- 任意包含“中台、平台、控制面、任务编排、多 agent、自动恢复、LLM reviewer、CI/CD 门禁、跨项目体检、工作台总览”的需求，默认路由到本仓库，除非用户明确指定旧组件仓或业务项目。
- `stock_dashboard`、`lobechat` 等业务项目只能作为被纳管项目、fixture、验收样本或集成适配对象；不得承载平台本体能力。
- 旧 `local-control-server` 和 `dashboard-ui` 可以被读取、迁移或重构，但不能继续作为新能力的默认补丁落点。
- 开工前必须生成或更新 Context Pack，并通过 `host-boundary` gate。未通过时不得派发子进程、不得写代码。
- 每一轮实现必须包含：流程设计、子任务落地、主进程评审、失败回退或重跑、流程固化。
- 前端相关任务默认同时覆盖 PC Web 与手机尺寸；手机端可以独立信息架构，不得默认压缩 PC 页面。
- 用户可见功能完成前必须有真实渲染或服务验收；只通过源码或静态文档不算完成。
- 重要决策写入 `DECISIONS.md`，可复用流程经验写入 `PROCESS.md`，当前状态写入 `PROJECT_STATUS.json`。

