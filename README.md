# AI Control Platform

AI Control Platform 是新的中台基座仓库。它承载 AI 项目组的需求固化、任务拆解、并行 agent 调度、质量门禁、自动恢复、发布验收、项目体检和 Ops Workbench。

本仓库不是 `stock_dashboard` 的子模块，也不是旧 `local-control-server` 或 `dashboard-ui` 的补丁层。旧控制面项目只能作为可迁移组件和历史能力来源；新中台的领域模型、流程门禁和产品体验以本仓库为准。

## 当前边界

- 平台本体：本仓库。
- 被纳管项目：`stock_dashboard`、`lobechat` 等业务项目。
- 可迁移组件：`local-control-server`、`dashboard-ui`。
- 禁止落点：平台工作台、任务 DAG、Recovery Engine、LLM Reviewer、CI/CD 门禁、跨项目体检不得继续写入被纳管业务项目。

## 必读入口

- `PROJECT_RULES.md`：仓库级边界和执行规则。
- `PROJECT_PLAN.md`：阶段计划。
- `PROCESS.md`：防跑偏开发流程。
- `docs/contracts/AUTONOMOUS_DEVELOPMENT_FLOW_CN.md`：可代码化流程合同。
- `docs/contracts/PLATFORM_FOUNDATION_DESIGN_CN.md`：中文设计稿。
- `docs/contracts/PLATFORM_CAPABILITY_MATRIX_CN.md`：真实能力矩阵。
- `docs/contracts/RECOVERY_ENGINE_REDESIGN_CN.md`：Recovery Engine 重设计合同。

## 本地验证

```bash
npm test
npm run check:onboarding
```

## 迁移区

- `docs/migrations/` 保存当前会话迁入的新中台历史材料和 Trial 证据。
- `legacy/` 保存从错误宿主迁出的旧代码快照，仅作为重构输入，不参与默认测试或运行时。
