# PROCESS

本文件只记录 AI Control Platform 可复用的反回归原则，不记录单次流水账。当前阶段、下一步、运行证据和发布事实写入 `PROJECT_STATUS.json`、`DECISIONS.md`、run manifest、artifact 或 git 历史。

## 维护规则

- **只写默认思路纠偏**：条目必须能防止未来模型把平台本体、运行证据、任务调度或验收边界想错。单次修复、验证命令和发布事实不写进这里。
- **按主题维护，不按日期追加**：同类原则合并到现有主题；不要新增日期标题、run 记录、截图、commit 或“本轮已完成”段落。
- **原则必须可执行**：每条原则应能转换成 gate、schema、测试、Context Pack 限制或 operator 可见状态。
- **状态与原则分离**：`PROJECT_STATUS.json` 记录现在到哪了；`DECISIONS.md` 记录为什么选择；本文件记录以后如何不再错。

## 宿主与边界

- **显式平台意图覆盖自动路由**：用户明确说新中台、平台本体、任务编排、multi-agent、reviewer、CI/CD 或 workbench 时，cwd、历史上下文、业务项目别名和默认 hook 都只是候选信号。先判定宿主，再拆任务。
- **先分类再执行**：每个需求先归类为 `platform_core`、`managed_project` 或 `integration_adapter`。分类和禁止落点未进入 Context Pack 前，不允许派发实现。
- **试验田只产证据，不承载平台本体**：被纳管项目可以提供 fixtures、验收样本或只读对接点；平台 UI、状态机、scheduler、reviewer gate 和 projection 必须留在平台仓或平台系统中。
- **迁移材料先隔离后重构**：从错误宿主迁出的代码先进入 `legacy/` 或迁移文档。未完成平台中立重写前，不得把 legacy artifact 加入默认 runtime 或默认测试。

## Context Pack 与子进程

- **固定开发模式持久化，标准职责不可反转**：主进程负责目标判断、Context Pack、验收和继续调度；子进程只做受限 owned files 实现。恢复必须从 durable 状态开始，并用 `PROJECT_STATUS.json`、manifest、artifact 和 workbench continuation 重新建立当前阶段，避免上下文压缩后职责漂移。
- **主进程不能跳过调度闭环**：平台能力开发要先固化 Context Pack、owned files、目标/非目标、证据要求和重跑条件，再派发子进程。任务小或文档多都不是绕过调度的理由。
- **每个子进程必须自评**：每个 worker 只能写授权文件集合，结束时自评是否跑偏、证据是否足够、是否需要重跑。主进程用自评做验收输入，而不是把它当总结。
- **无 diff 或无自评是流程失败**：外部 CLI 子进程如果只分析不落地、超范围读取、没有自评或没有测试结果，主进程要归类为 process gap，先加强 gate/文档/测试，再重新派发或收敛为最小修复。
- **外部 CLI prompt 必须完整交接**：`codex_proxy`、Claude Code 或其他 CLI worker 不继承 Codex App 的上下文、skill、connector、浏览器和 heartbeat 状态。派发前必须写清 host、owned files、必读范围、禁止动作、验证命令和自评格式。
- **外部 CLI prompt 必须最小化和语义降噪**：交给中转 API、Codex CLI、Claude Code 或 DeepSeek 的 prompt 不得直接塞入完整 workflow_state、Context Pack 或历史摘要。主进程必须只给最小任务视图、精确 owned files、验收命令和输出 JSON 协议，并把内部治理/持续运行/调度类术语转换成中台质量运营语义，避免 provider 把项目管理流程误判成其他工具链。

## Gate 与持续执行

- **不合格先改流程/gate**：发现 P0/P1、假成功、状态未持久化、宿主越界、owned files 越界或 continuation 断裂时，先新增或更新 invariant、gate、schema、测试、fixture 或 projection，再重跑实现。
- **完成定义包含继续能力和全局不跑偏**：单个子任务测试通过不代表平台完成。只要存在 `PROJECT_STATUS.next_step`、pending global goals、可执行 work package 或 workbench next action，就必须生成 continuation seed 或明确阻塞原因，并复核当前工作仍服务 ai-control-platform 的全局目标。
- **Process hardening 是合入前条件**：阻塞级 reviewer finding 必须有 invariant、enforcement target、regression test、verification 和 completed 状态；缺任一项不能合入实现。
- **固定开发模式要 runtime gate 支撑**：AGENTS/PROCESS/合同用于恢复上下文；真正调度前必须由 runtime gate 校验宿主、Context Pack root owned files、subtasks owned files、selected package owned files 和 managed project 路径。

## 多模型与 reviewer

- **模型选择先路由再调用**：GPT、DeepSeek V4 Pro/Flash、Claude Code 或其他模型不是固定替代关系。每次使用前根据 stage、risk、budget、host 和 tags 生成 model routing plan。
- **外部 reviewer 是 gate，不是临时 skill**：高风险平台任务的外部审查结果必须进入 reviewer gate request、findings、run manifest 和 workbench projection；只读审查默认无写入权限。
- **多模型协同必须可审计**：模型输出要沉淀为 durable findings、artifacts、continuation facts 或可重跑 gate。不能只用“多个模型都同意”替代证据。

## Workbench 与公开挂载

- **Workbench 只消费 projection**：PC 和 mobile 工作台应以 Workbench Projection 作为一屏状态输入。任务、模型、reviewer、artifact 和 DAG 状态先汇总成 projection，再进入 UI。
- **公开挂载要同时测入口和 API 前缀**：挂到 `/projects/<id>/` 的工具必须验证 entry redirect、static shell 和 mounted API prefix；不要只测 root-local 端口。
- **agent auth 与 bare public 要分层**：根域保护下，裸请求的登录跳转和 agent auth header 的通过是两种不同证据。需要公开读 allowlist 时必须显式列出 `GET`/`HEAD` 的入口、静态 shell 和只读 projection API，不要扩大到事件、mutation、snapshot 或通用 `/projects/*`。

## Git 与执行角色

- **主线必须保持干净**：`main` 只承载已验收结果；发现 primary worktree 在 `main` 且有未提交修改时，先切到隔离分支或 worktree，再继续派发/验收。
- **child worker 必须使用隔离 worktree**：分支名不是宿主边界。`child_worker` 只能在 primary worktree 之外的 worker worktree 中累积 diff；`main_orchestrator`/integration closeout 才能在受控集成路径验收。
- **CLI orchestrator 与 CLI worker 分层**：同一 Codex CLI 能力可以承担 main orchestrator 或 child worker，但运行模式必须显式声明；worker 不能反向接管拆任务、验收和流程修正职责。
