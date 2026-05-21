# 2026-05-21 自主流程第二轮自试运行评估

状态：in_review
宿主：`ai-control-platform`

## 1. 本轮目标

把上一轮仍偏人工记录的流程升级为机器可读运行模型，并补上多 LLM 协同策略：

- Run Manifest：保存一次自主运行的事实。
- Artifact Ledger：保存需求、patch、测试、review、evaluation 等证据。
- Task DAG：表达任务依赖和后续 rerun / rollback 节点。
- Goal Guard：持续检查整体目标、宿主、changed files 和禁止动作是否跑偏。
- LLM Reviewer Gate：把外部模型审查变成中台流程 gate，而不是临时 skill。
- Model Router：按 stage、risk、budget、host、tags 选择 GPT / DeepSeek V4 Pro / DeepSeek V4 Flash 的协同方式。

## 2. 子进程与主进程分工

| 来源 | 范围 | 评估 |
| --- | --- | --- |
| 子进程 C | `run-manifest`、`artifact-ledger`、合同文档 | accepted |
| 子进程 D | `task-dag`、`goal-guard` | accepted |
| 主进程 | `llm-reviewer-gate`、`model-router`、流程文档同步 | accepted |

子进程产物均先落在隔离 worktree，主进程读取实际文件与测试后合入主仓。

## 3. 主进程评估

通过项：

- 所有新增文件都在 `ai-control-platform`，未写入 `stock_dashboard`、`local-control-server`、`dashboard-ui` 或 `legacy/`。
- `goal-guard` 已能检查平台目标宿主、其他项目路径、legacy 写入、non-goals 和 forbidden actions。
- `run-manifest` 可投影为 `evaluateRunResult` 输入。
- `artifact-ledger` 要求每个 artifact 有 path、uri 或 content hash。
- `task-dag` 可检测 duplicate id、unknown dependency、self dependency 和 cycle，并能消费 rerun / rollback 后续节点。
- `llm-reviewer-gate` 将外部 reviewer request / findings / summary 结构化为工作台和 autonomous-run 可消费数据。
- `model-router` 将 GPT / DeepSeek V4 Pro / DeepSeek V4 Flash 的选择依据代码化，避免固定使用最高成本模型或固定 Claude+DeepSeek。

需要后续加强：

- `model-router` 目前是确定性规则，后续应接入真实成本、延迟、成功率和历史质量统计。
- `goal-guard` 的 constraint matching 仍是启发式，需要引入更严格的 path normalization、glob 和项目边界解析。
- `llm-reviewer-gate` 已建模审查流程，但还没有真实 runner adapter 和持久化 result ingestion。
- 外部 reviewer 超时需要进入 run manifest 的 `review_findings` 或 `recovery_attempts`，而不是停留在日志。

## 4. 验证证据

```bash
node --test test/run-manifest.test.js test/artifact-ledger.test.js test/task-dag.test.js test/goal-guard.test.js test/llm-reviewer-gate.test.js
node --test test/model-router.test.js test/llm-reviewer-gate.test.js
npm test
npm run check:onboarding
```

Goal Guard 自检结果：

```json
{
  "status": "pass",
  "classification": "platform_core",
  "workspace_project_id": "ai-control-platform"
}
```

## 5. 外部 Reviewer Gate 样本

本轮启动了 Claude Code + DeepSeek V4 Pro 只读审查作为 reviewer gate 样本。

- 第一次范围较大，结果为 `CLAUDE_DEEPSEEK_TIMEOUT`，按流程标记为 inconclusive，不能作为通过证据。
- 第二次缩小到 `model-router` 与 `llm-reviewer-gate`，仍返回 `CLAUDE_DEEPSEEK_TIMEOUT`。

该结果说明 reviewer gate 不能阻塞主流程：超时必须作为 reviewer finding / artifact / recovery 信号记录，并由 `autonomous-run` 决定 rerun、降级或继续。本轮已新增 `createReviewerTimeoutFinding`，将外部 reviewer 超时转成可恢复的 `reviewer_timeout` finding，默认触发 `rerun` 而不是人工介入。
