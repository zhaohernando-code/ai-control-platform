# Frontend Refactor Constraints (Antd + React + Next.js)

适用范围：AI Control Platform 项目的所有面向用户的中台前端代码（`apps/workbench` 下的 PC/mobile 工作台入口）。

本文件是从“需求：前端重构”（requirement-unknown-20260526033003）派生的项目级硬约束。任何后续前端切片落地必须满足这些不变量；不满足则 `test/workbench-shell.test.js` 会失败，从而成为合入前的回归门禁。

## 技术栈约束

- UI 框架：必须使用 [Ant Design](https://ant.design/)（antd）作为唯一基础与布局组件库。
- 应用框架：必须使用 [React](https://react.dev/) + [Next.js](https://nextjs.org/) 的 App Router（`app/` 目录模式）。
- 语言：TypeScript 优先；保留 ESM 模式。

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
- 静态产物输出必须仍由 `tools/workbench-server.mjs` 在公开挂载路径下可访问；如果改为 `next build && next export` 或 server runtime，必须同步更新 server 静态服务路径与 `check:workbench:live-route` 探测。

## 现状盘点（迁移基线）

切片迁移之前必须以本节为基线，不得遗漏。

- 入口 HTML：`apps/workbench/desktop.html`、`apps/workbench/mobile.html`。
- 静态资源：`apps/workbench/styles.css`、`apps/workbench/favicon.svg`。
- 应用脚本：`apps/workbench/workbench.js`、`apps/workbench/projection-source.js`。
- 公开挂载：`https://hernando-zhao.cn/projects/ai-control-platform/` → 重定向到 `apps/workbench/desktop.html`。
- 数据来源：`docs/examples/current-session-workbench-projection.json` fixture 或 `/api/workbench/projection` 服务接口。
- 关键交互绑定：`data-bind`、`data-list`、`data-action`、`data-requirement-form`、`data-plan-review-action`、`data-scheduler-dispatch`、`data-autonomous-scheduler-loop`、`data-workbench-next-action`、`data-provider-health`、`data-history-select`、`data-workbench-tab`。

## 验收门禁映射

- `node --test test/workbench-shell.test.js` 中包含本文件的存在性与关键条款断言（参见 `test/workbench-shell.test.js` 的 "frontend refactor constraints" 测试）。
- `npm run check:workbench:browser-events`、`npm run check:workbench:frontend-acceptance`、`npm run check:closeout` 必须在迁移每个切片后仍能通过；不能为了换栈而临时下调这些 gate。
- 任何引入新前端依赖（antd、next、react 等）的切片必须同时更新 `package.json`、`PROJECT_RULES.md` 引用并保留旧入口可回退路径，直至新前端通过 served-route 验证。

## 非目标

- 不引入除 antd 之外的第二套基础组件 / 设计体系；如需特定领域可视化（例如图表）才允许在 antd 之外引入专用库，并需在 PR 中说明理由。
- 不修改后端语义；仅做调用方适配。
- 不在本约束文件以外的位置定义重复或冲突的前端规则；其它文档若引用本约束，应通过链接而非复制粘贴维护。
