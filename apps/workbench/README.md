# Workbench Shell

AI Control Platform 工作台的前端入口集合。当前仓库正在从原生 HTML/CSS/JS
shell 逐步迁移到 **Next.js (App Router) + Ant Design** 的单页 app 骨架。
两个入口在迁移期共存，后端 API 统一由 `tools/workbench-server.mjs` 提供。

## 1. 现有原生入口（迁移期保留为回退）

- `desktop.html`：PC 单页工作台，固定占满浏览器视口，内部内容区允许纵向滚动。
- `mobile.html`：手机独立信息架构，不是 PC 页面缩放。
- `workbench.js`：只读取 `docs/examples/current-session-workbench-projection.json`，
  不解析日志或聊天记录。
- `projection-source.js`：projection 数据源抽象，默认读取本地 fixture，也支持
  `?projection=/api/workbench/projection` 指向服务接口。
- `styles.css`：迁移完成后默认下线；保留期间不引入新的领域样式。

## 2. Next.js + Ant Design 骨架（实施步骤 02 / 7）

入口约定见 `apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md`，迁移基线见
`apps/workbench/FRONTEND_MIGRATION_INVENTORY.md`。

骨架阶段产出的关键文件：

| 路径 | 角色 |
| --- | --- |
| `package.json` | Next.js 子工程依赖与脚本（`next`、`react`、`antd`、`typescript`） |
| `next.config.mjs` | Next.js 配置：`reactStrictMode`、`output: "standalone"`、API base 环境变量 |
| `tsconfig.json` | TypeScript 严格模式 + 路径别名 `@/*` |
| `app/layout.tsx` | App Router 根布局，挂载 `<AppProviders>` 与 `<WorkbenchShell>` |
| `app/providers.tsx` | antd `AntdRegistry` + `ConfigProvider`（locale + theme）+ `AntdApp` |
| `app/shell.tsx` | antd `Layout` + `Sider` + `Header` + `Menu`（SPA 导航，路由切换不刷新） |
| `app/theme.ts` | antd v5 `ThemeConfig` token 与组件局部覆盖 |
| `app/page.tsx` | 总览首屏占位（仅使用 antd `Card`/`Descriptions`/`Tag`/`Alert`/`Typography`） |
| `app/loading.tsx` | App Router loading 边界（antd `Skeleton`） |
| `app/error.tsx` | App Router 错误边界（antd `Result` + `Alert`） |
| `app/not-found.tsx` | 404 兜底（antd `Result`） |
| `lib/api/index.ts` | 后端 endpoint 常量 + `fetchWorkbenchJson` 客户端封装 |
| `lib/api/projection.ts` | projection / projection history 客户端薄封装 |

约束：

- 基础与布局组件**只能**来自 antd（详见
  `FRONTEND_REFACTOR_CONSTRAINTS.md`）；禁止自造 `Layout/Sider/Header/Menu/Card/
  Button/Form/Table/Modal/Drawer/Pagination/Tabs/Message/Icon` 等等价组件。
- 维持单页 app 形态：路由切换通过 Next.js App Router 完成，不触发整页刷新。
- 原生 CSS 默认不保留；新代码不得为了排版引入裸 CSS。
- 任何新增前端依赖必须同时记入本文件、`package.json` 与
  `FRONTEND_REFACTOR_CONSTRAINTS.md`。

## 3. 本地联调

骨架阶段 Next.js dev/build 与原生 shell 在不同端口共存，避免后端语义被复制：

| 服务 | 端口 | 作用 |
| --- | --- | --- |
| `tools/workbench-server.mjs` | 4180 | 原生入口 + 全部 `/api/workbench/*` 后端 |
| `apps/workbench` (Next.js) | 4181 | 新前端骨架，仅 UI；API 走 `WORKBENCH_API_BASE` 指向 4180 |

启动流程：

```bash
# 1) 启动后端（原生 shell + API）
node tools/workbench-server.mjs --host 127.0.0.1 --port 4180

# 2) 启动新前端骨架（首次需 npm install）
cd apps/workbench
npm install
WORKBENCH_API_BASE=http://127.0.0.1:4180 npm run dev
# 打开 http://127.0.0.1:4181/
```

CI / 生产前的构建校验：

```bash
cd apps/workbench
npm install --no-audit --no-fund
npm run build
```

公开挂载（`/projects/ai-control-platform/...`）仍由 `tools/workbench-server.mjs`
负责，骨架阶段不接管 edge 路由；切片 9 完成后才会改写挂载路径与
`check:workbench:live-route` 探测目标。

## 4. 后端接口入口（保持稳定）

```
GET  /api/workbench/projection
GET  /api/workbench/projections
GET  /api/workbench/events
POST /api/workbench/events
GET  /api/workbench/snapshot?id=<id>
POST /api/workbench/snapshots
POST /api/workbench/requirements
POST /api/workbench/plan-reviews
POST /api/workbench/next-action
POST /api/workbench/scheduler-dispatch
POST /api/workbench/scheduler-dispatch-plan
POST /api/workbench/scheduler-dispatch-run
POST /api/workbench/scheduler-next-cycle
POST /api/workbench/autonomous-scheduler-loop
POST /api/workbench/autonomous-scheduler-loop-resume
POST /api/workbench/project-status-continuation
POST /api/workbench/context-pack-cycle
POST /api/workbench/context-work-packages-run
POST /api/workbench/reviewer-shard-run
POST /api/workbench/reviewer-provider-health
POST /api/workbench/reviewer-shard-result
POST /api/workbench/agent-lifecycle-pool
POST /api/workbench/workbench-browser-events-run
```

新前端只做客户端调用，不复制后端语义；接口返回必须先通过
`tools/check-workbench-projection.mjs` 同等校验后才能进入 UI。

## 5. 运行态存储

Live Workbench 不应把运行态直接写进 Git-tracked JSON 文件。
`tools/workbench-server.mjs` 支持 `--state-db <path>`，启用后会把以下运行态
写入 SQLite：

- `PROJECT_STATUS` 等项目状态。
- projection history latest 和 workflow snapshot。
- operator event ledger。

`scripts/start-workbench-live.sh` 默认使用：

```bash
$HOME/codex/runtime/ai-control-platform/workbench-state/workbench-state.sqlite
```

`docs/examples/*.json` 仍作为 fixture/seed 使用；首次启动 DB 模式时会把
history 中的 workflow input seed 到 SQLite snapshot，之后 live 写入只更新
SQLite，不回写 seed JSON。

## 6. 验收门禁映射

- `node --test test/workbench-shell.test.js` 既校验原生入口绑定不漂移，
  也校验骨架阶段所要求的 Next.js + antd 文件存在与约束。
- `npm run check:workbench:browser-events` /
  `npm run check:workbench:frontend-acceptance` / `npm run check:closeout`
  必须在每个切片合入后仍能通过；不允许为了换栈临时下调门禁。
