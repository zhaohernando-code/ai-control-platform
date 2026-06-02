# Frontend Migration Inventory (Step 1 / 7)

适用范围：AI Control Platform 项目（`apps/workbench` 工作台）。本文件是“需求：前端重构”
（requirement-unknown-20260526033003）第 1 步“盘点现状”的迁移基线清单，必须在每个切片
（Slice/PR）合入前被同步更新；过时清单导致 `test/workbench-shell.test.js` 中
`frontend migration inventory baseline is durable` 测试失败，从而阻塞合入。

迁移目标栈见 `apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md`：React + Next.js (App
Router) + Ant Design 唯一基础/布局组件库，原生 CSS 默认不保留。

## 1. 前端入口状态

| 入口 | 公开路径 | 说明 |
| --- | --- | --- |
| `apps/workbench/app/page.tsx` | `https://hernando-zhao.cn/projects/ai-control-platform/` | PC 工作台总览入口，Next.js App Router |
| `apps/workbench/app/requirements/page.tsx` | `https://hernando-zhao.cn/projects/ai-control-platform/requirements` | 手机和桌面共享的需求入口，Next.js App Router |

公开挂载由 Next.js `basePath = "/projects/ai-control-platform"` 接管；`tools/workbench-server.mjs`
只提供 `/api/workbench/*`。原生 `desktop.html` / `mobile.html` 入口已在 LFG-P6.4 删除。

## 2. 单页 App 视图（导航 Tab → 主面板）

旧 `desktop.html` 顶部 `nav.nav-list` 已由 Next.js App Router + antd `Menu` 接管。每个
原 Tab 对应的业务区必须保持单页 app 语义或等价路由语义：

| Tab (`data-workbench-tab`) | 锚点 | 含义 |
| --- | --- | --- |
| `overview` | `#overview` | 总览首屏，聚合任务流、Agents、运营 KPI、下一步动作 |
| `requirements` | `#requirements` | 新建任务（需求录入）与方案审核入口 |
| `projects` | `#projects` | 项目列表与生命周期 |
| `flow` | `#flow` | 任务流（Task Flow / DAG 摘要） |
| `agents` | `#agents` | Agent 池与活跃任务 |
| `risks` | `#risks` | 风险面板 |
| `governance` | `#governance` | 治理 / Closeout / 评审 |
| `runs` | `#runs` | 运行诊断（仅次级信息） |

旧 `mobile.html` 已删除；移动端由 Next.js 响应式/独立路由承载，不允许默认回退为 PC 缩放。

主要面板（panels / cards）：

- `hero-panel`（项目主语 hero 区域）
- `metrics`（核心计数：项目总数、活跃项目、活跃任务、运营事件等）
- `requirement-panel`（新建任务 + `requirement_intake` 列表）
- `plan-review-panel`（方案评估与审核）
- `project-panel`（项目列表 `project_rows`）
- `flow-panel`（`project_task_flow`）
- `agents` 面板（`project_agents`、`model_roles`）
- `governance` 面板（治理状态、Closeout、Snapshot）
- `runs` 面板（调度、模型、审查、Operator 时间线）

## 3. 静态资源

| 资源 | 用途 | 迁移期处理 |
| --- | --- | --- |
| `apps/workbench/styles.css` | 已删除的旧入口 CSS | ✅ LFG-P6.4 删除；样式由 antd token、组件 props 与 `app/globals.css` 浏览器基线接管。 |
| `apps/workbench/public/favicon.svg` | 站点 favicon | ✅ Next public 资源 |
| `apps/workbench/app/globals.css` | Next.js 全局基线（box-sizing + font smoothing） | ✅ 步骤 06/9 新建；仅承载 antd 无法覆盖的浏览器基线，不得扩写组件/布局样式 |
| `apps/workbench/desktop.html` | 已删除的 PC 入口 HTML | ✅ LFG-P6.4 下线 |
| `apps/workbench/mobile.html` | 已删除的手机入口 HTML | ✅ LFG-P6.4 下线 |

没有图片或外部字体依赖；不引入第三方 CDN。

## 4. 应用脚本 / 内联脚本

