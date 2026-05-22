# PROCESS

## 防跑偏流程

- **显式宿主优先于自动路由**：当用户明确说“新中台、新平台、新项目”时，自动路由到业务项目必须视为低可信信号。主进程要改用本仓库，除非用户指定业务项目集成。
- **平台强意图要覆盖 cwd 和默认 skill**：会话 cwd、历史 thread、默认 hook 或 init skill 给出的项目上下文都只能作为候选信号。只要用户文本明确指向新中台/平台本体，平台宿主必须覆盖 cwd 路由。
- **先判定宿主再拆任务**：每个任务先分类为 `platform_core`、`managed_project` 或 `integration_adapter`。分类未写入 Context Pack 前，不允许子进程实现。
- **试验田只产出证据，不承载平台本体**：被纳管项目可以用于验证流程、fixtures 和验收样本，但平台代码、平台 UI、平台状态机必须留在本仓库。
- **主进程必须评估落点**：每轮子进程结果不仅看测试是否通过，还要检查文件落点、领域边界、是否变成补丁式实现。
- **失败要回退再重跑**：若子进程把平台能力写入业务项目，先回退产品面，再把失败原因升级为 gate 或测试，然后重新派发。
- **成功范式要代码化**：一次人工纠偏只算经验；只有进入 gate、schema、测试或生成器后，才算中台能力。
- **新项目创建必须做配置同步**：建仓后必须同步 `WORKSPACE_INDEX.json`、根级入口文档、hook 路由测试、控制面路由测试和项目 canonical docs。只建源码仓、不更新路由与入口文档，会让后续会话重新跑偏。
- **迁移材料先隔离后重构**：从错误宿主迁来的代码先进入 `legacy/`，合同和评估进入 `docs/migrations/`。未完成平台中立重写前，不得把 legacy 文件加入默认运行时或默认测试。

## 本次偏移教训

本次偏移不是因为缺少设计稿，而是因为缺少强制的宿主边界 gate。视觉稿和文档已经明确这是新平台，但执行层被 workspace 路由、默认 hook/context、长任务上下文和 `stock_dashboard` 试验代码惯性覆盖。后续必须让机器 gate 拦截这种情况。

## 当前流程试运行

- **主进程不直接跳实现**：本轮先把需求固化为 Context Pack、work package 和 run evaluation 的可执行约束，再派发子进程。
- **子进程必须有 owned files**：每个子进程只允许写入明确文件集合，避免多个 agent 在同一模块里互相覆盖。
- **主进程负责最终质量**：子进程完成后，主进程检查宿主、边界、代码设计、测试、文档和是否满足“平台本体”目标。
- **失败不靠口头提醒修复**：如果发现跑偏，先把失败升级成可执行 gate 或测试，再重跑同类任务。
- **阻塞审查先升级流程再修代码**：当 reviewer 或主进程发现 P0/P1、假成功态、状态持久化缺口、流程停滞、宿主边界或 owned files 问题时，不允许只修实现。必须先生成流程不变量、自动化门禁/测试和验证证据，再进入实现重跑。
- **本轮最小验收**：新增能力必须能从机器可读输入中判断：需求属于哪个宿主、子任务是否允许执行、执行结果是否需要重跑，以及哪些证据要进入工作台状态。
- **多模型协同要先路由再调用**：GPT、DeepSeek V4 Pro、DeepSeek V4 Flash 不是固定替代关系。每次使用前必须根据 stage、risk、budget、host 和 tags 生成 model routing plan；高风险平台任务需要独立 reviewer，低风险分类和摘要优先低成本模型。
- **外部 reviewer 是 gate，不是临时 skill**：Claude Code + DeepSeek V4 Pro 这类审查方式必须进入 reviewer gate request、review findings、run manifest 和工作台 projection。只读审查是默认约束，写入型工具必须被 gate 拦截。
- **工作台只消费 projection，不解析零散日志**：PC 和 mobile 工作台必须以 Workbench Projection 为一屏状态输入。任务、模型、reviewer、artifact 和 DAG 状态先汇总成 projection，再进入 UI。
- **完成一轮后必须运行 continuation gate**：提交、推送、测试通过或输出总结都不是停止条件。只要 `PROJECT_STATUS.next_step` 或 `next_work_packages` 存在且没有人工阻塞，系统必须生成下一轮 Context Pack seed 并继续执行。
- **Process Hardening Gate**：阻塞级 reviewer finding 必须进入 `process-hardening` gate。该 gate 要求每条阻塞 finding 都有 invariant、enforcement target、regression test、verification 和 completed 状态；缺任一项则当前实现不能合入。

## 固定开发模式持久化

- **标准职责不可反转**：主进程负责目标判断、任务拆解、Context Pack、调度、验收和流程修正；子进程只负责 owned files 内的受限实现。主进程不得因为任务小、文档多或上下文紧张而直接越过调度闭环实现平台能力。
- **每个子进程必须自评**：子进程完成后必须明确评估需求是否跑偏、实现是否符合预期、证据是否足够、是否需要重跑。该自评是主进程验收输入，不是可选总结。
- **不合格先改流程/gate**：如果发现偏离目标、宿主错误、owned files 越界、假成功、状态未持久化或 continuation 断裂，先新增或更新流程不变量、gate、schema、测试、fixture 或 workbench projection，再重新派发同类任务。
- **恢复必须从 durable 状态开始**：上下文压缩或新会话恢复后，先读取 `AGENTS.md`、`PROJECT_STATUS.json`、`PROJECT_RULES.md`、本文件和 `docs/contracts/AUTONOMOUS_DEVELOPMENT_FLOW_CN.md`。当前阶段、决策、阻塞、next_step、global_goals、run manifest、artifact ledger、task DAG 和 workbench continuation 以 durable 状态为准。
- **文档恢复入口必须配 runtime gate**：AGENTS/PROCESS/合同用于让压缩后的会话恢复规则；真正调度前，`run_context_work_packages` 必须运行 fixed-development-mode runtime gate，验证平台宿主、Context Pack root `owned_files`、subtasks `owned_files`、selected work package `owned_files` 和 managed project 路径，失败则 blocked closed。
- **全局不跑偏优先级最高**：cwd、历史 thread、默认 hook、临时日志、模型建议或单个子进程输出都不能覆盖 host-boundary、global-goal completion、process-hardening 和 workbench continuation gate。
- **多模型协同必须可审计**：GPT、DeepSeek V4 Pro/Flash、Claude Code 或其他模型只能通过 model routing plan 和 reviewer gate 进入流程；模型调用结果必须沉淀为 durable findings、artifacts 或 continuation facts。
- **完成定义包含继续能力**：一个子任务通过测试不等于项目完成。只要 `PROJECT_STATUS.next_step`、pending global goals、可执行 work package 或 workbench next_action_readout 存在，就必须生成下一轮 continuation seed 或明确阻塞原因。
