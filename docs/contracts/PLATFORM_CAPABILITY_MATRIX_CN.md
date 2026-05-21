# 平台基座能力矩阵

更新时间：2026-05-20

本矩阵用于约束后续平台基座开发。它不是功能宣传页，而是真实能力标注：看到已有页面、字段、脚本、测试或 watchdog 逻辑，只能说明存在底座，不能自动推断已经满足目标需求。

## 成熟度定义

| 等级 | 含义 | 后续使用规则 |
| --- | --- | --- |
| `none` | 没有可依赖实现 | 只能先做设计和建模 |
| `scaffold` | 有字段、页面、脚本或概念占位 | 不能作为调度、验收或自动化依赖 |
| `partial` | 局部链路可用，但边界、状态或恢复不完整 | 可继续迭代，但必须显式声明缺口 |
| `usable` | 单一场景可稳定使用，有测试或运行证据 | 可以作为后续任务依赖，但仍需记录限制 |
| `production` | 多场景长期稳定，有门禁、监控、恢复和真实入口验证 | 可作为平台基座默认能力 |

## 当前能力总览

| 能力 | 当前等级 | 主要证据 | 关键缺口 | 下一步 |
| --- | --- | --- | --- | --- |
| Ops Workbench 中台 | `partial` | `dashboard-ui` 已有项目/任务/审批/usage/watchdog 页面；设计稿已拆为 PC 与手机入口 | 仍是项目/任务工作区，尚未实现成熟工作台的信息架构：总览、任务流、Agent 池、风险、待人工决策未统一成单页 Ops Workbench | 基于 `docs/design/ops-workbench-visual.html` 与 `docs/design/ops-workbench-mobile.html` 重构 dashboard 首页 |
| 项目目录与运行态登记 | `usable` | `WORKSPACE_INDEX.json`、`state-store.js` 的 `projects` 表、`project-local-runtime.js`、worker tunnel 同步 | 对项目健康、发布入口、运行时漂移还缺少统一项目健康模型 | 增加 project health snapshot，供中台总览读取 |
| 需求与任务入口 | `usable` | `task-domain.js`、`task-runtime.js` 支持 `task`、`project_create`、`composite_task`、审批计划和 acceptance criteria | 需求版本、关键输入、批准版本尚未形成不可变 artifact | 建立 requirement/artifact contract，任务创建时硬存储原始需求和批准计划 |
| 任务 DAG 与拆解 | `partial` | `project-flow.js`、`plan-runtime.js`、`task_children`、parent/child task 字段 | 仍偏项目创建 flow 和组合任务路由，缺少通用 DAG 节点、依赖、ownership、aggregator 决策模型 | 设计 `work_packages` / `dependencies` / `aggregation_result` 结构 |
| 调度锁与并行 | `partial` | `worker-runtime.js` 有 `maxConcurrency`、`control_plane`、`task:<id>` resource locks；控制面项目串行 | 锁粒度还不够：缺少 path/runtime/db/launchd/edge/publish 等冲突域自动推断 | 增加 lock domain 推断器，并把锁写入 task brief 和 workflow gate |
| Worker 执行与隔离 worktree | `usable` | `workspace-runtime.js`、`local-worker.js`、`workflow-gates.js`、README 明确 isolated worktree 与 closeout | 对多 agent DAG 的分工、汇总和冲突调停还不完整 | 保持当前能力作为执行底座，补 DAG ownership 与 aggregator |
| 多模型路由 | `partial` | `task-domain.js` 解析模型，`local-worker.js` 为 DeepSeek/Claude 兼容环境设置变量，dashboard 创建任务可选模型 | 缺少按角色、成本、准确度、上下文窗口和失败重试策略的统一路由器 | 增加 `model_profiles` 与 role-based routing policy |
| Watchdog / Recovery | `scaffold` | `config-runtime.js` 中 watchdog 实际是开关且默认关闭；`watchdog-runtime.js` 有历史 review/remediation 逻辑；`execution-runtime.js` 有少量 stale blocked recovery | 过去实践中看护结果质量差，不能作为 Recovery Engine 底座；缺少统一 `retryable / repairable / needs_review / human_required` 分类、确定性动作、验证和恢复状态机 | 重新设计独立 Recovery Engine；watchdog 只作为历史样本、临时观察器和反例库 |
| 状态存储与事件 | `partial` | `state-store.js` 有 SQLite WAL、`task_events`、`jobs`、`task_logs`、verification results；`task-lifecycle.js` 可追加 task event | `task_events` 还不是唯一状态迁移真值，需求、计划、模型输出、review、发布证据缺少不可变 artifact ledger | 建立 event-sourced task state 和 artifact ledger |
| 发布与真实验收 | `partial` | `.codex.deploy.json`、`publish-runtime.js`、`verification-gate-runtime.js`、`workflow-gates.js` 支持发布、健康检查和 closeout evidence | 还不是企业级统一 CI/CD；安全、secret scan、contract、visual smoke、live verify 没有统一声明和强制结果模型 | 定义 `.codex.deploy.json` v2 门禁 schema，并把结果写入 verification evidence |
| LLM Reviewer | `scaffold` | watchdog 有 review prompt；DeepSeek/外部模型可被调用；流程文档要求 reviewer | 缺少独立 reviewer runtime、结构化 findings、规则库、阻塞策略和二审记录 | 新建 reviewer contract：severity/file/line/rule/evidence/suggested fix |
| 周期项目体检 | `scaffold` | usage/anomalies、watchdog、项目状态文件已有基础数据；plan 中已有日/周/月体检方向 | 没有定时 job、检查维度、报告格式、趋势存储和风险升级规则 | 设计 periodic inspection job 与 risk report artifact |
| 快速定位 skill / 代码地图 | `scaffold` | `WORKSPACE_INDEX.json` 能做项目级路由；根级规则要求固定入口 | 还没有 `file -> domain -> owner -> tests -> route -> failure` 代码地图，也没有 skill 输出协议 | 生成项目级 `CODEMAP.json`，再封装定位 skill |
| 前端设计门禁 | `scaffold` | `CODEX.md`、`KNOWN_TRAPS.md`、设计稿与 PROCESS 已固化 PC/手机分稿和视觉 QA 规则 | 规则仍是文档约束，尚未进入任务创建、reviewer 或 CI visual smoke | 在任务创建和 reviewer 中增加 `design_required` 判定与视觉 QA checklist |
| 人工介入模型 | `partial` | approval plan、pending action、watchdog external dependency、dashboard approval card 已存在 | 没有统一介入分类和“系统自愈 vs 人工决策”的中台分层视图 | 建立 intervention taxonomy，并在 Ops Workbench 风险/决策区展示 |

## 当前结论

1. 当前最强的底座是：任务入口、worker 执行、隔离 worktree、基础发布、workflow closeout 和 SQLite 状态。
2. 当前最容易被误判为“已经完成”的能力是：中台、任务 DAG、recovery、CI/CD、reviewer、周期体检和快速定位 skill。
3. 后续开发不能在现有 dashboard 卡片和后端 task 字段上继续补丁式堆叠；涉及平台基座能力时，必须先明确领域模型、状态真值、状态迁移、失败恢复、测试和中台可观测面。

## P0 落地顺序

1. 把本矩阵接入中台治理页，只显示真实成熟度和缺口。
2. 新任务 brief 引用相关能力项，禁止把 `scaffold` / `partial` 表述成已完成。
3. 为 `task DAG`、`recovery`、`artifact ledger`、`reviewer` 分别补最小 contract，再进入实现。Recovery 必须重设计，不从现有 watchdog 继续堆叠。
