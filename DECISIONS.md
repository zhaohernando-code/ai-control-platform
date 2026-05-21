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

[2026-05-21T16:48:16+08:00] Local workbench server is the first service-backed projection adapter:
`tools/workbench-server.mjs` 提供本地 projection API 和静态工作台服务，作为未来真实后端接入前的最小 adapter。

决策：
- `GET /api/workbench/projection` 返回当前 latest projection。
- `GET /api/workbench/projections` 返回 projection history index。
- PC/mobile 工作台可通过 `?projection=/api/workbench/projection` 切换到 API 模式。
- 浏览器回归必须覆盖 fixture 模式和 API 模式，检查 projection 加载与横向溢出。

[2026-05-21T16:53:32+08:00] Operators can inspect projection history:
工作台不只展示 latest projection，还需要让 operator 在当前和历史自主开发周期之间切换，判断流程是否持续改善。

决策：
- `docs/examples/projection-history.json` 是当前 projection history index。
- `workbench-server` 支持按 `id` 读取历史 projection。
- PC/mobile 都提供 `data-history-select`，切换后重新读取对应 projection。
- 浏览器回归必须验证从 current `rerun` 切换到 bootstrap `pass`。

[2026-05-21T17:00:06+08:00] Workbench operator actions must become durable events:
工作台按钮不能只修改页面文案，否则平台会出现“看起来继续了，但状态没有进入流程”的假进展。操作员点击 validate、next 等控制项时，必须写入事件账本，后续再由 run manifest、artifact ledger 和 evaluation 读取。

决策：
- `docs/examples/operator-events.json` 是当前本地 operator event ledger。
- `workbench-server` 提供 `GET /api/workbench/events` 与 `POST /api/workbench/events`。
- `apps/workbench/projection-source.js` 负责把 UI action 写入事件 API。
- 浏览器回归必须覆盖真实页面点击，并验证事件确实落盘。
- 下一步把 operator events 摄入 run manifest / artifact ledger，进入自主继续判断。

[2026-05-21T17:05:55+08:00] Blocking review findings must harden the process before implementation is accepted:
本轮 reviewer 发现“事件写入失败但 UI 仍显示成功”的问题后，暴露出一个流程缺口：只修按钮逻辑会让同类问题在下个模块复发。阻塞级审查意见必须先升级为流程级不变量和可执行门禁，再判断实现是否可合入。

决策：
- 新增 `process-hardening` gate。
- P0/P1、假成功态、状态持久化缺口、流程停滞、宿主边界、owned files、质量门禁缺口默认要求 process hardening。
- 每条阻塞 finding 必须具备 invariant、enforcement target、regression test、verification、completed status。
- 缺少 hardening 证据时，即使当前代码修复和测试通过，也不得提交。

[2026-05-21T17:14:02+08:00] Closeout must execute process hardening and browser event gates:
`process-hardening` 不能只作为库函数存在，必须进入合入前的可执行路径。工作台事件持久化也不能只靠单元测试，必须有真实页面点击验证。

决策：
- `npm run check:process-hardening` 读取 `docs/examples/process-hardening-current.json` 并执行 gate。
- `npm run check:workbench:browser-events` 启动本地 workbench server，用 Playwright 验证成功点击落盘、失败点击不显示成功态。
- `npm run check:closeout` 串联单测、onboarding、process hardening 和浏览器事件验证。
- 仓库要求 Node.js 18+，因为浏览器 closeout gate 依赖现代 Playwright。

[2026-05-21T17:18:00+08:00] Runtime prerequisites must self-heal when possible:
第三轮 reviewer 发现默认 shell 仍是 Node 16，导致 Playwright gate 在普通 `npm run check:closeout` 下不可执行。环境前置条件不能只写在 README 里，否则平台会在可自动恢复的问题上停住。

决策：
- 新增 `tools/run-with-node18.mjs`，当当前 Node 低于 18 时自动寻找可用 Node 18+ runtime。
- 新增 `tools/check-closeout.mjs`，避免 closeout 依赖外部 npm CLI 路径。
- `npm run check:workbench:browser-events` 和 `npm run check:closeout` 都通过 runtime wrapper 执行。
- 当前环境下普通 `npm run check:closeout` 已可自动切到 Codex bundled Node 24 并通过。

[2026-05-21T17:24:45+08:00] Operator events must be ingested into manifest and ledger:
工作台事件账本本身仍是旁路数据；只有进入 Run Manifest events 和 Artifact Ledger artifacts 后，operator action 才能被 autonomous run、projection 和后续恢复逻辑消费。

决策：
- 新增 `src/workflow/operator-events.js`，负责校验 `operator-events.v1` ledger，并转换为 manifest events / ledger artifacts。
- Operator event 必须具备 `action`、`run_id`、`cycle_id`，目标 run/cycle 已知时必须匹配。
- 摄入到 manifest 和 artifact ledger 必须幂等，重复事件进入 skipped 列表，不能重复计数。
- 默认 operator artifact 类型为 `evaluation`，不扩展 Artifact Ledger 类型集，保持现有 ledger gate 约束。

[2026-05-21T17:29:26+08:00] Workflow-state ingestion must be atomic:
隔离 reviewer 发现 operator event workflow-state apply 可能返回失败结果但已经改写 manifest events。这类半写入状态会让中台在错误状态下继续运行，必须作为流程不变量固定。

决策：
- `applyOperatorEventsToWorkflowState` 必须先校验 manifest 与 artifact ledger 的 run/cycle 一致性。
- preflight 不通过时，不能调用 manifest apply 或 artifact ledger apply。
- 失败结果必须返回原 manifest 和原 artifact ledger，并且 applied lists 必须为空。
- 该约束已进入 `process-hardening-current.json`。

[2026-05-21T17:34:24+08:00] Projection generation must apply operator event ingestion first:
工作台 projection 不能只展示原始 manifest 和 artifact ledger；如果 input 中存在 `operator_event_ledger`，必须先把它原子摄入 workflow state，再计算 manifest event count、artifact counters 和 autonomous_run artifact summary。

决策：
- `createWorkbenchProjection` 在汇总前调用 `applyOperatorEventsToWorkflowState`。
- 失败的 operator ingestion 会把 projection 状态提升为 `human_intervention`，且不使用半写入状态。
- 当前会话 projection fixture 已加入 operator event ledger，artifact counter 从 2 变为 3，manifest event count 从 2 变为 3。
- `check:workbench:browser-events` 增加 mobile projection 渲染与无横向溢出验证。

[2026-05-21T17:38:50+08:00] Operator-event projection must ignore stale run summaries:
隔离 reviewer 发现：如果调用者传入旧 `run_result` 或 `run_evaluation`，projection 的 artifacts counter 可能已经包含 operator artifact，但 autonomous_run summary 仍使用旧数据。存在 operator event ledger 时，projection 必须以摄入后的 workflow state 为唯一事实源。

决策：
- 当 `operator_event_ledger` 存在时，`createWorkbenchProjection` 忽略外部 `run_result` / `run_evaluation`。
- autonomous_run 必须从摄入后的 manifest 和 artifact ledger 重新计算。
- 没有 operator events 时，仍允许使用显式 run evaluation。
- 该约束已进入 process-hardening gate。

[2026-05-21T17:41:01+08:00] Workbench server should prefer workflow state snapshots:
工作台 server 如果只读静态 projection JSON，就会绕过 operator event ingestion、run evaluation 重算等流程逻辑。history item 已经具备 `input_path`，应优先从 workflow state input 动态生成 projection。

决策：
- `GET /api/workbench/projection` 优先读取 history item 的 `input_path` 并调用 `createWorkbenchProjection`。
- 只有缺少 `input_path` 的历史项才读取 `projection_path` 静态 projection。
- Current session projection API 现在来自 workflow state snapshot，bootstrap 历史项保持静态兼容。

[2026-05-21T17:44:53+08:00] Projection history paths must be constrained:
隔离 reviewer 发现 history item 的 `input_path` / `projection_path` 可以通过 `../` 指向仓库外文件。Projection server 读取动态 input snapshot 前必须先做路径边界检查。

决策：
- History path 必须是相对路径。
- History path 必须解析到 `docs/examples/` 目录下。
- 非法 history path 返回 400，不读取文件。
- 增加动态 input 优先级分歧测试，证明 server 没有回退到静态 projection。

[2026-05-21T17:48:02+08:00] Autonomous runs need a snapshot publish API:
只靠手工修改 `docs/examples` 不能满足自动化中台。完成一轮 autonomous run 后，系统需要把 manifest、artifact ledger、operator events、model plan、reviewer gate 和 DAG 等状态发布为 projection-ready workflow state snapshot。

