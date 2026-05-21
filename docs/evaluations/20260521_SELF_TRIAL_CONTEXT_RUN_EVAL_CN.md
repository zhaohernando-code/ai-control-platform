# 2026-05-21 自主流程自试运行评估

状态：accepted
宿主：`ai-control-platform`

## 1. 本轮目标

验证“主进程设计流程 -> 子进程隔离落地 -> 主进程评估 -> 合格后固化”的开发方式是否能用于新中台自身建设。

本轮不允许把平台能力写入 `stock_dashboard`、`local-control-server` 或 `dashboard-ui`。旧仓只能作为历史材料或反例，不承载新模块。

## 2. 子进程切分

| 子进程 | owned files | 结果 |
| --- | --- | --- |
| A：Context Pack / Work Package | `src/workflow/context-pack.js`、`test/context-pack.test.js`、`docs/contracts/CONTEXT_PACK_CN.md` | accepted |
| B：Autonomous Run Evaluation | `src/workflow/autonomous-run.js`、`test/autonomous-run.test.js`、`docs/contracts/AUTONOMOUS_RUN_EVALUATION_CN.md` | accepted |

两个子进程均落在隔离 worktree，未直接提交主仓。主进程读取实际文件后合入。

## 3. 主进程评估

通过项：

- 文件落点正确，全部位于 `ai-control-platform`。
- 子进程写入范围互不重叠，未覆盖既有模块。
- Context Pack 复用 `host-boundary`，能阻止平台需求落到 `stock_dashboard`。
- Work Package 通过 `owned_files` 子集校验阻止越界派发。
- Autonomous Run Evaluation 默认让普通失败进入 `rerun`，严重边界失败进入 `rollback`，只有自动系统无法安全继续时才进入 `human_intervention`。
- 两个模块都有聚焦测试和中文合同文档。

需要后续加强：

- Context Pack 目前只做路径字符串集合校验，下一步需要接入 glob / path normalization，避免 `../`、大小写或软链接绕过。
- Run Evaluation 目前只输出下一步建议，下一步需要接入真实任务 DAG 和 artifact ledger。
- 评估记录仍是人工写入文档，后续要生成机器可读 run manifest，并由工作台 projection 消费。

## 4. 验证证据

```bash
node --test test/context-pack.test.js
node --test test/autonomous-run.test.js
npm test
npm run check:onboarding
```

边界模拟：

```json
{
  "request": "中台自动化流程不能写到股票看板",
  "targetProjectId": "stock_dashboard"
}
```

结果：`allowed=false`，`requiredHost=ai-control-platform`。

## 5. 流程结论

本轮流程可以继续作为默认开发范式：主进程先生成可执行边界，再派发隔离子进程；子进程只负责 owned files 内的实现；主进程读取 patch、运行 gate、记录评估后才合入。

下一轮应把本轮仍然依赖人工记录的部分代码化为 run manifest、artifact ledger 和 workbench projection 输入。
