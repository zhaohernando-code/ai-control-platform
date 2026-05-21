# DECISIONS

[2026-05-21T15:20:00+08:00] Create standalone AI Control Platform repository:
新中台不再继续落在 `stock_dashboard`、`local-control-server` 或 `dashboard-ui` 任一旧仓作为默认宿主。创建独立仓库 `ai-control-platform`，用于承载平台本体设计、流程合同、宿主边界 gate、任务 DAG、Recovery Engine、LLM Reviewer、CI/CD 门禁和 Ops Workbench。

原因：
- 既有设计稿已经表达“新中台/平台基座”，但执行层仍被错误路由到 `stock_dashboard`。
- 旧控制面后端和前端存在底座，但继续补丁式扩展会扩大边界混乱。
- 新中台本身就是后续所有项目开发流程的技术实践，必须有独立宿主和机器门禁。

决策：
- `ai-control-platform` 是平台本体默认宿主。
- `local-control-server` 与 `dashboard-ui` 是可迁移组件，不是新能力默认落点。
- `stock_dashboard` 是被纳管项目和反例 fixture，不再承载平台能力。

[2026-05-21T15:45:00+08:00] Platform intent overrides cwd/default hook routing:
会话 cwd、历史线程、默认 hook 或 init skill 可能把任务错误路由到 `stock_dashboard` 等业务项目。后续平台类请求必须以用户文本中的强平台意图为准：只要命中“新中台、中台、自动化平台、平台基座、任务编排、Recovery Engine、LLM Reviewer、CI/CD 门禁、跨项目体检”等平台本体语义，就覆盖 cwd 路由到 `ai-control-platform`。

本轮根级 `agent-workflow-guard` 已加入回归：即使 cwd 位于 `stock_dashboard` worktree，明确的新中台请求也会解析到 `ai-control-platform`。

[2026-05-21T16:05:00+08:00] Migrate current-session platform work into the new platform repo:
当前会话中已经产生的中台相关材料统一迁入 `ai-control-platform`。正式设计、能力矩阵、Recovery 重设计和自主开发流程进入 `docs/contracts/`；视觉稿进入 `docs/design/`；错误落在 `stock_dashboard` 的 autonomous-flow 试验文档、registry、源码和测试进入 `docs/migrations/` 与 `legacy/`，作为后续平台中立重构输入。

同时把“新项目创建后配置不同步”列为 P0 门禁：新增项目必须同步 `WORKSPACE_INDEX.json`、项目 canonical docs、根级入口文档、hook 路由回归和控制面路由回归。该检查已经有 `project-onboarding-sync` gate 和 `npm run check:onboarding`。