决策：
- 新增 `POST /api/workbench/snapshots`，写入 workflow state input 并更新 projection history latest。
- 新增 `GET /api/workbench/snapshot?id=<id>`，读取 history item 对应 input snapshot。
- Snapshot id 必须是安全 slug，snapshot 文件写入受控 snapshot root。
- Projection API 继续通过 history item 动态生成 projection。

[2026-05-21T17:53:21+08:00] Continuation closeout should emit snapshot publish plans:
自主继续不能只生成下一轮 Context Pack seed。只要 closeout 已有 projection-ready `workflow_state`，就应该生成可执行的 `snapshot_publish_plan`，让工作台状态发布进入流程。

决策：
- `decideContinuation` 在非 `stop_for_human` 且存在 `workflow_state` 时输出 `snapshot_publish_plan`。
- publish plan 固定指向 `/api/workbench/snapshots`，携带 snapshot id、label 和 workflow state input。
- 新增 `workbench-snapshots` 模块，server API 和本地 closeout 都复用同一套 snapshot 发布逻辑。

[2026-05-21T18:05:43+08:00] Closeout publish plans need an executable runner:
如果 `snapshot_publish_plan` 只停留在 decision JSON，系统仍会在“需要人工执行下一步”处停住。closeout 必须有可由调度器调用的 runner，把计划转换成工作台可检索状态。

决策：
- 新增 `closeout-runner` 模块，支持从 continuation decision 或 raw plan 提取并执行 `snapshot_publish_plan`。
- local 模式复用 `publishWorkbenchSnapshot`；http 模式 POST 到工作台 snapshot API。
- 缺少 publish plan 时 fail closed，防止 autonomous closeout 假成功。

[2026-05-21T18:07:12+08:00] Snapshot publishing must reject non-ready projections:
runner smoke 暴露出一个假成功路径：不完整 workflow state 也能被写入 snapshot 并更新 projection history。工作台 latest 一旦指向不可渲染或缺关键事实的状态，后续流程会在错误事实上继续。

决策：
- `publishWorkbenchSnapshot` 在写盘前必须生成 projection 并校验 schema、input_validation、manifest 和 operator events。
- 发布失败不得写 snapshot，也不得更新 projection history。
- Workbench server 对发布失败返回 400，而不是 201。
- 该问题进入 process-hardening gate，后续同类假成功必须先固化门禁再修实现。

[2026-05-21T18:15:56+08:00] Closeout runner and continuation must share publish readiness:
只在 publisher 层 fail closed 还不够。子进程审查发现：runner 可以从错误 cwd 发布，continuation 可以为不可发布状态生成 plan，operator events 缺失也可能被当成可发布状态。这些都会让自动流程继续在错误事实或错误宿主上运行。

决策：
- local closeout runner 必须验证 root 是 `ai-control-platform` 平台仓。
- `publishWorkbenchSnapshot` 要求 operator events 状态为 `pass`，`not_configured` 不能发布为 latest。
- `decideContinuation` 生成 `snapshot_publish_plan` 前复用 snapshot publish readiness；不可发布时返回 `snapshot_publish_issues`。
- 未知 closeout runner mode 必须失败，不能静默回落到 local。

[2026-05-21T18:21:17+08:00] Closeout outputs and HTTP acknowledgements must be bounded:
第二轮复审发现 root 校验仍不足以防止显式输出路径越界，HTTP closeout 也可能把错误服务的空 2xx 响应当成成功。自动流程的“发布完成”必须来自受控路径和结构化 API ack。

决策：
- local closeout 的 history path 与 snapshots root 必须都在平台仓内。
- HTTP closeout 只有在响应包含 `status=created`、匹配 plan id 的 item 和 projection 对象时才算成功。
- snapshot id 写入 history 和文件名前统一使用 trim 后的安全 id。

[2026-05-21T18:25:10+08:00] HTTP closeout projection acknowledgements must match submitted state:
第三轮复审发现：即使 HTTP ack 包含 projection 对象，也可能是错误 run 的 projection。closeout 成功必须绑定到本次提交的 workflow state，而不是信任远端任意对象。

决策：
- HTTP closeout 对返回 projection 运行 workbench projection schema 校验。
- HTTP closeout 本地用 plan input 生成 expected projection，并比对 run_id、cycle_id 和 status。
- HTTP item id 与 plan id 比对时使用 trim 后的规范 id，避免 server 规范化后误判。

[2026-05-21T18:31:24+08:00] Closeout runner results must become workflow evidence:
closeout runner 不能只把发布结果打印到 CLI。无人值守流程的下一轮调度需要从 workflow state 读取“发布成功/失败”事实，否则又会退回日志解析和人工判断。

决策：
- `runCloseoutPlan` 返回的 `workflow_state` 会追加 `closeout_snapshot_publish` manifest event。
- 同一结果会记录到 `artifact_ledger`，artifact 类型为 `evaluation`，成功为 `pass`，失败为 `fail`。
- 失败 closeout 也必须生成证据，供下一轮 recovery / rerun 使用。

[2026-05-21T18:33:53+08:00] Workbench latest should include closeout evidence:
只返回带 evidence 的 workflow state 仍然需要调用方额外持久化。为了减少无人值守流程中的隐式步骤，成功 closeout 应默认把带 evidence 的 workflow state 再发布到同一 snapshot id。

决策：
- `runCloseoutPlan` 成功发布原始 workflow state 后，追加 closeout evidence。
- 默认再次执行 snapshot publish，把带 evidence 的 workflow state 写入同一 history item。
- 如果 evidence snapshot publish 失败，runner 返回失败，不把 closeout 误报为完成。

[2026-05-21T18:36:43+08:00] Workbench projection must surface closeout evidence:
closeout evidence 进入 workflow state 后，工作台 projection 不能只通过 artifact 总数间接展示。PC/mobile 状态输入都需要明确暴露最近一次 closeout publish 事件与 artifact。

决策：
- `createWorkbenchProjection` 新增 `closeout` 摘要。
- `createMobileWorkbenchProjection` 保留 closeout 的移动端摘要。
- Projection schema gate 要求 PC/mobile 都包含 `closeout` 对象。

[2026-05-21T18:40:06+08:00] Workbench shells should render closeout status:
Projection 已经包含 closeout 摘要后，PC/mobile shell 不能继续隐藏该状态，否则用户仍然无法一眼看到自动 closeout 是否把状态发布成功。

决策：
- Desktop shell 新增 Closeout 面板，显示 publish status、snapshot 和 evidence artifact。
- Mobile shell 新增 Closeout 区块，显示 publish status 和 snapshot。
- Browser closeout 验证必须检查 PC/mobile 都渲染 `closeout_status` 且无横向溢出。

[2026-05-21T18:42:04+08:00] Continuation-closeout loop needs deterministic fixture coverage:
单点测试无法证明无人值守闭环没有断点。需要一个固定测试把 continuation 决策、snapshot publish、closeout evidence projection 和下一轮 continuation 连起来。

决策：
- 新增 `test/autonomous-closeout-loop.test.js`。
- 测试路径固定为 `decideContinuation -> runCloseoutPlan -> createWorkbenchProjection -> decideContinuation`。
- 断言 closeout evidence 可见后，下一轮仍能生成 context pack seed 和 snapshot publish plan。

[2026-05-21T18:44:32+08:00] Closeout loop should be a reusable orchestration runner:
闭环只停留在测试里仍然不能被调度器直接调用。需要把相同步骤抽成平台模块和 CLI，使无人值守流程能以一个入口执行 continuation closeout。

决策：
- 新增 `runAutonomousCloseoutLoop`，输出 decision、closeout、projection 和 next_decision。
- 新增 `tools/run-autonomous-closeout-loop.mjs` 与 npm script。
- runner 失败时必须返回失败 phase 和结构化 issues，而不是只抛日志。

[2026-05-21T18:47:15+08:00] Orchestration runs need replayable artifacts:
只执行 orchestration runner 还不够，长任务恢复和问题定位需要保存输入与输出。否则下一次会话只能从控制台摘要推断上一轮事实。

决策：
- 新增 `autonomous-closeout-loop-run.v1` artifact envelope。
- CLI 支持 `--output <path>` 写入原始 input 与结构化 result。
- 测试和 smoke 都验证输出文件可读且包含 projection closeout evidence。

[2026-05-21T19:02:11+08:00] Replayable orchestration artifacts need a reuse gate:
用户提醒“结果不符合预期时先看流程问题”，本轮对应的流程缺口是：`autonomous-closeout-loop-run.v1` 已经能写出，但后续调度器或新会话可能不经校验直接复用损坏、串线或半完成的 orchestration artifact。

