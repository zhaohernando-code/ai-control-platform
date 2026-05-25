# Project Management Workbench 合同

状态：draft
宿主：`ai-control-platform`
上游设计：`docs/contracts/PLATFORM_FOUNDATION_DESIGN_CN.md`

## 1. 不变量

AI Control Platform 工作台的第一职责是管理项目，不是展示单次运行日志。PC / mobile 首屏必须先回答：

- 当前纳管了哪些项目。
- 每个项目处于哪个阶段。
- 当前任务是什么，交给哪个 Agent。
- 项目任务流从需求到验收运行到了哪里。
- 哪些风险或人工决策会阻塞项目继续推进。

运行诊断、projection id、scheduler、reviewer、artifact ledger、provider health 等信息只能作为支撑诊断层，不能取代项目列表和任务流成为首屏主语。

## 2. 当前必须纳管的项目

| project_id | 名称 | 类型 | 默认负责人 |
| --- | --- | --- | --- |
| `ai-control-platform` | AI Control Platform | platform | `main_orchestrator` |

只要本仓库仍在开发，工作台 projection 和前端 DOM 都必须包含 `ai-control-platform`。缺失该项目时，schema gate 和 frontend acceptance gate 必须失败。

## 3. 项目任务流

工作台必须展示完整生命周期：

`需求 -> 拆解 -> 子任务 -> Review -> 发布 -> Live 验证 -> 验收`

每个阶段至少包含 label、status 和 count。阶段状态可以来自 Task DAG、global goal、frontend acceptance、closeout 或发布证据，但不能用 raw manifest 字段列表替代。

## 4. Projection 责任

`createWorkbenchProjection` 必须输出 `project_management`：

- `projects_total` / `active_projects` / `tasks_total` / `active_tasks` / `released_services` / `human_decisions`
- `projects[]`：包含 `project_id`、`display_name`、`phase`、`current_task`、`owner_agent`、`progress`、`last_updated`、`task_flow`
- `active_work[]`：当前需要运营者关注的项目行
- `task_flow[]`：平台级生命周期摘要

`one_screen.counters` 可以复制这些计数供 UI 快速绑定，但不能作为唯一项目数据源。

## 5. Frontend Acceptance 责任

`tools/check-workbench-frontend-acceptance.mjs` 必须在真实浏览器 DOM 中验证：

- 桌面导航包含 `总览`、`项目`、`任务流`、`Agents`、`风险`、`治理`。
- PC 和 mobile 都显示项目列表、`AI Control Platform`、`ai-control-platform`、阶段、当前任务、Agent、进度和更新时间。
- PC 和 mobile 都显示完整项目生命周期。
- `运行诊断` 不能在主内容里早于项目列表出现。

上述任一条件失败时，frontend acceptance 必须生成 P0/P1 finding，并阻断 closeout。

## 6. 设计边界

`docs/contracts/WORKBENCH_PROJECTION_CN.md` 描述的是数据投影合同，不是页面产品需求。前端设计必须先遵守本合同和平台 foundation design，再把 projection 中的诊断字段映射到次级区域。