| 脚本 | 加载方式 | 角色 |
| --- | --- | --- |
| `apps/workbench/workbench.js` | 已删除的旧 DOM 渲染脚本 | ✅ LFG-P6.4 下线；渲染层迁入 `apps/workbench/app/**/*.tsx` |
| `apps/workbench/projection-source.js` | 已删除的旧 projection adapter | ✅ LFG-P6.4 下线；数据层迁入 `apps/workbench/lib/api/` |

旧 HTML 入口已下线，逻辑分别落到：

- 渲染层：`apps/workbench/app/**/*.tsx` 中以 React + antd 组件实现。
- 数据层：统一抽象到 `apps/workbench/lib/api/`，对接后文“后端接口契约”。

## 5. 后端接口契约（前端调用 → server 暴露）

前端 `projection-source.js` 与 `workbench.js` 通过相对路径访问以下接口，全部由
`tools/workbench-server.mjs` 在挂载前缀 `/projects/ai-control-platform/api/workbench/...`
下暴露；新 Next.js 客户端必须保持相同 path 与请求方法。

### 5.1 投影与状态读取

| 方法 | Path | 用途 |
| --- | --- | --- |
| GET | `/api/workbench/projection` | 一屏 projection（PC/mobile 渲染源） |
| GET | `/api/workbench/projections` | projection history 列表 |
| GET | `/api/workbench/snapshot?id=<id>` | 指定 snapshot 的 projection-ready workflow state |
| POST | `/api/workbench/snapshots` | 写入新 snapshot 并把 history latest 指向它 |

### 5.2 Operator 事件 / 状态写入

| 方法 | Path | 触发位置 |
| --- | --- | --- |
| GET | `/api/workbench/events` | 读取 operator event ledger |
| POST | `/api/workbench/events` | `data-action="validate"` / `data-action="next"` 等按钮 |
| POST | `/api/workbench/reviewer-provider-health` | `data-provider-health="pass\|timeout"` |
| POST | `/api/workbench/reviewer-shard-result` | reviewer shard 结果写回 |
| POST | `/api/workbench/agent-lifecycle-pool` | Agent 生命周期池写入 |

### 5.3 需求与方案审核

| 方法 | Path | 触发位置 |
| --- | --- | --- |
| POST | `/api/workbench/requirements` | `data-requirement-form` 中 `data-requirement-submit`（新建任务） |
| POST | `/api/workbench/plan-reviews` | `data-plan-review-action="approve\|revise"` |

### 5.4 调度与持续执行

| 方法 | Path | 触发位置 |
| --- | --- | --- |
| POST | `/api/workbench/next-action` | `data-workbench-next-action="guarded"` |
| POST | `/api/workbench/scheduler-dispatch-plan` | 调度计划起草 |
| POST | `/api/workbench/scheduler-dispatch` | `data-scheduler-dispatch="approved-mock"` 等 |
| POST | `/api/workbench/scheduler-dispatch-run` | 调度执行结果回写 |
| POST | `/api/workbench/scheduler-next-cycle` | 调度下一周期入队 |
| POST | `/api/workbench/autonomous-scheduler-loop` | `data-autonomous-scheduler-loop="bounded\|projected-mock\|projected-real"` |
| POST | `/api/workbench/autonomous-scheduler-loop-resume` | `data-autonomous-scheduler-loop-resume` |
| POST | `/api/workbench/project-status-continuation` | 项目状态续跑 |
| POST | `/api/workbench/context-pack-cycle` | Context Pack 周期 |
| POST | `/api/workbench/context-work-packages-run` | Context Pack 工作包派发 |
| POST | `/api/workbench/reviewer-shard-run` | reviewer shard 触发 |
| POST | `/api/workbench/workbench-browser-events-run` | 浏览器事件回放 |

迁移到 Next.js 时，所有上述 endpoint 必须仍由 `tools/workbench-server.mjs` 提供；
Next.js 端只做 API 客户端 + UI，不得复制后端语义。

## 6. 数据绑定 / 交互契约（必须在新前端保留同名语义）

