# Frontend Refactor Constraints (Antd + React + Next.js)

适用范围：AI Control Platform 项目的所有面向用户的中台前端代码（`apps/workbench` 下的 PC/mobile 工作台入口）。

本文件是从“需求：前端重构”（requirement-unknown-20260526033003）派生的项目级硬约束。任何后续前端切片落地必须满足这些不变量；不满足则 `test/workbench-shell.test.js` 会失败，从而成为合入前的回归门禁。

## 技术栈约束

- UI 框架：必须使用 [Ant Design](https://ant.design/)（antd）作为唯一基础与布局组件库。
- 应用框架：必须使用 [React](https://react.dev/) + [Next.js](https://nextjs.org/) 的 App Router（`app/` 目录模式）。
- 语言：TypeScript 优先；保留 ESM 模式。

## 关键选型确认（Step 02/9 of requirement-unknown-20260527043146）

本节是“需求：前端重构”计划步骤 02 / 9（"与用户确认关键选型"）的durable 落点。四项关键选型已在主线代码中体现，并在本节固化为不可被静默回退的项目级约束；任何后续切片若要调整其中任一项，必须新增 DECISIONS.md 条目并同步更新本节。

- TypeScript 是否纳入：纳入。前端工程必须使用 TypeScript（`apps/workbench/tsconfig.json` 已开启 `strict: true`、`jsx: "preserve"`、`@/*` 路径别名）；`apps/workbench/package.json` 的 `devDependencies` 必须包含 `typescript`。原生 HTML/CSS/JS 入口已在 LFG-P6.4 下线，新增视图与组件不得回退到非 TS 实现。
- 包管理器（pnpm / npm）：使用 npm。`apps/workbench/package.json` 与仓库根均以 npm 作为唯一包管理器；锁文件以 `apps/workbench/package-lock.json` 与仓库根 `package-lock.json` 为准；不得引入 `pnpm-lock.yaml` 或 `yarn.lock`。脚本入口统一为 `npm run dev`、`npm run build`、`npm run lint`，便于 `tools/run-with-node18.mjs` 与既有 `check:workbench:*` 门禁直接复用。
- Next.js 产物形态（standalone vs static export）：standalone。`apps/workbench/next.config.mjs` 必须保持 `output: "standalone"`；不采用 `next export` 静态导出，以便后续切片可以承载需要 server runtime 的接口转发与同源 SSR 逻辑。公开挂载路径仍走 `tools/workbench-server.mjs`，新前端通过 `WORKBENCH_API_BASE` 与 workbench-server 联调；当 standalone 产物切换为发布入口时，必须同步更新 server 静态/反代配置与 `check:workbench:live-route` 探测。
- 是否需要新旧并行灰度：已结束。LFG-P6.1 至 LFG-P6.3 的 served-route、frontend-acceptance、browser-events、scheduler writeback 和 shell gate 均已由 mounted Next.js App Router runtime 接管；LFG-P6.4 删除 `apps/workbench/desktop.html`、`apps/workbench/mobile.html`、`apps/workbench/workbench.js`、`apps/workbench/projection-source.js`、`apps/workbench/styles.css`，并禁止 `tools/workbench-server.mjs` 重新启用 legacy static serving。新入口仍共享 `/api/workbench/*` 后端契约，禁止在新前端复制后端语义或绕过 workbench-server 直接读写状态。

## 组件与布局规则

- 禁止自造基础组件：按钮、输入框、表格、表单、模态、抽屉、分页、菜单、Tab、消息提示、图标容器等基础控件必须直接使用 antd 提供的组件。
- 布局组件强制走 antd：页面骨架（如 `Layout`、`Sider`、`Header`、`Content`、`Footer`）、栅格（`Row` / `Col`）、间距（`Space`）、卡片（`Card`）等布局元素必须使用 antd，禁止自己用裸 `div` + 自定义 CSS 重新实现等价能力。
- 遵循 antd 官方页面的设计规范（包含但不限于 Pro Components 的页面骨架、栅格断点、间距比例、颜色 token、阴影层级、表单校验态展示）。
- 单页 app 形态必须保留：浏览器地址栏路由切换不触发整页刷新，整体壳保持稳定的 `Layout` + 路由切换结构；不允许退化为多入口多页站点。
- 原有 CSS 默认不保留：除非该样式承担 antd 无法表达的领域语义，否则必须移除；保留时需要在 PR 描述中显式说明保留原因并在代码注释中记录。

## 项目结构与入口

- 新前端工程位于 `apps/workbench/`（保持当前 owned 路径，避免与 workbench-server / 公开挂载路径漂移）。
- Next.js 路由入口位于 `apps/workbench/app/`；公共布局位于 `apps/workbench/app/layout.tsx`；页面位于 `apps/workbench/app/page.tsx`（默认进入工作台总览）。
- 数据层抽象统一到 `apps/workbench/lib/api/`，对接现有后端：`/api/workbench/projection`、`/api/workbench/projections`、`/api/workbench/events`、`/api/workbench/snapshots`、`/api/workbench/requirements`、`/api/workbench/plan-reviews`、`/api/workbench/scheduler-next-cycle` 等。
- 公开页面必须由 Next.js App Router runtime 在公开挂载路径下提供；`tools/workbench-server.mjs` 只服务 `/api/workbench/*`。如果改为 `next export` 或其它 server runtime，必须同步更新公开入口、edge 代理、live-route 与 served-route 探测。

## 现状盘点（迁移基线）

切片迁移之前必须以本节为基线，不得遗漏。

- 入口：`apps/workbench/app/` 下的 Next.js App Router 路由；默认公开挂载为 `https://hernando-zhao.cn/projects/ai-control-platform/`。
- 静态资源：`apps/workbench/public/favicon.svg` 等 Next public 资源。
- 应用逻辑：`apps/workbench/app/**/*.tsx`、`apps/workbench/lib/api/**/*.ts`。
- 已下线 legacy 文件：`apps/workbench/desktop.html`、`apps/workbench/mobile.html`、`apps/workbench/workbench.js`、`apps/workbench/projection-source.js`、`apps/workbench/styles.css`、`apps/workbench/favicon.svg`。
- 数据来源：`docs/examples/current-session-workbench-projection.json` fixture 或 `/api/workbench/projection` 服务接口。
- 关键交互绑定：`data-bind`、`data-list`、`data-action`、`data-requirement-form`、`data-plan-review-action`、`data-scheduler-dispatch`、`data-autonomous-scheduler-loop`、`data-workbench-next-action`、`data-provider-health`、`data-history-select`、`data-workbench-tab`。

## 验收门禁映射

- `node --test test/workbench-shell.test.js` 中包含本文件的存在性与关键条款断言（参见 `test/workbench-shell.test.js` 的 "frontend refactor constraints" 测试）。
- `npm run check:workbench:browser-events`、`npm run check:workbench:frontend-acceptance`、`npm run check:closeout` 必须在迁移每个切片后仍能通过；不能为了换栈而临时下调这些 gate。
- 任何引入新前端依赖（antd、next、react 等）的切片必须同时更新 `package.json`、`PROJECT_RULES.md` 引用，并保持 Next served-route、browser-events、frontend-acceptance 与 closeout gates 通过。

## 非目标

- 不引入除 antd 之外的第二套基础组件 / 设计体系；如需特定领域可视化（例如图表）才允许在 antd 之外引入专用库，并需在 PR 中说明理由。
- 不修改后端语义；仅做调用方适配。
- 不在本约束文件以外的位置定义重复或冲突的前端规则；其它文档若引用本约束，应通过链接而非复制粘贴维护。