决策：
- 新增 `validateAutonomousLoopRunArtifact`，把 artifact 版本、宿主项目、输入/输出一致性、projection schema、run/cycle 身份、closeout 证据和下一轮 continuation 作为复用前不变量。
- 新增 `tools/check-autonomous-closeout-loop-run.mjs` 与 npm gate，校验失败必须非零退出。
- 该问题进入 process-hardening gate；未来任何 durable orchestration output 都必须有对应 reuse validator，不能只靠 CLI 日志或人工摘要判断可复用。

[2026-05-21T19:13:28+08:00] Replay validation must be wired into scheduler reuse:
独立 validator 仍然不足以保证无人值守流程不跑偏。如果 scheduler 或恢复路径可以绕过 validator 直接读取 replay artifact，流程仍会在错误事实基础上继续。

决策：
- 新增 `prepareAutonomousContinuationFromLoopArtifact`，作为 scheduler 从 replay artifact 继续前的结构化入口。
- valid artifact 才能产出 `continuation_input`、`context_pack_seed` 和 `snapshot_publish_plan`。
- invalid artifact 必须返回 `status=blocked`、`phase=replay_validation` 和 `replay_artifact_invalid` blocker，不生成 continuation input。
- `tools/run-autonomous-closeout-loop.mjs --resume-from <path>` 复用同一入口，作为当前 CLI 级恢复/继续路径。

[2026-05-21T19:24:04+08:00] Replay blockers must become workflow evidence:
只把 replay validation blocker 输出到 CLI stdout 仍然是旁路状态。只要 replay artifact 还包含可信的 `input.workflow_state`，失败 resume 就必须写入 workflow state，让工作台 projection 和 recovery evaluation 能看到这次失败。

决策：
- 新增 `recordReplayValidationBlocker`，写入 `autonomous_loop_replay_validation` manifest event。
- 同一失败写入 artifact ledger，artifact 类型为 `evaluation`、状态为 `fail`、producer 为 `autonomous-orchestrator`。
- `prepareAutonomousContinuationFromLoopArtifact` 在 blocked 且有 workflow state 时返回带 evidence 的 `workflow_state`，但仍不生成 continuation input。

[2026-05-21T19:34:42+08:00] DeepSeek Pro should absorb process-guard review under Codex plan pressure:
用户提醒 Codex plan 消耗速度可能无法支撑长时间自执行。多模型协同不能只在最后做 reviewer，应把 DeepSeek V4 Pro 前置到流程偏移和门禁完整性审查，减少 GPT/Codex 在可外包审查上的消耗。

决策：
- `model-router` 新增 `codex_plan_pressure` / `process_guard` 触发条件。
- 高风险平台 planning / implementation / recovery / review / final_review 在 plan 压力下新增 `deepseek-v4-pro` 的 `process_guard` 角色。
- `process_guard` 在 GPT 实现或仲裁前检查流程偏移、replay 安全和 gate 完整性；独立 reviewer 仍保留为合入前审查。
- 工作台 projection 的 model routing summary 暴露 `has_process_guard`。

[2026-05-21T19:40:25+08:00] DeepSeek reviewer timeouts need invocation profiles:
用户提醒 DeepSeek V4 Pro 介入程度需要提升，但现有 wrapper 超时容易让审查被误判为失败。DeepSeek 官方文档说明 Anthropic 兼容入口、Claude Code 模型名、keepalive 行为和 10 分钟未开始推理的服务端关闭边界，因此平台不应继续使用单一经验 timeout。

决策：
- `llm-reviewer-gate` 新增 `createReviewerInvocationPolicy`，按 `quick`、`process_guard`、`full_audit` 生成 timeout、effort、scope limits 和 split_required。
- reviewer timeout finding 必须携带 invocation policy，供 autonomous-run、process-hardening 和工作台判断是否应拆分 rerun。
- `process_guard` 默认 300 秒、`high` effort、最多 3 个文件 / 3 个问题 / 2200 字 prompt；超过边界必须拆分，而不是扩大单次上下文。
- DeepSeek reviewer 运行事实记录 `https://api.deepseek.com/anthropic`、`deepseek-v4-pro[1m]`、stream/keepalive 预期和 600 秒服务端 start timeout。
- reviewer 超时后先运行无工具 smoke；smoke 通过说明 provider 通道可用，应无工具重试或拆分文件复审，smoke 失败才把 provider 标记为 unhealthy。
- 平台记录手动脚本和 reviewer wrapper 的差异：手动 `./start-claude-deepseek-no-proxy.sh` 是交互路径，wrapper 是 `--bare -p --no-session-persistence --tools --add-dir` 非交互路径，诊断时必须区分。

[2026-05-21T19:47:02+08:00] Replay blockers need resume health in the workbench:
上一轮已经把 replay validation blocker 写入 workflow state，但如果 projection 和 PC/mobile shell 只通过 artifact failed 计数间接展示，操作者仍然无法一眼判断恢复继续是否健康。

决策：
- `createWorkbenchProjection` 新增 `resume_health`，汇总最近一次 `autonomous_loop_replay_validation` event、evidence artifact、issue count 和 latest issue。
- `createMobileWorkbenchProjection` 保留移动端恢复健康摘要。
- PC/mobile schema gate 必须要求 `resume_health` 对象。
- PC/mobile shell 直接渲染 resume health；browser closeout 验证必须检查桌面和移动端都显示该状态。

[2026-05-21T19:52:57+08:00] Reviewer provider health must be durable scheduler state:
DeepSeek smoke 和工具路径超时如果只存在于命令输出里，后续调度器仍可能重复排同一个失败 reviewer 路径，或错误地把 provider 判死。

决策：
- 新增 `reviewer-provider-health` workflow 模块，生成 `reviewer_provider_health` scheduler fact。
- timeout recovery 的状态机固定为：needs smoke -> smoke pass retry -> smoke fail fallback。
- provider health fact 同时写入 Run Manifest event 和 Artifact Ledger evaluation artifact。
- manifest / artifact ledger 身份不一致时失败闭合，不写半状态。
- Workbench projection 与 PC/mobile shell 展示最近一次 provider health、retry strategy 和 next action。

[2026-05-21T20:01:26+08:00] Provider health facts must drive continuation:
Provider health 如果只显示在工作台上，调度器仍可能停在“知道该做什么但没有 work package”的半自动状态。

决策：
- `decideContinuation` 读取 workflow state / projection 中的 `reviewer_provider_health`。
- `scheduled_actions` 自动转成 `next_work_packages` 和 `context_pack_seed.subtasks`。
- `rerun_without_tools`、`split_scope`、`provider_smoke_check`、`fallback_model_or_defer_external_review` 都有稳定 id、title 和 owned_files。
- fallback action 归入 `model-router` 与 `reviewer-provider-health`，避免继续排 unhealthy provider。

[2026-05-21T20:04:23+08:00] Provider health recording needs a CLI:
如果 provider health 只能靠一次性脚本写入，下一次 DS timeout 仍会回到人工操作和聊天记录状态。

决策：
- 新增 `tools/record-reviewer-provider-health.mjs`。
- 新增 `npm run record:reviewer-provider-health`。
- CLI 成功时写入 workflow state 并输出 artifact id、provider health、retry strategy 和 scheduled actions。
- CLI 读取失败或 workflow identity 不一致时必须非零退出，不能产生半状态。

[2026-05-21T20:06:35+08:00] Provider health recording needs a workbench API:
只有 CLI 仍然不够，浏览器和 operator action 后续也需要通过工作台服务写入同一类事实。

决策：
- `POST /api/workbench/reviewer-provider-health` 写入当前 history item 的 workflow state input。
- API 复用 `recordReviewerProviderHealthFact`，不另建一套语义。
- 没有 `input_path` 的静态 projection 不可写，必须失败闭合。
- 成功响应返回 fact 与重新生成的 projection。

[2026-05-21T20:09:44+08:00] Provider health must be recordable from the workbench:
API 存在但 UI 无入口，仍然会让 operator 回到手动 CLI 或聊天指令。

决策：
- PC/mobile 工作台新增 Smoke OK / Smoke Timeout 控件。
- 前端通过 `recordProviderHealth` 调用 `/api/workbench/reviewer-provider-health`。
- 成功后用 API 返回的 projection 直接刷新 provider health 与 next action。
- Browser gate 使用临时 workflow-state snapshot 点击 Smoke Timeout，验证页面更新为 unhealthy / fallback 且无横向溢出。

[2026-05-21T20:23:03+08:00] Smoke-pass DS tool timeouts need a concrete split layer:
本轮真实 DS 工具复审超时但无工具 smoke 通过，说明 provider 通道健康，问题更可能在工具路径或请求范围。继续原样重跑会浪费时间并可能卡住自动流程。

