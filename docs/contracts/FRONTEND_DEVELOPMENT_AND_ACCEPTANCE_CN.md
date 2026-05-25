# 前端开发与验收流程合同

状态：active
宿主：`ai-control-platform`

## 1. 固定角色

- `main_orchestrator` 负责判断前端目标、生成 bounded Context Pack、派发实现子进程、派发独立验收子进程、审查 artifact，并在失败时先固化 gate/process-hardening 再重试。
- `child_worker` 只能修改 Context Pack 授权的前端 owned files，不能扩大到平台流程、managed project 或 legacy 目录。
- `frontend_acceptance_child_worker` 默认只读执行，负责用浏览器、DOM、截图和规则 rubric 验收前端；不得把“能加载、无 console error、无横向 overflow”当作完整验收。

## 2. 前端开发 Context Pack 必填项

- 目标用户和核心任务。
- 信息架构：首屏、导航、主工作区、次级上下文、诊断区。
- 允许展示的用户文案和禁止直出的后端/projection 字段。
- 操作分级：普通、需确认、危险、mock、real execution、loop/resume。
- 桌面和移动端布局策略；移动端不能只是桌面 telemetry 的单列堆叠。
- owned files、非目标、回退条件、验收命令。

## 3. 前端验收 Context Pack 必填项

- 使用 `npm run check:workbench:frontend-acceptance` 生成 `frontend-acceptance-run.v1` artifact。
- 验收 desktop、desktop narrow、mobile 三个 viewport。
- 检查导航可交互、首屏层级、文案可读性、危险操作分级、布局重叠、横向 overflow、移动端任务优先性。
- Artifact 必须包含 `content_completion_results`：每个 viewport 从真实浏览器 DOM 可见文本提取 section/body 文本、占位符计数、遥测/诊断 token 计数、操作员行动标签和下一步上下文；截图只能作为辅助证据，不能替代 DOM 文本证据。
- Artifact 必须包含 `control_results.command_architecture` 和 `layout_results`：每个 viewport 从真实浏览器 DOM 记录命令控件数量、所在区域、主要/高级分组、重复动作、高风险动作数量、可见 section 数和命令密度；缺失这些证据、过载却没有 finding、或控件架构 false pass 都要 fail closed。
- 验收发现 P0/P1 时，artifact 必须 `status=fail`，并写出结构化 finding。

## 4. 硬门禁

- `check:closeout` 必须运行 frontend acceptance gate。
- 缺少 `frontend-acceptance-run.v1`、artifact schema 不合法、或存在 P0/P1 finding 时，closeout 和 live-facing 发布必须失败。
- 前端验收结果必须进入 workflow state / artifact ledger，并通过 workbench projection 暴露 `frontend_acceptance` 摘要。
- 失败的 `frontend-acceptance-run.v1` 不能只作为 blocker 展示；autonomous continuation 必须自动生成 `repair_frontend_acceptance` bounded child-worker work package，owned files 限定为 `apps/workbench` 与对应前端测试，acceptance gates 至少包含 `npm run check:workbench:frontend-acceptance`、`npm run check:workbench:browser-events` 和 `npm run check:closeout`。

## 5. 当前事故固化不变量

- 导航 tab 不能是死链接；非总览 tab 点击必须改变可见内容、视图焦点或滚动位置；只改变 active class 不算通过。
- 默认用户界面不能直出 raw backend/projection token。
- 首屏 headline 不能绑定未裁剪的动态 goal/process 文本。
- 危险、mock、real execution、loop/resume 操作不能作为普通按钮无分级暴露。
- 移动端不能是后端 telemetry dump。
- 项目挂载路由下的 SVG favicon 必须真实请求并以 `image/svg+xml` 返回；只检查 `<link rel="icon">` 存在或 HTTP 200 不算通过。
- 默认桌面/窄桌面表面不能被诊断字段墙、projection/backend token 或 telemetry 主导；操作员应先看到目标、阻塞、风险、可执行下一步和验收证据。
- 手机端不能把长状态、遥测、artifact/history id 或后端字段单列堆叠成状态 dump；必须优先呈现操作员任务、阻塞原因和下一步。
- 可见 review/risk/model/section/tab 内容不能主要由 `--`、`未配置`、`未就绪`、`未知`、裸 `0` 等占位符构成；占位状态必须配有明确标签、原因、影响或下一步上下文。
- 默认桌面/窄桌面即使包含较多“下一步/执行/审查/完成”等行动词，也不能用行动词数量抵消高密度诊断字段墙；当 DOM 可见内容出现约 50 个 data-bind/诊断字段、正文约 40 个未配置/未知/`--` 占位符，或单个 section 同时有 10+ data-bind 和 6+ 未配置/未知/`--` 占位 token 时，`content_completion_results` 必须 fail closed。
- 合法操作员 dashboard 可以显示多个数字状态计数，但数字必须带有目标、原因、影响和下一步上下文；不能仅因少量带标签计数失败。
- `frontend-acceptance-run.v1` 中 `content_completion_results` 的 fail/pass、blocking finding codes 和顶层 P0/P1 findings 必须一致；缺失 viewport DOM 文本证据、false pass 或计数不一致都要 fail closed。
- 命令控件不能靠“能点击”通过验收；默认视图最多保留少量主操作，高风险调度、mock、real execution、loop/resume 应进入受控分组。可见命令超过 release 阈值、单一区域动作过密、主操作区高风险动作过多、重复同一动作或缺失 `browser_dom_controls`/`browser_dom_layout` 证据时，frontend acceptance 必须给出 P0/P1 finding 并阻断 closeout。