`workbench.js` 通过 `data-bind` / `data-list` 把 projection 字段投影到 DOM，并通过 `data-*`
action 属性挂按钮。迁移到 antd 组件时，组件 `props` 必须能映射到下列同名 key（含浏览器事件
回归依赖）：

- `data-view` ∈ {`desktop`, `mobile`}
- `data-workbench-tab` ∈ {`overview`, `requirements`, `projects`, `flow`, `agents`, `risks`, `governance`, `runs`}（PC）
- `data-section` / `data-active-section`：与 Tab 同名集合
- `data-bind`：156+ 个标量字段，覆盖 closeout、resume_health、provider_health、scheduler_*、agent_lifecycle_pool_*、counter_*、operator_*、ui_verification_*、plan_review_* 等
- `data-list` ∈ {`project_rows`, `project_task_flow`, `project_agents`, `model_roles`, `next_actions`, `operations_timeline`, `requirement_intake`}
- 表单：`data-requirement-form` + `data-requirement-project` + `data-requirement-hint` + `data-requirement-status` + `data-requirement-submit`
- 方案审核：`data-plan-review-action` ∈ {`approve`, `revise`} + `data-plan-review-status`
- 调度：`data-scheduler-dispatch`、`data-autonomous-scheduler-loop`、`data-autonomous-scheduler-loop-resume`
- 校验：`data-workbench-next-action="guarded"`、`data-provider-health`
- 历史切换：`data-history-select`
- 总览动作：`data-action` ∈ {`validate`, `next`}

`tools/check-workbench-browser-events.mjs` 与 `tools/check-workbench-next-frontend-acceptance.mjs`
按上述 key 或等价 App Router 语义做 DOM 验证；新前端必须在等价 antd 组件上保留同样的
key 或提供等价的 data-test attribute，并同步更新这两个 check 脚本（不得弱化断言）。

## 7. 迁移清单（按视图切片）

按依赖与风险排序，每个切片以独立 PR 落地；旧入口已在第 9 步完成后删除：

1. **骨架与公共布局**：在 `apps/workbench/app/layout.tsx` + `apps/workbench/app/page.tsx`
   建立 antd `ConfigProvider` + `Layout` + 顶部导航 + 路由切换。
2. **总览首屏 `overview`**：迁移 `hero-panel`、`metrics`、`next_actions`、`operations_timeline`
   到 antd `Card` + `Statistic` + `Timeline` + `Button`。
3. **新建任务 `requirements`**：迁移 `requirement-panel` 表单到 antd `Form` + `Select`
   + `Input.TextArea` + `Button`，并接 `/api/workbench/requirements`。
4. **方案审核 `plan-review`**：迁移到 antd `Card` + `Descriptions` + `Button` (approve/revise)。
5. **项目与任务流 `projects` / `flow`**：迁移到 antd `Table` / `List` + `Tag` + `Progress`。
6. **Agents / Risks / Governance / Runs**：迁移到 antd `Tabs` 内子页 + `Descriptions` + `Alert`。
7. **手机端 `mobile`**：在 Next.js 中以独立路由（如 `/m`）和独立组件树实现，不复用 PC 页面缩放。
8. **API 客户端统一**：把 `projection-source.js` 中所有 endpoint 抽象到
   `apps/workbench/lib/api/*.ts`，并补 TypeScript 类型。
9. **清理与下线**：✅ LFG-P6.4 已完成。`desktop.html` / `mobile.html` /
   `workbench.js` / `projection-source.js` / `styles.css` 已删除，`tools/workbench-server.mjs`
   已拒绝 legacy static opt-in，公开入口由 Next.js App Router 接管。

## 8. 回退与证据

- 原生入口下线后不得重新引入 `desktop.html` / `mobile.html` / `workbench.js` / `projection-source.js` / `styles.css` 作为回退。
- 每个切片必须保留：本地 `node --test`、`npm run check:workbench:browser-events`、
  `npm run check:workbench:frontend-acceptance`、`npm run check:closeout` 全部通过，
  以及一次真实 served-route 验证。
- 任何对清单的修改（新增/删除入口、API、`data-*` key、tab）必须同步更新本文件；
  否则 `test/workbench-shell.test.js` 中的 inventory baseline 测试失败，阻塞合入。