决策：
- 新增 `reviewer-scope-splitter`，把 reviewer request 转成 bounded shards。
- shard 必须受 profile 的 files/questions/prompt chars 限制，并保留 provider、model、profile、output contract 和 forbidden actions。
- `tool_timeout_recovery` 支持更保守的一文件一 shard，并可生成 `no_tools` shard，避免重复提交同一个会超时的工具请求。
- split plan 必须写入 `reviewer_scope_split` manifest event 和 artifact ledger evaluation artifact。
- continuation 已有 concrete shards 时，生成 `run_reviewer_scope_shard` work packages，不再重复排抽象 `split_scope`。
- PC/mobile projection 展示 shard_count、pending_shards、next_shard，让工作台能看到 DS reviewer 是否正在按分片推进。

[2026-05-21T20:33:37+08:00] Reviewer shards need durable results and aggregation:
拆分层只解决“怎么避免 DS 工具复审超时”，但如果 shard 执行结果只停留在命令输出，自动流程仍不能判断下一步，也可能重复派发已经跑完的 shard。

决策：
- 新增 `reviewer-shard-results`，分别记录 `reviewer_shard_result` 和 `reviewer_shard_aggregate`。
- 每个 shard result 写入 manifest event 和 review artifact，包含 shard_id、files、questions、findings 和失败 finding 数。
- aggregate 只能汇总当前 split plan 内的已知 shard；未知 shard 失败闭合。
- pending shard 存在时 aggregate 不把 findings 写入 `manifest.review_findings`。
- 全部 shard 完成后，aggregate 的 merged_findings 追加到 `manifest.review_findings`，复用 `evaluateRunResult` 的 pass/rerun/rollback/human_intervention 判断。
- continuation 会跳过已有 shard result 的 shard，避免重复派发。
- 工作台 projection 增加 `reviewer_shard_review`，PC/mobile 展示 shard review 状态、完成数和失败 finding 数。

[2026-05-21T20:54:34+08:00] Reviewer shard outputs need reusable recording paths:
如果 shard result 只能通过人工改 workflow JSON 写入，真实 DS shard review 仍然会卡在人工介入点，且容易和 projection history 脱节。

决策：
- 新增 `tools/record-reviewer-shard-result.mjs` 和 `npm run record:reviewer-shard-result`。
- CLI 支持 `--findings-json`、`--findings-file`、`--aggregate` 和 `--in-place`。
- 新增 `POST /api/workbench/reviewer-shard-result`，复用同一套 `recordReviewerShardResult` / `recordReviewerShardAggregate` 语义。
- API 只允许写入 history item 的 `input_path` workflow state；静态 projection 失败闭合。
- `projection-source` 增加 `recordReviewerShardResult`，后续 UI/operator action 不需要手写 API 调用。

[2026-05-21T21:39:23+08:00] Reviewer shard execution needs a provider-neutral runner:
有 split plan、result recording 和 API 仍不够；如果没有统一 runner，调度器仍需要人工挑选 pending shard、拼 prompt、调用 provider、记录结果、判断是否 aggregate。

决策：
- 新增 `reviewer-shard-runner`。
- runner 只选择尚无 `reviewer_shard_result` 的 pending shard。
- runner 构造只读 prompt，但不硬编码 DeepSeek、Claude Code 或 GPT；真实执行通过 executor adapter 注入。
- executor 返回后复用 `recordReviewerShardResult`。
- 最后一个 shard 完成后自动调用 `recordReviewerShardAggregate`。
- 缺少 executor 或 shard 不在 pending 集合中时失败闭合。

[2026-05-21T21:43:51+08:00] DeepSeek shard execution must use the canonical launcher wrapper:
用户之前确认手动 `./start-claude-deepseek-no-proxy.sh` 可工作，历史 timeout 很可能来自非交互 wrapper 路径、工具范围或大 prompt。平台不能再各处拼不同启动命令。

决策：
- 新增 `claude-deepseek-shard-executor`。
- 适配器通过 skill wrapper `/Users/hernando_zhao/.codex/skills/claude-deepseek-review/scripts/run_claude_deepseek_review.py` 调用 canonical launcher。
- 默认模型 `deepseek-v4-pro[1m]`，timeout 继承 shard/profile。
- allowed_tools 直接来自 shard；no-tools shard 传空 tools。
- stdout 支持 JSON array 和 `{ findings: [...] }` 两种结构化输出。
- timeout 和 wrapper 非零退出转为结构化 reviewer finding，由 shard result/aggregate 进入统一恢复流程。

[2026-05-21T21:47:54+08:00] Reviewer shard runner needs a scheduler CLI:
runner 和 DeepSeek executor 只有模块接口还不够，调度器和恢复脚本需要一个稳定 CLI 从 workflow state 读取 pending shard、执行、写回状态。

决策：
- 新增 `tools/run-reviewer-shard.mjs` 和 `npm run run:reviewer-shard`。
- CLI 默认执行第一个 pending shard，也支持 `--shard-id`。
- 默认 executor 是 Claude+DeepSeek adapter。
- 支持 mock findings/status 以便 deterministic tests 不触发真实模型。
- 成功写回 workflow state；最后一个 shard 自动 aggregate。
- 输入不可读或 shard 不可执行时非零退出。

[2026-05-21T22:03:19+08:00] Runner-level timeout must publish provider health facts:
真实 DS shard 试运行通过，说明 canonical launcher 在 no-tools shard 场景下可用。但 timeout 路径也必须被流程托管，否则 runner 会把 provider 问题降级为普通 review finding。

决策：
- `runReviewerShard` 支持 `record_provider_health_on_timeout`。
- CLI 暴露 `--record-provider-health` 和 `--provider-smoke-status`。
- 当 shard result findings 中存在 `category=reviewer_timeout` 时，runner 写入 `reviewer_provider_health`。
- 未提供 smoke status 时，provider health 进入 `needs_smoke_check`，scheduled action 为 `provider_smoke_check`。
- 成功 shard 不写 provider health，避免健康事实噪音。
- 真实 DS shard 成功记录在 `docs/evaluations/20260521_REAL_DS_REVIEWER_SHARD_RUN_CN.md`。

[2026-05-21T22:08:20+08:00] Reviewer shard execution needs a bounded self-progress loop:
只提供“执行一个 pending shard”的 CLI 仍会让调度器在每个分片后停下来等待主进程选择下一步，不符合中台低人工介入目标。平台需要把“继续到 aggregate 或可恢复故障点”代码化。

决策：
- 新增 `runReviewerShardsUntilAggregate`，连续消费 pending reviewer shard。
- loop 默认最多执行 20 个 shard，可通过 `--max-shards` 缩小或扩大。
- 任一 shard 写入 provider health recovery fact 后，默认停止并返回 `provider_health_recorded`，让调度器先跑 smoke/fallback，而不是继续消耗同一问题路径。
- `tools/run-reviewer-shard.mjs --all` 暴露同一语义，供 scheduler/closeout 直接调用。
- 显式传入 `--shard-id` 时，即使使用 `--all` 也只执行该 shard，避免指定范围被自动扩大。
- 确定性 mock 测试覆盖 aggregate loop 与 timeout recovery stop。

[2026-05-21T22:13:41+08:00] Continuation must re-evaluate completed reviewer shard aggregates:
runner 已经能生成 `reviewer_shard_aggregate`，但如果 continuation 继续相信旧的 `run_evaluation=pass`，失败 findings 会被工作台看到却不会进入下一轮调度，这会形成新的跑偏。

决策：
- `decideContinuation` 在发现完成态 reviewer shard aggregate 后，用 aggregate 的 `merged_findings` 重新调用 `evaluateRunResult`。
- pending aggregate 不参与最终决策，仍交给 shard work packages 继续推进。
- aggregate fail 可以覆盖旧 pass，进入统一 rerun/rollback/human decision。
- aggregate pass 可以覆盖旧 reviewer timeout rerun，避免已经恢复的问题继续重复调度。
- 显式 human/rollback evaluation 不被 aggregate 覆盖。

[2026-05-21T22:17:59+08:00] Reviewer shard loops need replayable run artifacts:
`run-reviewer-shard --all` 能推进分片，但如果只把结果写回 workflow state，调度器和后续会话无法审计这次 loop 是如何到达 aggregate 或 provider-health stop 的。

决策：
- 新增 `reviewer-shard-loop-run.v1` artifact envelope。
- artifact 保存输入 workflow state、runner 参数、runs、aggregate/provider health、输出 workflow state。
- validator 检查版本、run/cycle identity、状态/phase 一致性，以及 aggregated/provider_health_recorded phase 的必要字段。
- `tools/run-reviewer-shard.mjs --run-artifact-output` 写出该 artifact，供后续 closeout/continuation 和 replay gate 复用。

[2026-05-21T22:24:46+08:00] Scheduler must reuse reviewer shard loop artifacts without manual JSON assembly:
试运行证明 shard loop artifact 可以接入 closeout，但当前仍需要主进程手工拼 continuation input。这个手工步骤本身就是未来中台卡住或跑偏的风险。

