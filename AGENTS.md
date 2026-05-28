# ai-control-platform Agent Rules

本仓库的默认开发模式是固定的主进程/子进程闭环，任何上下文压缩、恢复或新会话进入本仓库后都必须继续按同一方式执行。

## 固定开发模式

- 主进程负责目标判断、宿主边界、任务拆解、Context Pack、子进程调度、最终验收和流程修正。
- 子进程只负责 Context Pack 授权范围内的受限实现，必须遵守 owned files，不得扩大宿主、目标或实现范围。
- 每个子进程完成后必须自评：需求是否跑偏、文件是否落在正确宿主、结果是否符合验收标准、是否需要流程或 gate 修正。
- 主进程验收不只看测试通过，还要检查需求落点、host-boundary、global-goal、durable 状态、工作台 continuation 和多模型协同证据。
- 结果不合格时，先把失败原因固化为流程不变量、gate、schema、测试或 workbench projection 证据，再重新派发或重跑；不得只靠口头提醒继续。

## 上下文压缩恢复

- 压缩或恢复后，先读取 `PROJECT_STATUS.json`、`PROCESS.md`、`PROJECT_RULES.md` 和 `docs/contracts/AUTONOMOUS_DEVELOPMENT_FLOW_CN.md`，再继续执行。
- 恢复时必须从 durable 状态恢复当前 phase、global_goals、next_step、next_work_packages、run manifest、artifact ledger、task DAG 和 workbench continuation 事实。
- 如果聊天记录、cwd、历史 hook 或临时日志与 durable 状态冲突，以本仓库 durable 状态和最新 Context Pack 为准。
- 长任务必须持续把当前阶段、决策、进度、阻塞和下一步写回 durable 项目文件或工作台状态，避免压缩失败后只能依赖聊天上下文。
- 文档规则是压缩后的恢复入口，不是唯一拦截点；`run_context_work_packages` 必须经过 fixed-development-mode runtime gate 后才能调度或标记 work package 完成。该 gate 必须检查 Context Pack root `owned_files`、subtasks `owned_files` 和 selected work package `owned_files`。
- 使用 Claude Code、Codex CLI、DeepSeek、MiMo 或其他 agent 时，必须通过项目内 `src/workflow/agent-invocation.js` 和 `config/agent-profiles.json` 调用，并在 prompt 中显式重申 host、owned files、读文件上限、最小 diff、测试命令和子进程自评要求；不能假设外部 CLI 继承 Codex App 的隐性上下文或门禁。

## 禁止事项

- 禁止主进程绕过 Context Pack 和 owned files 直接实现平台能力。
- 禁止子进程修改未授权文件、改动 managed project，或把 `stock_dashboard`、`lobechat` 等业务项目当作平台本体落点。
- 禁止把流程经验只写成普通总结；会复发的失败必须进入 process-hardening gate、测试、schema、生成器或 workbench projection。
- 禁止在全局目标未完成、continuation 未生成或未验证真实服务/工作台结果时声明完成。
- 禁止让外部 CLI 子进程长时间分析而不产出补丁；若子进程超时或无 diff，必须把它作为 process gap 处理，而不是继续等待或把口头提醒当作修复。
