# 当前会话迁移记录

更新时间：2026-05-21

## 1. 迁移目标

把当前会话中已经产生的中台相关设计、流程、代码和教训集中迁移到 `ai-control-platform`，避免继续散落在根仓、`stock_dashboard`、旧控制面后端或旧控制面前端里。

## 2. 已迁入内容

正式设计与合同：

- `docs/contracts/PLATFORM_FOUNDATION_DESIGN_CN.md`
- `docs/contracts/PLATFORM_CAPABILITY_MATRIX_CN.md`
- `docs/contracts/platform-capability-matrix.json`
- `docs/contracts/RECOVERY_ENGINE_REDESIGN_CN.md`
- `docs/contracts/AUTONOMOUS_DEVELOPMENT_FLOW_CN.md`
- `docs/contracts/PROJECT_ONBOARDING_SYNC_CN.md`

视觉稿：

- `docs/design/ops-workbench-visual.html`
- `docs/design/ops-workbench-mobile.html`
- `docs/design/ops-workbench-concept.png`

从 `stock_dashboard` 迁入的错误宿主试验材料：

- `docs/migrations/stock-dashboard-autonomous-flow/contracts/`：200 个合同、Trial、registry 和 schema 文件。
- `legacy/stock-dashboard-autonomous-flow/src/ashare_evidence/`：59 个 legacy 平台试验源码文件。
- `legacy/stock-dashboard-autonomous-flow/tests/`：82 个 legacy 平台试验测试文件。

从根级和旧控制面迁入的路由修复快照：

- `legacy/root-workflow-guard/`：4 个 hook/route 源码与测试快照。

## 3. 迁移状态

- `docs/contracts/*` 是新中台当前正式合同。
- `src/workflow/*` 是新中台当前可执行门禁。
- `docs/migrations/*` 是迁移证据和历史 Trial 材料。
- `legacy/*` 是待重构输入，不作为运行时代码直接启用。

## 4. 后续 TODO

1. 从 legacy Python 试验中抽取领域模型，重写为新中台原生模块。
2. 把 registry/schema 从 `phase5` 和 `stock_dashboard` 语义改成平台中立语义。
3. 为 Context Pack、子进程分配、主进程评审、回退重跑建立正式 schema。
4. 把 root hook 的平台强意图覆盖逻辑上移为新中台 gate，再由根 hook 调用。
5. 从 `stock_dashboard` 清理或迁出仍残留的平台代码，业务项目只保留 fixture 或 integration adapter。

