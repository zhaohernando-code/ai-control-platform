# Codex Proxy Handoff

## 适用场景

当主进程需要把后续平台开发交给 `~/codex-proxy.sh` 执行时，必须把本文件作为交接上下文的一部分。`codex_proxy` 是独立 CLI 进程，不等同于当前 Codex App 会话。

## 与 Codex App 的关键差异

- `codex_proxy` 不继承当前聊天上下文、开发者指令、已读文件、已加载 skill、MCP/app connector、浏览器状态或自动化 heartbeat。
- `codex_proxy` 的 cwd、`CODEX_HOME`、插件同步状态和可用工具可能与 Codex App 不同；插件同步报错不能直接等价为模型不可用。
- `codex_proxy` 不会自动知道“主进程只调度验收、子进程实现”的固定模式，除非 prompt 和仓库 durable 文件重复声明。
- `codex_proxy` 容易在大范围读取和长时间分析中消耗上下文而不产出补丁；必须给它明确的文件读取上限、交付时限、最小 diff 和测试命令。
- `codex_proxy` 不能把当前聊天里的口头规则当作 gate。可复发规则必须进入 `AGENTS.md`、`PROCESS.md`、`PROJECT_STATUS.json`、process-hardening、schema、测试或工作台 projection。

## Proxy 子进程交付协议

- 开始前先读取 `AGENTS.md`、`PROCESS.md`、`PROJECT_STATUS.json`、本文件，以及本轮 Context Pack 明确列出的文件。
- 每轮实现必须声明 host 为 `platform_core`，不得写入 managed project 或 legacy 目录，除非 Context Pack 明确授权。
- 默认最多读取 Context Pack 以外 5 个文件；需要扩大范围时，先产出当前判断和最小候选路径，不得无限检索。
- 先交付最小可运行 diff，再解释设计；如果 10 分钟内无法完成补丁，必须输出 blocker、已读文件、下一步最小补丁位置和退出。
- 每个子进程必须在最终输出中包含：改动文件、需求对齐判断、是否跑偏、测试结果、未完成风险、是否需要流程/gate 修正。
- 如果发现 P0/P1、假成功、状态未持久化、host 边界、owned files、continuation 断裂或 proxy 交付失败，先补 process-hardening 不变量和回归测试，再继续实现。

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