决策：
- 新增 `prepareReviewerShardLoopContinuationInput`。
- 新增 `tools/prepare-reviewer-shard-loop-continuation.mjs` 和 `npm run prepare:reviewer-shard-loop-continuation`。
- 复用入口只接受 validation pass 的 `reviewer-shard-loop-run.v1`。
- 输出的 continuation input 保留 artifact 输出 workflow state，并标记 `run_evaluation.source=reviewer-shard-loop-run.v1`。
- 无效 artifact 必须 fail closed，不能生成 continuation input。

[2026-05-21T22:29:57+08:00] Reviewer shard work packages need a concrete dispatch plan:
continuation 生成 `run_reviewer_scope_shard` work packages 后，如果 scheduler 不能把它们映射为稳定命令链，主进程仍会回到人工拼命令状态。

决策：
- 新增 `scheduler-dispatch-plan`。
- 对 `run_reviewer_scope_shard` work packages 生成三步计划：run reviewer shard loop、prepare continuation input、run autonomous closeout loop。
- runner step 默认使用 `--all` 和 `--record-provider-health`，避免每个 shard 后停住或 timeout 后丢失 health fact。
- dispatch planner 缺少 workflow state input path 时失败闭合。
- CLI `tools/create-scheduler-dispatch-plan.mjs` / `npm run plan:scheduler-dispatch` 写出可审计计划 JSON，后续执行器只需要按 steps 运行。

[2026-05-21T22:34:02+08:00] Scheduler dispatch execution must be bounded:
有了 dispatch plan 后，如果执行器允许任意 command，自动执行会变成新的安全和跑偏入口。执行器必须只运行平台明确支持的 scheduler steps。

决策：
- 新增 `scheduler-dispatch-runner`。
- 执行前验证计划和 step dependencies。
- 仅允许三个白名单 npm scripts：`run:reviewer-shard`、`prepare:reviewer-shard-loop-continuation`、`run:autonomous-closeout-loop`。
- 任一步失败立即停止，输出结构化 issue。
- 新增 `scheduler-dispatch-run.v1` artifact，保存 step 结果和 dry-run 标记。
- CLI `tools/run-scheduler-dispatch-plan.mjs` 支持 `--dry-run`，用于在真实执行前验证计划。

[2026-05-21T22:37:14+08:00] Deterministic scheduler trials need explicit reviewer mock options:
要真实运行完整 scheduler dispatch chain，但不能每次都消耗 DS。mock reviewer 不能在执行器阶段偷偷注入，否则 replay artifact 无法解释为什么没有调用外部模型。

决策：
- dispatch planner 支持 `reviewer_mock_status` 和 `reviewer_mock_findings_json`。
- CLI 暴露 `--reviewer-mock-status` / `--reviewer-mock-findings-json`。
- mock 参数写入计划的 reviewer shard loop step。
- runner 仍只执行计划，不在执行阶段隐式改命令。

[2026-05-21T22:44:02+08:00] Scheduler dispatch evidence must be visible in the workbench:
调度链即使成功执行，如果结果只存在于 CLI artifact 文件中，operator 工作台仍无法判断自动流程是否真的推进。

决策：
- `scheduler-dispatch-runner` 支持把 `scheduler-dispatch-run.v1` 记录回 workflow state。
- 写入 `scheduler_dispatch_run` manifest event 和 `scheduler-dispatch-runner` evaluation artifact。
- Workbench Projection 增加 `scheduler_dispatch`。
- PC/mobile schema 都要求 scheduler dispatch summary。
- one-screen counters 增加 `scheduler_dispatch_steps`。

[2026-05-21T22:55:38+08:00] Projection fields are not complete until the shell renders and browser-verifies them:
本轮 schema/projection 已经有 `scheduler_dispatch`，但 PC/mobile shell 还没有可见区域。对于工作台类能力，仅有 JSON 字段不算闭环。

决策：
- PC shell 增加 Scheduler Dispatch 面板和 Scheduler Steps 指标。
- Mobile shell 增加自动调度区块和调度步数指标。
- `workbench.js` 统一绑定 PC/mobile 的 scheduler dispatch status、phase、step、failed、dry-run 和 artifact。
- `check-workbench-browser-events` 必须验证 PC/mobile 都实际渲染 scheduler dispatch 字段，并继续检查无横向溢出。
- Browser 可视复查发现的布局问题必须在同轮修复，不把“测试通过但视觉压缩”留到后续补丁。

[2026-05-21T23:00:04+08:00] Scheduler dispatch recording must be service-backed and identity-checked:
调度执行结果如果只能通过手工 JSON 写回 workflow state，自动流程仍会在“执行完成 -> 工作台刷新”之间断开。服务端写入又必须防止 run/cycle 漂移污染当前 snapshot。

决策：
- Workbench server 增加 `POST /api/workbench/scheduler-dispatch-run`。
- 只允许写入带 `scheduler-dispatch-run.v1` version、明确 pass/fail status 和 result.steps 的 artifact。
- 写入前要求 history item 有 `input_path`，禁止写入静态 projection fallback。
- `recordSchedulerDispatchRunArtifact` 拒绝 artifact run/cycle 与 workflow state manifest 不一致。
- Projection Source 增加 `recordSchedulerDispatchRun`，供后续调度执行器或工作台控制面复用。

[2026-05-21T23:02:49+08:00] Scheduler dispatch CLI must close the loop into workbench writeback:
有服务端写回 API 后，如果 `run:scheduler-dispatch` 仍只输出本地 artifact 文件，自动调度和工作台状态之间仍需要人工搬运。

决策：
- `run-scheduler-dispatch-plan.mjs` 增加 `--workbench-base-url`。
- 可选 `--projection-id` 指定 history item，避免写错当前 snapshot。
- CLI 先写本地 `scheduler-dispatch-run.v1` artifact，再 POST 到 `/api/workbench/scheduler-dispatch-run`。
- 只要 artifact 执行失败或服务写回失败，CLI 都以失败退出。
- 集成测试必须证明 CLI dry-run 后 workflow snapshot 和 projection 都显示 `scheduler_dispatch.status = pass`。

[2026-05-21T23:05:54+08:00] Scheduler writeback must have an executable browser-visible e2e gate:
单元测试能证明 API 和 CLI 接通，但不能证明 operator 打开的 PC/mobile 工作台真的显示更新后的调度状态。

决策：
- 新增 `check:scheduler-dispatch-writeback`。
- 门禁启动真实 workbench server，创建临时 workflow snapshot 和 projection history。
- 运行 `run-scheduler-dispatch-plan --dry-run --workbench-base-url --projection-id`。
- 读取服务端 projection，要求 `scheduler_dispatch.status = pass` 且 step_count 为 3。
- 使用 Playwright 打开 PC/mobile 工作台，要求页面可见调度状态为 pass、step 为 3，并无横向溢出。
- `check:closeout` 纳入该 e2e gate，避免未来只改 JSON 不改实际工作台显示。

[2026-05-21T23:08:56+08:00] Scheduler writeback mode belongs in the dispatch plan:
只靠 `run-scheduler-dispatch-plan` 的命令行参数会让 scheduler 输出和工作台写回策略分离，后续自动调度仍可能忘记传参。

决策：
- `scheduler-dispatch-plan` 增加 `writeback` 配置。
- 支持 `mode: none | service`，service 模式必须有 `workbench_base_url`。
- planner CLI 支持 `--workbench-writeback-mode`、`--workbench-base-url`、`--projection-id`。
- runner CLI 在命令行参数缺省时读取 plan.writeback。
- scheduler writeback e2e 改为只传 `--plan/--output/--dry-run`，证明写回策略来自计划本身。

[2026-05-21T23:11:54+08:00] Workbench service can generate scheduler dispatch plans from history context:
让外部流程手工传 workflow state input path、projection id 和 service URL 仍然容易跑偏。工作台服务已经持有 projection history，应由它生成带正确上下文的计划。

决策：
- Workbench server 增加 `POST /api/workbench/scheduler-dispatch-plan`。
- 计划生成必须基于 history item 的 `input_path`，没有 input_path 的静态 projection 不允许生成计划。
- service writeback 的 `base_url` 由当前请求 Host 推导，并对 Host 做字符白名单校验。
- 生成计划自动填入 `projection_id` 为当前 history id。
- Projection Source 增加 `createSchedulerDispatchPlan`，为工作台控制面后续触发调度计划预留稳定接口。

[2026-05-21T23:15:42+08:00] Workbench scheduler control must not be optimistic:
工作台按钮如果点击后直接改 UI，会复现之前“看起来成功但实际没写入”的问题。调度控制必须等服务端完成计划、执行和写回后再刷新 projection。

