# Agent Invocation Handoff

## 适用场景

本文件保留为历史交接入口，但新中台不再把任何个人 proxy 或个人 launcher 作为默认执行器。所有任务执行、计划生成、reviewer shard、context work package provider 都必须先经过项目内统一 agent 调用层：

- channel 配置：`config/agent-channels.json`
- profile 配置：`config/agent-profiles.json`
- 调用实现：`src/workflow/agent-invocation.js`
- key/健康/锁治理：SQLite workbench state 的 Agent key store

外部 CLI 只是 runner 类型之一，不允许再通过仓库外 wrapper 或个人启动器绕过 profile、模型、key、timeout、hook 和输出协议治理。

## 交接原则

- Agent 不继承 Codex App 的聊天上下文、已读文件、skill、connector、浏览器状态或 heartbeat。
- 派发前必须由中台生成最小 prompt：host、owned files、必读范围、禁止动作、验收命令、输出 JSON 协议和当前选中任务。
- 不得把完整 `workflow_state`、完整 Context Pack、长历史摘要或未裁剪 work package metadata 原样塞入 provider prompt。
- 模型选择必须来自 profile/candidate 顺序和 `model-router` 能力判断，不能在调用点硬编码某个 provider。
- 失败必须结构化记录为 timeout、auth_failed、model_unavailable、unstructured_output、command_unavailable 或 command_failed，并进入任务流/恢复流程。

## Provider Prompt Safety

- 对外 prompt 使用“中台质量运营、任务管理、验收证据、发布检查”等业务语义；内部 artifact version、manifest event、schema 和测试保持可审计。
- 精确文件路径和验收命令必须保留，避免 agent 失去可执行落点。
- 任务 owned files 过多或问题过大时，必须先拆成 bounded task，不得扩大单次上下文。

## 当前平台目标

平台目标是把“主进程调度、agent 受控执行、主进程验收、失败先固化流程再重跑、最终持续自运行”的开发模式代码化。任何新 agent 能力都应接入统一调用层，而不是新增散落 wrapper。
