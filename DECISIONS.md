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