决策：
- Workbench server 增加 `POST /api/workbench/scheduler-dispatch`。
- 当前工作台控制仅允许 `dry_run`，非 dry-run 请求失败闭合。
- 服务端基于 history input 生成计划，执行 scheduler dry-run，写回 scheduler dispatch artifact，再返回新的 projection。
- PC/mobile shell 增加 `data-scheduler-dispatch="dry-run"` 控制。
- `workbench.js` 只在服务返回 projection 后调用 `renderProjection`；失败时显示“调度失败”。
- `check-workbench-browser-events` 增加 scheduler dispatch click 场景，验证按钮点击后页面显示 pass/3 steps 且无横向溢出。

[2026-05-21T23:18:42+08:00] Non-dry-run scheduler dispatch requires an explicit execution policy:
非 dry-run 不能从工作台按钮直接放开，否则会把外部 reviewer 调用、npm 执行链和成本消耗都暴露成一个普通 UI 开关。

决策：
- 新增 `scheduler-dispatch-policy`。
- dry-run 默认允许，execution mode 为 `dry_run`。
- 非 dry-run 必须提供 `approved_non_dry_run` operator authorization。
- 非 dry-run 必须提供 `max_steps`，并且不能超过当前三步调度链。
- reviewer 成本必须显式声明：mocked reviewer 要求外部 reviewer call budget 为 0；非 mocked reviewer 要求 bounded provider cost mode 与 shard 数以内的 call budget。
- Workbench server 在执行 `/api/workbench/scheduler-dispatch` 前先评估 policy；policy 失败时不执行、不写回。

[2026-05-21T23:27:50+08:00] Scheduler dispatch policy decisions must be durable projection facts:
只在接口响应里返回 policy 拒绝原因不够，下一轮恢复、工作台刷新或长任务重启后会丢失“为什么没有执行”的证据。

决策：
- 新增 `scheduler_dispatch_policy` manifest event 和 `scheduler-dispatch-policy.v1` artifact。
- Workbench server 在执行或拒绝 scheduler dispatch 前必须先记录 policy decision。
- policy 拒绝时可以写入 policy 证据，但不得执行计划或写入 scheduler dispatch run artifact。
- Workbench projection 必须展示 latest policy status、execution mode、issue count 和首个 issue。
- PC/mobile 工作台必须从 projection 渲染 policy 状态，不能只依赖按钮失败文本。

[2026-05-21T23:39:44+08:00] Approved non-dry-run dispatch must use named bounded profiles:
让前端或调用方直接拼 `operator_authorization/max_steps/provider_cost_mode` 会把安全边界扩散到多个入口，后续容易漏配或绕过。

决策：
- 新增 `approved_mock_non_dry_run` scheduler dispatch profile。
- 服务端先 normalize profile，再生成 plan 和评估 policy；未知 profile 必须失败闭合。
- `approved_mock_non_dry_run` 展开为非 dry-run、`approved_non_dry_run`、`max_steps=3`、`max_external_reviewer_calls=0`、`provider_cost_mode=mocked`、`reviewer_mock_status=pass`。
- PC/mobile 工作台新增“批准 Mock 执行”控制，但只发送 profile，不直接拼安全参数。
- 非 dry-run 试运行暴露了两个底座缺口：reviewer shard CLI 必须创建输出目录；snapshot publisher 必须能在受控路径内初始化缺失的 projection history。

[2026-05-21T23:45:13+08:00] Scheduler dispatch artifacts must summarize downstream continuation:
只知道 scheduler 三步都成功仍然不够，工作台还需要知道 closeout loop 是否产生下一轮任务，否则“自动执行后是否该继续”仍要人工读 stdout。

决策：
- Scheduler dispatch runner 在非 dry-run step 成功后读取声明的 `outputs` 文件。
- `scheduler-dispatch-run.v1` step result 必须包含 reviewer shard loop、continuation input、autonomous closeout loop 的结构化摘要。
- Workbench projection 从 closeout loop artifact 摘要中展示 next continuation status、action 和 next work package count。
- PC/mobile 工作台展示 approved dispatch 后的下一轮任务数量。

[2026-05-21T23:50:12+08:00] Scheduler dispatch continuation must reuse replay validation:
approved dispatch 产生下一轮 continuation input 时，不能直接信任 scheduler artifact 里的路径或摘要；必须重新读取 closeout loop artifact 并走既有 replay validator。

决策：
- 新增 `scheduler-dispatch-continuation` adapter。
- 输入 `scheduler-dispatch-run.v1`，定位 `run-autonomous-closeout-loop` 的声明输出路径。
- 读取 closeout loop artifact 后复用 `prepareAutonomousContinuationFromLoopArtifact`。
- 新增 `prepare:scheduler-dispatch-continuation` CLI，输出下一轮 continuation input。
- 缺失路径、非 pass scheduler run、不可复用 closeout artifact 都必须 blocked，不得生成下一轮输入。

[2026-05-21T23:54:05+08:00] Scheduler dispatch runner may emit next continuation input directly:
独立 adapter 解决了复用问题，但如果 `run-scheduler-dispatch-plan` 完成后还要外部再手工调用 adapter，长任务仍然可能停在中间。

决策：
- `tools/run-scheduler-dispatch-plan.mjs` 增加 `--continuation-output`。
- 当该参数存在时，runner 写出 scheduler dispatch run artifact 后立即调用 replay-validating adapter。
- continuation 生成失败时 runner 必须非零退出，不能把 artifact pass 伪装成整体 pass。
- CLI summary 必须包含 continuation status、output 和 next work package count。

[2026-05-21T23:57:39+08:00] Scheduler dispatch plans carry continuation output destinations:
如果 continuation output 仍只存在于 CLI flag，自动调度器还会在“生成 plan”和“执行 plan”之间丢失下一轮输出位置。

决策：
- `createSchedulerDispatchPlan` 增加 `continuation_output`，默认写入 scheduler run 目录。
- `run-scheduler-dispatch-plan` 在非 dry-run 且未显式传 `--continuation-output` 时读取 plan 内的 continuation output。
- dry-run 不自动生成 continuation input，避免把结构验证伪装成可复用下一轮。

[2026-05-22T00:18:00+08:00] Scheduler continuation readiness must lead to a next-cycle enqueue:
只在 scheduler dispatch artifact 中展示 next continuation 还不够；如果工作台 history 看不到“下一轮输入已准备好”，或者没有服务端入口消费这个输入，长任务仍可能停在“看起来可继续但无人接手”的状态。

决策：
- 受控非 dry-run scheduler dispatch 成功后，Workbench server 必须生成 plan 声明的 scheduler continuation input，并写入 `scheduler_dispatch_continuation` event/artifact。
- Projection 和 projection history 必须展示 continuation readiness、enqueue availability、continuation input path 和 next work package count。
- 新增 `POST /api/workbench/scheduler-next-cycle`，只从 history `input_path` 的最新 scheduler dispatch run artifact 出发，重新运行 replay-validating adapter，读取并校验已生成的 continuation input。
- next-cycle enqueue 成功后写入 `scheduler_next_cycle_enqueue` event/artifact，并发布下一轮 workflow snapshot 到 projection history。
- 该入口不触发新的外部执行；缺少 input_path、缺少 dispatch run、continuation path 越界、adapter blocked 或 generated input 身份不一致都必须失败闭合。

[2026-05-22T00:31:00+08:00] Autonomous scheduler loop must be bounded and transport-driven:
有了 `scheduler-next-cycle` 之后，仍需要一个可复用的 loop driver 把“执行当前轮 -> 发布下一轮 -> 继续下一轮”串起来，否则系统还是依赖当前会话继续发起下一步。

决策：
- 新增 `src/workflow/autonomous-scheduler-loop.js`，只做 loop 状态机和 artifact 汇总，通过注入 client 调用 workbench 服务，不重复实现 dispatch runner。
- 新增 `tools/run-autonomous-scheduler-loop.mjs` 和 `npm run run:autonomous-scheduler-loop`。
- CLI 只允许本机 HTTP workbench base URL，避免自运行 loop 打到远端未知服务。
- 当前 loop 只允许命名 profile `approved_mock_non_dry_run`，`max_iterations` 限制在 1-5。
- 每轮按 `scheduler-dispatch-plan -> scheduler-dispatch -> scheduler-next-cycle` 推进；无 dispatchable steps、continuation 未 ready、enqueue 未返回 next item 或达到迭代上限时停止并输出 `autonomous-scheduler-loop-run.v1`。
- 服务端集成测试必须用异步子进程，不能用同步 `execFileSync` 阻塞同进程里的 workbench server。

[2026-05-22T00:47:00+08:00] Autonomous scheduler loop must be visible and operator-triggerable from the workbench:
自运行能力如果只存在于 CLI，仍然会和工作台状态脱节。工作台需要能看到 loop 运行结果，也需要一个受限入口启动 bounded loop。

