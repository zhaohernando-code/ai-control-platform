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
- `PROJECT_STATUS.json` 只承载持久意图（goals/phase/blockers/next steps 等），不得当作运行日志：运行期派生字段（`updated_at`、`latest_update`、各类 `*_live_route_evidence`/`*_live_route_probe` 等）属于 run/artifact 账本，提交前用 `durableProjectStatus()`（`src/workflow/project-status-fields.js`）剥离；self-governance scan 会对混入派生字段发出 `project-status-carries-derived-runtime-fields` 提示。
- 文档检查只证明恢复入口存在；`run_context_work_packages` 调度前必须通过 fixed-development-mode runtime gate，检查 Context Pack root/subtask/selected work package 的 `owned_files`，失败时不得把 work package 标记为 completed。
- `run_context_work_packages` 还必须通过 work-package-execution-governance gate：需求实现类 work package 必须保留依赖和 source 元数据，并提供结构化 `source.execution_governance`。硬门禁只根据 `granularity`、`decomposition.required/status/evidence`、`verification.status/gate_count` 等结构化字段判定；自然语言步骤说明不得作为执行阻断依据。
- 多模型协同必须经过 model routing plan、reviewer gate 和 durable findings/artifacts；禁止把某个模型或临时 skill 固定成绕过流程的默认实现者。
- 最终 closeout 必须经过治理 skill 编排 artifact、远端 `origin/main` 一致性和用户可见入口证据；本地干净或单次测试通过不能单独代表合入发布完成。
- 本项目必须纳入共享源码规模治理：首次 checkout 或发现 hook 未触发时运行 `npm run install:git-hooks` / `scripts/install-git-hooks.sh`，确保 `core.hooksPath=../../.githooks`。超过 500 行的 `.js/.ts/.tsx/.py/.css` 文件必须记录在 `.largefile-manifest.json`，新增或继续增长时优先拆分；manifest 只记录当前仍需治理的真实文件，不作为永久豁免。
- `npm test` 必须从隔离 task worktree(`worker-workspaces/...`)运行,不能在 canonical 主检出里跑:headless orchestrator 测试会走真实子 worker 路径,该路径按设计拒绝在主 worktree 执行代码产出工作包,在主检出跑会产生 ~17 个误导性的 `blocked !== pass` 失败(并非真实缺陷)。`pretest`(`tools/check-test-location.mjs`)会在跑错位置时快速失败并给出明确指引;确需在 canonical 跑时设 `AI_CONTROL_PLATFORM_ALLOW_CANONICAL_TEST=1`。
- `npm run test:affected` 是开发期加速器,只跑被改动传递影响的测试子集(基于 `tools/select-affected-tests.mjs` 的反向 import 图 + spawn/fixture 字面量边);无法静态证明影响范围时一律 fail-open 跑全套。它**不替代**收尾门禁:合入前仍须以全套 `npm test` 为准。
- Playwright CLI 或浏览器验证生成的 `.playwright-cli/` 控制台日志属于本地临时诊断产物，必须保持 git ignored；任何浏览器验收、closeout 或 public route verification 后，canonical checkout 仍必须通过 `git status --short` 干净检查。
- 前端相关任务默认同时覆盖 PC Web 与手机尺寸；手机端可以独立信息架构，不得默认压缩 PC 页面。
- 用户可见功能完成前必须有真实渲染或服务验收；只通过源码或静态文档不算完成。
- Ops Workbench、任务 DAG、调度锁、事件源状态、Recovery Engine、LLM reviewer、CI/CD 门禁、周期体检和快速定位 skill 都是平台基座能力；开发前必须先明确领域模型、状态真值、契约、失败恢复、测试边界和操作员可观测面。
- 当前 watchdog 只能作为历史样本和临时观察输入，不能作为 Recovery Engine 底座。遇到自愈、恢复、错误卡死处理相关任务时，按独立 Recovery Engine 重新建模。
- 平台 UI 的目标形态是成熟 Ops Workbench，不是任务卡片集合。新增页面或字段前必须确认它服务于总览、任务流、agent 池、风险、人工决策、发布/验收证据中的哪一类。
- 重要决策写入 `DECISIONS.md`，可复用流程经验写入 `PROCESS.md`，当前状态写入 `PROJECT_STATUS.json`。

## 前端栈与组件约束（Antd + React + Next.js App Router）

适用范围：本仓库下所有面向用户的中台前端代码，当前承载于 `apps/workbench/`。
完整条款见 `apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md`；本节为项目级硬约束的入口，任何前端切片必须满足以下不变量，违反时合入前置回归门禁会失败。
本节是 requirement-unknown-20260527043146 计划步骤 08 / 9 的 durable rule；任何放宽 antd、React 或 Next.js App Router 约束的变更，必须新增 `DECISIONS.md` 记录并同步上述 constraints 文档。

- 技术栈固定：UI 框架必须使用 [Ant Design](https://ant.design/)（antd）作为唯一基础与布局组件库；应用框架必须使用 [React](https://react.dev/) + [Next.js](https://nextjs.org/) 的 App Router（`app/` 目录模式）。
- 不得自造基础组件：按钮、输入框、表格、表单、模态、抽屉、分页、菜单、Tab、消息提示、图标容器等基础控件必须直接使用 antd 提供的组件，不允许自行用裸 HTML/CSS 重写等价能力。
- 布局组件强制走 antd：页面骨架（`Layout` / `Sider` / `Header` / `Content` / `Footer`）、栅格（`Row` / `Col`）、间距（`Space`）、卡片（`Card`）等布局元素必须使用 antd；不允许用裸 `div` + 自定义 CSS 重新实现等价能力。
- 遵循 antd 官方页面的设计规范：包含但不限于 Pro Components 的页面骨架、栅格断点、间距比例、颜色 token、阴影层级、表单校验态展示。
- 维持单页 app 形态：浏览器地址栏路由切换不触发整页刷新，整体壳保持稳定的 `Layout` + 路由切换结构；不允许退化为多入口多页站点。
- 原有 CSS 默认不保留：除非该样式承担 antd 无法表达的领域语义，否则必须移除；保留时须在 PR 描述中显式说明保留原因并在代码注释中记录。
- 禁止引入第二套基础组件 / 设计体系（如 `@mui/material`、`@chakra-ui/react`、`shadcn-ui` 等）；如需特定领域可视化（例如图表）才允许在 antd 之外引入专用库，并需在 PR 中说明理由。
- 任何前端切片合入后，`node --test test/workbench-shell.test.js`、`npm run check:workbench:browser-events`、`npm run check:workbench:frontend-acceptance`、`npm run check:closeout` 必须仍能通过；不允许为了换栈临时下调这些门禁。
