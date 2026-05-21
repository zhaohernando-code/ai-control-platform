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

[2026-05-21T16:18:00+08:00] Configure GitHub remote for AI Control Platform:
新中台仓库已创建 GitHub 私有远端并推送 `main`。远端为 `git@github.com:zhaohernando-code/ai-control-platform.git`，网页入口为 `https://github.com/zhaohernando-code/ai-control-platform`。后续新中台开发必须以该远端为 upstream 收口，不能只停留在本地仓。

[2026-05-21T15:43:44+08:00] Accept isolated subagent outputs only after main-process evaluation:
本轮用两个隔离子进程试运行中台自身流程：子进程 A 负责 Context Pack / Work Package，子进程 B 负责 Autonomous Run Evaluation / Recovery Decision。两者只写入各自 owned files，不直接提交主仓；主进程读取实际文件、运行测试和边界模拟后再合入。

决策：
- Context Pack 是派发子进程前的硬门禁，缺少宿主、禁止动作、owned files、验收门禁或回退条件时不得派发。
- Work Package 必须继承 Context Pack 的 owned files 范围，缺少写入范围或越界写入时 `dispatch_allowed=false`。
- Run Evaluation 的默认方向是自动继续：普通测试、构建、artifact 或 reviewer 普通失败进入 `rerun`；host boundary、owned files、安全或严重 reviewer 失败进入 `rollback`；只有凭据缺失、破坏性动作、需求冲突或连续恢复失败才进入 `human_intervention`。
- 子进程输出摘要不能作为验收依据，主进程必须读取 patch、运行 gate，并写入评估记录。

[2026-05-21T16:07:23+08:00] Model collaboration must be routed by policy:
多 LLM 协同不是固定使用 Claude+DeepSeek，也不是所有任务都使用最高成本模型。中台需要按任务阶段、风险、预算、宿主和标签生成模型协同计划。

决策：
- `deepseek-v4-flash` 优先用于低风险分类、摘要、路由和批量预筛。
- `deepseek-v4-pro` 优先用于独立审查、代码审计、第二意见和中高风险推理。
- `gpt` 优先用于高风险平台核心实现、复杂规划、Recovery、架构和最终仲裁。
- 高风险平台任务必须包含独立 reviewer；预算降级必须记录 preferred model、selected model 和 downgrade reason。
- Claude Code + DeepSeek V4 Pro 只是 reviewer gate 的一个 provider/model 组合，不能作为唯一审查方案写死。

[2026-05-21T16:20:18+08:00] Workbench consumes projection, not logs:
工作台的 PC 和 mobile 页面不应直接解析运行日志、聊天总结或某个 agent 的临时输出。中台先把 run manifest、artifact ledger、model routing、reviewer gate、autonomous-run decision 和 task DAG 汇总为 Workbench Projection，再由 UI 消费。

决策：
- `workbench.v1` 是 PC 工作台的一屏状态输入。
- `workbench.mobile.v1` 是移动端独立信息架构的状态子集，不是 PC 页面缩放。
- projection 只汇总事实，不直接调用 agent、模型、CI 或发布系统。
- 缺少 manifest、artifact ledger 或 model plan 时，projection 进入 `human_intervention`，因为系统缺少足够事实继续自动判断。

[2026-05-21T16:32:59+08:00] Completed cycles must run continuation gate:
用户指出当前执行仍会在总结后停止，这会导致未来中台任务创建后也停在中间。因此完成测试、提交、推送或输出总结之后，必须运行 Autonomous Continuation gate。

决策：
- `PROJECT_STATUS.next_step` 或 `next_work_packages` 存在且没有人工阻塞时，系统必须 `continue`。
- `rerun` 和自动 `rollback` 都是继续条件，不是人工等待条件。
- 只有凭据缺失、破坏性动作、需求冲突、恢复失败耗尽或错误宿主等情况可以 `stop_for_human`。
- continuation gate 必须输出下一轮 `context_pack_seed`，防止下一轮依赖聊天上下文。

[2026-05-21T16:40:26+08:00] PC/mobile workbench shells consume validated projection JSON:
工作台前端第一步不直接接 agent 日志、项目状态文件或聊天记录，而是只消费已通过 schema gate 的 Workbench Projection JSON。

决策：
- PC 入口为 `apps/workbench/desktop.html`，固定占满浏览器视口，内部内容区纵向滚动。
- Mobile 入口为 `apps/workbench/mobile.html`，使用独立信息架构。
- 两个入口共用 `apps/workbench/workbench.js`，只读取 projection JSON。
- 浏览器验证必须检查 projection 是否加载、PC/mobile 是否无横向溢出。

[2026-05-21T16:44:15+08:00] Workbench projection source supports service-backed mode:
工作台 shell 不应永久绑定本地 fixture。`projection-source.js` 现在提供数据源抽象，默认读取本地 fixture，也允许通过安全 query 参数切到服务接口，例如 `?projection=/api/workbench/projection`。

决策：
- 只接受 `http(s)`、站内绝对路径、`./` 或 `../` 相对路径。
- 拒绝 `javascript:` 和协议相对 URL。
- projection 加载后先做最小 shape validation，避免空对象进入 UI。
- 下一步应增加本地 projection API/server adapter 和 projection history index。