决策：
- `autonomous_scheduler_loop_run` 被记录为 manifest event 和 artifact ledger artifact。
- Workbench projection 增加 `scheduler_loop` summary，PC/mobile schema 都要求该对象存在。
- Workbench server 增加 `POST /api/workbench/autonomous-scheduler-loop`，服务端运行 bounded loop 后把 loop artifact 写回发起 history item 的 workflow state。
- PC/mobile 工作台展示 loop status、iteration count 和 latest projection id。
- 前端按钮只发送 `max_iterations=1`、`execution_profile=approved_mock_non_dry_run` 和 snapshot prefix，不拼底层 policy 控制。
- 浏览器门禁增加 `autonomous_scheduler_loop_click`，验证页面点击能完成一轮 loop 且不产生横向溢出。

[2026-05-22T01:18:00+08:00] Autonomous scheduler loop recovery must be registry-driven:
用户要求长任务在断网、睡眠、重启后仍能继续，这不能依赖当前会话记忆。上一段 loop 运行虽然能写入 fact，但缺少从 durable facts 重建历史、校验 artifact、判断恢复动作的代码路径。

决策：
- 在 `src/workflow/autonomous-scheduler-loop.js` 增加 `validateSchedulerLoopRunArtifact`，校验 loop artifact version、status/phase/result 一致性、iteration schema 和 queued next projection。
- 增加 `buildSchedulerLoopRunRegistry`，只从 manifest events 与 artifact ledger 构建 loop history readout，不解析 stdout、tmp 日志或当前聊天上下文。
- 增加 `evaluateSchedulerLoopRecovery`，把 registry 映射为 `ready/resume_from_latest_projection`、`blocked/quarantine_invalid_loop_artifact`、`idle/wait_for_new_work` 或 recoverable retry。
- Workbench projection 和 `/api/workbench/projections` history readout 展示 run count、invalid count、recovery status/action、resumable、resume projection id。
- PC/mobile 工作台渲染 recovery 状态，浏览器门禁验证 loop 点击后 recovery 进入 ready。

[2026-05-22T01:36:00+08:00] Scheduler loop resume must be service-selected:
有了 recovery policy 后，如果下一步仍要求当前会话或操作者手动选择 projection id，自运行仍会在上下文切换时断掉。恢复入口必须消费 durable registry，而不是消费聊天记忆。

决策：
- 新增 `POST /api/workbench/autonomous-scheduler-loop-resume`。
- 入口从所选 history input 读取 loop registry/recovery policy；只有 `ready` 且有 `resume_projection_id` 时才执行。
- 服务端用 registry 选出的 `resume_projection_id` 作为 loop 起点，不接受前端拼底层 scheduler id。
- 新 loop artifact 写入 resume projection 的 workflow state，而不是写回源 projection，避免跨轮状态混淆。
- 没有 ready recovery、resume projection 缺少受控 `input_path` 或 loop 记录失败时必须失败闭合。

[2026-05-22T01:48:00+08:00] Workbench resume control may pass only source history context:
直接给前端一个“恢复到某个 projection id”的能力会绕开 registry recovery policy，等价于把恢复策略移回 UI。UI 需要能触发恢复，但不能决定真正的恢复目标。

决策：
- PC/mobile 增加 `恢复 Loop` 控制。
- Projection source 允许把 `projection_id` 作为 query `id` 传给服务端，但会从 JSON body 中移除，避免混入执行输入。
- `运行 Loop` 和 `恢复 Loop` 都只使用当前 history item id 作为 source context。
- 服务端 resume endpoint 仍负责选择真正的 `resume_projection_id`。
- 浏览器门禁在同一场景中执行 `运行 Loop -> 恢复 Loop`，并验证恢复后状态为 pass/idle 且无横向溢出。

[2026-05-22T02:04:00+08:00] Scheduler loop resume attempts must be durable facts:
resume endpoint 如果只返回 HTTP response，重启后就无法知道是否发生过 blocked resume、是否已经从某个 source projection 尝试恢复、恢复是否写到了目标轮。这个缺口会让“无需人工介入”的状态管理再次退回聊天记忆。

决策：
- 新增 `scheduler-loop-resume-attempt.v1` artifact。
- `recordSchedulerLoopResumeAttempt` 写入源 workflow state 的 manifest event 和 artifact ledger。
- blocked recovery、缺少 resume input、loop 执行失败、loop 执行成功都必须记录 attempt。
- 成功 attempt 记录 source projection、resume projection、loop status/phase 和目标 loop artifact id。
- Workbench projection 的 `scheduler_loop` 摘要展示 latest resume status、target 和 issue；PC/mobile 工作台渲染 resume attempt status。

[2026-05-22T02:19:00+08:00] Workbench projection needs an operations timeline:
随着 scheduler dispatch、continuation、loop、resume、reviewer recovery 都成为 facts，只看单个摘要会丢失顺序。操作者不应该去读 raw manifest events 才能知道系统刚刚做了什么。

决策：
- `createWorkbenchProjection` 增加 `operations_timeline`，从 durable manifest events 与 artifact ledger metadata 派生，不读日志。
- 时间线覆盖 scheduler policy/run/continuation/enqueue、autonomous loop、resume attempt、reviewer provider health、scope split、shard result/aggregate。
- PC projection 保留最近 12 条，mobile projection 保留最近 5 条。
- one-screen counters 增加 `operation_events`。
- PC/mobile 工作台渲染运行时间线；浏览器门禁验证 loop/resume 后时间线存在且无横向溢出。

[2026-05-22T02:28:00+08:00] Operations timeline entries need action semantics:
时间线如果只有“发生了什么”，后续自动调度器仍可能把所有事件都当成下一步驱动。需要在 projection 层固定哪些是自动推进信号，哪些只是给操作者看的观察事实。

决策：
- 每个 timeline item 增加 `group`：当前为 `scheduler` 或 `reviewer_recovery`。
- 每个 timeline item 增加 `next_action_role`：`automation_driver` 或 `operator_observable`。
- `scheduler_dispatch_run` 等执行记录默认是观察事实；ready continuation、next-cycle enqueue、pass loop/resume、provider recovery、scope split 和 shard aggregate 是自动推进信号。
- `operations_timeline` 增加 `driver_count`、`operator_only_count`、`group_counts` 和 `latest_driver`。
- PC/mobile 渲染 group/role，避免 UI 使用 raw event type 自行推断语义。

[2026-05-22T02:39:00+08:00] Projection exposes a single scheduler-facing next action:
即使 timeline 已有 action semantics，调度器仍不应该每次扫描完整 timeline 来决定下一步。Projection 需要提供单一、可测试的 next-action readout。

决策：
- `createNextActionReadout` 从 `operations_timeline.latest_driver` 和相关摘要派生推荐动作。
- `scheduler_dispatch_continuation` 推荐 `enqueue_scheduler_next_cycle`。
- `scheduler_next_cycle_enqueue` 推荐 `run_autonomous_scheduler_loop`。
- pass loop 且 recovery ready 推荐 `resume_autonomous_scheduler_loop`，否则推荐检查 loop。
- reviewer provider health、scope split、shard aggregate 分别推荐对应 reviewer recovery/continuation 动作。
- PC/mobile schema 要求 `next_action_readout`，工作台渲染 action/status/source。

[2026-05-22T03:08:00+08:00] Recommended actions need a guarded executor:
`next_action_readout` 只能告诉系统“应该做什么”，不能直接等同于执行授权。否则 UI 或调度器可能在 projection 变化后继续执行旧动作，或者把尚未代码化的 reviewer/inspect 动作伪装成成功。

决策：
- 新增 `POST /api/workbench/next-action`。
- 服务端必须重新计算所选 history input 的 projection，并校验调用方传入的 `expected_action` 未漂移。
- 当前白名单只允许 `enqueue_scheduler_next_cycle` 和 `run_autonomous_scheduler_loop`。
- 未接入的推荐动作，包括 reviewer shard、resume、inspect，必须返回 409 并带回 projection/readout。
- PC/mobile 可以提供“执行推荐动作”控件，但控件只传 projection id、expected action 和 bounded 参数，不传底层 scheduler policy 授权。

[2026-05-22T03:18:00+08:00] Operations timeline must use manifest causality, not wall-clock sort:
真实浏览器门禁发现：fixture 中 reviewer split 的 `created_at` 晚于当前进程时间，导致新追加的 scheduler continuation 在 manifest 里是最新事实，但按时间排序时被旧 reviewer fact 压住，`next_action_readout` 继续推荐 reviewer shard。

