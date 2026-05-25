# Codex Proxy Handoff

## 适用场景

当主进程需要把后续平台开发交给 `~/codex-proxy.sh` 执行时，必须把本文件作为交接上下文的一部分。`codex_proxy` 是独立 CLI 进程，不等同于当前 Codex App 会话。

本文件同时约束两个阶段：

- **过渡阶段**：Codex App 仍然作为外层主进程，`codex_proxy` 作为受控子进程执行器。
- **目标阶段**：`codex_proxy`/Codex CLI 必须能够作为 headless main orchestrator 独立运行完整中台流程；Codex App 只作为人工观察、调试和干预入口，不能成为新项目创建、任务调度、验收或 continuation 的必需运行时。

## 与 Codex App 的关键差异

- `codex_proxy` 不继承当前聊天上下文、开发者指令、已读文件、已加载 skill、MCP/app connector、浏览器状态或自动化 heartbeat。
- `codex_proxy` 的 cwd、`CODEX_HOME`、插件同步状态和可用工具可能与 Codex App 不同；插件同步报错不能直接等价为模型不可用。
- `codex_proxy` 不会自动知道“主进程只调度验收、子进程实现”的固定模式，除非 prompt 和仓库 durable 文件重复声明。
- `codex_proxy` 容易在大范围读取和长时间分析中消耗上下文而不产出补丁；必须给它明确的文件读取上限、交付时限、最小 diff 和测试命令。
- `codex_proxy` 走中转 API 时，prompt 可能先被上游 provider 的安全或滥用过滤器粗筛；完整历史摘要、内部治理术语、持续运行术语和调度术语集中出现时，可能造成误判或长时间无结构化输出。
- `codex_proxy` 不能把当前聊天里的口头规则当作 gate。可复发规则必须进入 `AGENTS.md`、`PROCESS.md`、`PROJECT_STATUS.json`、process-hardening、schema、测试或工作台 projection。

## CLI Main Orchestrator 要求

中台最终不能依赖 Codex App 会话来创建或推进项目。CLI 总执行器必须自己完成以下职责：

- 从 durable repository state 启动：读取 `PROJECT_STATUS.json`、`PROCESS.md`、`AGENTS.md`、`PROJECT_RULES.md`、contracts、projection history 和最新 workflow_state。
- 执行主进程职责：判断目标、分类 host、生成 Context Pack、拆分 work packages、选择模型路由、派发子进程、验收结果、修正流程并决定 continuation。
- 派发子进程职责：用 Codex CLI/`codex_proxy` 或其他 provider 运行 bounded owned-files work package，并记录 WorkerSpawned、WorkerHeartbeat、WorkerCompleted、WorkerEvaluation、WorkerClosed、PoolIterationClosed。
- 自恢复职责：检测无 diff、超时、模型失败、测试失败、host 漂移、owned-files 越界、假成功和 continuation 断裂；能自动选择 retry、rollback、split、fallback 或 process-hardening。
- 工作台职责：把运行事实写入 workflow_state、artifact ledger、projection 和 PC/mobile workbench 输入；UI 只读 projection，不承担流程判断。
- Headless workbench service 启动职责：服务启动必须支持并优先使用显式 `--host`/`--port`，或使用已文档化的 positional port 兼容形式；启动失败要作为 process gap 自动重试并固化到 hardening/测试/状态证据，不能依赖 Codex App 会话、隐式端口或人工临时启动。
- Projection 驱动职责：当服务端 next-action 返回 `next_item.id` 时，后续 headless loop 必须切换到该 projection id 继续读取和执行；当服务端在同一 projection id 原地写回工作流状态时，后续 headless loop 必须重新读取服务 projection 并清除一次性的手动 action override，不能一直停留在启动 source projection 或旧 run projection。
- 退出职责：只有在所有 global goals 完成、没有 next_step、没有 next_work_packages、没有 workbench next_action_readout 且 closeout 通过时，CLI 总执行器才能停止。

因此，`codex_proxy` 不是只能成为子进程。它在当前阶段作为子进程试运行，是为了验证 CLI 能力、收集失败模式并把门禁代码化；平台后续必须实现一个 CLI orchestrator adapter，让同一套 fixed-development-mode gate 在没有 Codex App 的情况下完整运行。

## Proxy 子进程交付协议

- 开始前先读取 `AGENTS.md`、`PROCESS.md`、`PROJECT_STATUS.json`、本文件，以及本轮 Context Pack 明确列出的文件。
- 每轮实现必须声明 host 为 `platform_core`，不得写入 managed project 或 legacy 目录，除非 Context Pack 明确授权。
- 默认最多读取 Context Pack 以外 5 个文件；需要扩大范围时，先产出当前判断和最小候选路径，不得无限检索。
- 先交付最小可运行 diff，再解释设计；如果 10 分钟内无法完成补丁，必须输出 blocker、已读文件、下一步最小补丁位置和退出。
- 每个子进程必须在最终输出中包含：改动文件、需求对齐判断、是否跑偏、测试结果、未完成风险、是否需要流程/gate 修正。
- 如果发现 P0/P1、假成功、状态未持久化、host 边界、owned files、continuation 断裂或 proxy 交付失败，先补 process-hardening 不变量和回归测试，再继续实现。

## Provider Prompt Safety

- 外部 provider prompt 只允许包含最小任务视图：项目定位、host、owned files、验收命令、必读文件上限、输出 JSON 协议和当前选中任务。
- 不得把完整 `workflow_state`、完整 Context Pack、长 `PROJECT_STATUS.progress_summary`、历史 run artifacts 或未裁剪的 work package metadata 原样写入外部 prompt。
- 对外 prompt 的自然语言要使用“中台质量运营、任务管理、验收证据、发布检查”等业务语义；内部模块名和事实仍保留在仓库代码、artifact、manifest 和测试中。
- 精确文件路径和验收命令必须保留，避免子进程失去可执行落点；如果一个任务的 owned files 过多或词面组合容易被 provider 误判，应先拆成更小的 bounded task。
- 外部 prompt safety 是运行时约束，不是改名工程。内部 API、artifact version、manifest event 和测试断言保持稳定，避免为了规避误判破坏可审计性。

## 当前平台目标

本仓库是新的 AI 中台，不是 `stock_dashboard` 或任何业务项目的插件。平台目标是把“主进程调度、子进程实现、主进程验收、失败先固化流程再重跑、最终持续自运行”的开发模式代码化。

当前全局目标仍未完成：

- 独立中台仓库、宿主边界、durable 状态和防跑偏门禁。
- PC/mobile 单页中台工作台和一屏状态投影。
- 任务拆解、调度、multi-LLM reviewer、自恢复和持续运行闭环。

当前优先方向：

- 让 spawned child workers 的 heartbeat/timeout/cleanup facts 通过 scheduler execution 进入 durable workflow state。
- 让 `retry_agent_worker` 不只记录生命周期事实，还能连接到真实子任务拆解和受控子进程调度。
- 让 `codex_proxy` 作为可替换子进程执行器时仍遵守 fixed development mode、owned files、process-hardening 和 continuation gates。

## 推荐启动模板

```bash
~/codex-proxy.sh exec \
  --cd /Users/hernando_zhao/codex/projects/ai-control-platform \
  --sandbox workspace-write \
  --output-last-message /tmp/ai-control-platform-proxy.out \
  '<把 docs/contracts/CODEX_PROXY_HANDOFF_CN.md、PROJECT_STATUS.json 当前 next_step、具体 Context Pack 和验收命令贴入这里>'
```