决策：
- `operations_timeline.items` 保留 manifest event 追加顺序，并增加 `sequence`。
- `latest` 和 `latest_driver` 按 manifest 顺序取最后一项，不再按 `created_at` 排序。
- `created_at` 仅作为展示字段，不作为平台内因果顺序。
- 浏览器门禁必须覆盖 approved dispatch 后点击 guarded next action，防止推荐动作被时钟偏移隐藏。

[2026-05-22T03:32:00+08:00] Reviewer shard recovery joins guarded next-action execution:
如果 `run_reviewer_scope_shard` 只是 projection 推荐动作，自动流程仍会在 reviewer recovery 上停住。这个动作需要进入看板服务流程，而不是停留在 skill 或手工命令层。

决策：
- 新增 `POST /api/workbench/reviewer-shard-run`。
- 服务端从所选 workflow state 中读取 pending reviewer shard，调用 `runReviewerShard`，并把结果写回同一个 history input。
- `POST /api/workbench/next-action` 白名单加入 `run_reviewer_scope_shard`，仍先校验 `expected_action` 未漂移。
- 默认 executor 使用 provider-neutral runner + Claude/DeepSeek adapter；测试和受控 profile 必须显式传 mock reviewer 输出。
- unsupported next action 仍保留失败闭合，当前 resume/inspect 不被隐式执行。

[2026-05-22T03:48:00+08:00] Scheduler loop can be driven by projection recommendations:
原来的 autonomous scheduler loop 只知道 `scheduler-dispatch-plan -> scheduler-dispatch -> scheduler-next-cycle`。这条路径稳定，但不能验证“工作台 projection 推荐动作 -> 服务端受控执行 -> durable state 写回”的通用中台流程。

决策：
- `runSchedulerLoopDriver` 保留默认 `scheduler_dispatch_chain` 策略。
- 新增 `projected_next_action` 策略：每轮读取 projection，取 `next_action_readout`，通过 `/api/workbench/next-action` 执行。
- `projected_next_action` 遇到 `inspect_*` 或无 ready action 时停止，而不是伪造成功执行。
- Workbench server 和 CLI 都可以传入 `execution_strategy`。
- 测试用 reviewer mock 输出验证 projected loop 可以连续执行 reviewer shards 并写回 aggregate。

[2026-05-22T04:02:00+08:00] Projected next-action loop needs a visible trial profile:
Projected strategy 如果只存在于 API 和单测里，后续很容易再次被当成内部实现细节遗忘。它需要在工作台里成为可观察的试运行 profile。

决策：
- PC/mobile 工作台新增 `Projected Mock Loop` 控制。
- 控制使用 `execution_strategy=projected_next_action`、`max_iterations=2`、`reviewer_mock_status=pass`。
- 这个 profile 只用于有界试运行，不代表真实 reviewer 永远 mock。
- 浏览器门禁新增 `projected_mock_loop_click`，验证 loop pass、两片 reviewer shard 完成、聚合状态可见且无横向溢出。

[2026-05-22T04:14:00+08:00] Projected loop terminal recommendations must be durable:
Projected loop 遇到 `inspect_*` 时，停止是合理的，但如果只返回 phase，后续恢复进程仍要靠上下文猜测为什么停。

决策：
- projected loop 在 stopped iteration 上记录 `terminal_action`。
- 同时记录 `terminal_reason`，优先使用 projection readout reason。
- scheduler loop registry/readout 保留 terminal 字段。
- Workbench projection 的 `scheduler_loop.latest_issue` 可展示 terminal reason，`Loop action` 优先展示 terminal action。

[2026-05-22T04:28:00+08:00] Loop execution mode cannot live only in control labels:
Projected mock loop 暴露在工作台后，操作者仍需要知道当前读数来自哪种执行策略和执行档位。如果这只藏在按钮文案里，后续真实 reviewer profile 接入时会再次变成口头约定。

决策：
- `autonomous-scheduler-loop-run.v1` readout 保留 `execution_strategy` 和 `execution_profile`。
- Workbench projection 的 `scheduler_loop` 摘要在 PC/mobile 版本都暴露 strategy/profile。
- Projection history readout 同步暴露 strategy/profile，供列表级状态和恢复选择使用。
- PC/mobile 工作台显示 `Loop profile`，浏览器门禁验证 projected mock trial 渲染为 `projected_next_action`。

[2026-05-22T04:45:00+08:00] Reviewer execution source must be policy-gated:
子进程审查发现一个比“接入真实 reviewer profile”更优先的风险：服务端 reviewer shard 之前是“有 mock 字段就 mock，否则走真实 Claude/DeepSeek”。这会让 mock profile 也存在误触发真实外部调用的路径。

决策：
- 新增 `reviewer-execution-policy`，把 mock 和 bounded real reviewer profile 分开。
- `approved_mock_non_dry_run` 必须显式提供 mock 输出，且外部 reviewer 调用预算固定为 0。
- `approved_bounded_real_reviewer` 必须显式提供 bounded cost mode、单次外部调用预算和 bounded timeout，并记录 model routing 读数。
- `/api/workbench/reviewer-shard-run` 与 projected `run_reviewer_scope_shard` 都必须先通过该 policy，再选择 executor。
- Reviewer shard result 与 Claude/DeepSeek executor 返回 executor provenance，避免后续评估只看到 finding 而不知道执行来源。

[2026-05-22T04:58:00+08:00] Reviewer execution provenance must be workbench-visible:
后端 policy 只能防止误触发，但如果工作台不显示 executor 来源，操作者仍无法一眼判断当前 shard 结果是 mock 试运行还是真实外部 reviewer。

决策：
- `reviewer_shard_review` projection 摘要暴露 latest executor kind、execution profile、provider/model 和 external call budget used。
- Mobile projection 保留同一组关键读数，避免手机端成为降级观察面。
- PC/mobile shell 显示 executor 和 budget，PC 额外显示 profile。
- 浏览器门禁在 projected mock loop 场景验证 executor=`mock` 且 budget=`0`。

[2026-05-22T05:05:00+08:00] Real reviewer projected loop needs provider-health preflight:
真实 reviewer 入口不能只是另一个按钮。只要会触发 Claude/DeepSeek，服务端必须先确认 provider 最近处于 healthy 状态，否则长期自运行会把 provider 故障变成自动重试。

决策：
- `approved_bounded_real_reviewer` 在 executor selection 前执行 provider-health preflight。
- 缺少最新 reviewer provider health fact 或 latest health 非 healthy 时，服务端在创建 executor 前失败闭合。
- PC/mobile 新增独立 `Projected Real Loop` 控制，只发送 bounded real profile、projected strategy、单次外部调用预算、bounded cost mode 和 timeout。
- Mock profile 与 real profile 的 UI 入口、请求字段和服务端 policy 保持分离。

[2026-05-22T05:12:00+08:00] Provider health preflight must not steal the projected driver:
Injected real-loop smoke 暴露了一个流程细节：如果为了预检把 provider health 事件追加到最后，projection 会把 provider recovery 当成最新 driver，loop 就不再执行 reviewer shard。

决策：
- Provider health preflight 只读取已有健康事实，不在同一 projected loop 执行前追加新的 automation driver。
- 真实 reviewer loop smoke 使用已有 healthy fact，同时保持 `next_action_readout=run_reviewer_scope_shard`。
- 后续如果需要刷新 provider health，应作为独立前置 cycle 完成，再进入 reviewer projected loop。

[2026-05-22T05:20:00+08:00] Partial reviewer shard readout must skip completed shards:
真实 DS 单片 smoke 成功后暴露了 projection bug：完成 shard 001 后，工作台仍显示 next shard 为 001。

决策：
- `reviewer_scope_split` projection 保留 `shard_ids`。
- `reviewer_shard_review.next_shard` 在 partial result 状态下从 `shard_ids - completedIds` 计算。
- 增加 partial result 回归，防止真实 loop 恢复时重复调度已完成 shard。

[2026-05-22T05:42:00+08:00] Projected loop partial shard continuation must not recurse through current item:
真实 reviewer loop 采用单片预算时，第一轮完成 shard 001 后会原地写回同一个 projection。测试暴露出两个恢复风险：服务响应里的当前 `item.id` 可能被误判为下一 projection；而 loop driver 作为最新事件时，如果只展示 inspect/resume，会让第二片 shard 需要人工判断。

决策：
- `projected_next_action` 只有看到真实 `next_item.id` 才记录跨 projection `next_projection_id`。
- 当 loop phase 为 `iteration_limit_reached` 且 reviewer shard review 仍有 pending shard 时，projection 推荐 `run_reviewer_scope_shard`。
- 第二轮真实 reviewer loop 仍通过 reviewer execution policy、provider-health preflight、单次外部调用预算和 bounded timeout。
- 回归验证两轮单片 projected real loop 依次执行 shard 001/002，并在 durable state 中聚合，不重复 001。
