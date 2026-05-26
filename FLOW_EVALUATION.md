# 任务发布→完成 流程评估报告

评估时间：2026-05-27  
评估范围：ai-control-platform "任务发布到完成"全链路  
评估依据：PROJECT_STATUS.json、PROJECT_RULES.md、PROCESS.md、docs/contracts/ 所有合同文档、src/workflow/ 核心源码

---

## 一、流程全貌

```
用户提需求（Workbench）
  → requirement intake
  → plan 生成（LLM 生成方案）
  → 用户在 Workbench 审批方案
  → work packages 派发（governance gate 校验）
  → headless CLI orchestrator（主进程）
      → Context Pack 物化
      → child worker 在隔离 worktree 执行
      → LLM Reviewer Gate（DeepSeek/Claude shard）
      → Autonomous Continuation 决策
  → Closeout / Snapshot 发布
  → 下一轮 continuation → 循环
```

**总体评价**：流程分层设计合理，主进程/子进程职责划分清晰，durable state 机制健全。
主要问题集中在循环闭合（re-entry）缺失和若干 gate 的过度或缺陷性拦截上。

---

## 二、卡死点逐条分析

### 2.1 【最严重·P0】Continuation 产物和执行之间没有自动触发

**现象**：`decideContinuation()` 写出 `autonomous-closeout-loop-run.v1` artifact，但没有任何机制把它送进下一轮执行。

**根因**：`runAutonomousCloseoutLoop` 完成后只写 artifact，不触发续跑。续跑需要手动依次调用：
```
run:autonomous-closeout-loop
  → prepare:scheduler-dispatch-continuation   ← 手动触发
  → run:scheduler-dispatch                    ← 手动触发
  → prepare:scheduler-dispatch-continuation   ← 下一轮再来一遍
```

每轮之间有 2–3 个手动步骤。系统认为自己完成了，但没有任何东西把它接着跑起来。这是"卡住"的根本原因。

**修复方向**：在 `runAutonomousCloseoutLoop` 末尾，当 `should_continue: true` 时直接触发下一轮调度（受约束循环限制最大 iteration），而不是仅写 artifact。

---

### 2.2 【P1】`projected_next_action` 策略依赖 Workbench 服务存活，且无 fallback

**现象**：使用 `--execution-strategy=projected_next_action` 时，调度器必须能访问 Workbench server 且 Projection 中有合法 `next_action_readout`。

**根因**：两种执行策略（`projected_next_action` 和 `scheduler_dispatch_chain`）互斥，前者没有 fallback 到后者的机制。当 LaunchAgent 未运行或 Projection 过期时，整条路径死掉且无恢复。

**修复方向**：当 Workbench server 不可达或 `next_action_readout` 无法解析时，自动降级到 `scheduler_dispatch_chain`，并记录 fallback 原因到 manifest。

---

### 2.3 【P1】Provider Health 恢复可形成封闭循环

**现象**：DeepSeek 超时 → 记录降级 → 每轮生成 `run_reviewer_smoke` work package → smoke 也超时 → 再次降级 → 再次生成 smoke package，无限循环。

**根因**：`reviewerProviderWorkPackagesFrom()` 没有对同一 run_id 内的 smoke 失败次数设置 hard exit。只要 health 状态仍是 `degraded` 就生成新包，其他业务 work packages 因此永远无法通过。

**修复方向**：同一 run_id 内 smoke 连续失败 N 次（建议 2 次）后，改为 `STOP_FOR_HUMAN` 并在 Projection 显式标注，不再自动生成 smoke package。

---

### 2.4 【P1·已修复】Work Package Governance Gate 使用中文正则判断导致误拦

**现象**（修复前）：Governance gate 通过 regex 匹配中文自然语言（"按切片迁移"、"整体迁移"等）判断是否为"抽象步骤"，导致误拦合法 intake package 和拼写略有差异的正常步骤。

**根因**：`requirementPlanText()` 拼接标题、reason、implementation_step 等自然语言字段，`broadPlanStepReason()` 对其做正则匹配，导致：
- 合法 intake action 被误拦
- 拼写变体绕过门禁
- 非中文步骤完全无法被检测

**已合入修复**（本次 commit）：将 gate 改为读取结构化 `source.execution_governance` 字段（`granularity`、`decomposition`、`verification`），`requirement-intake.js` 在生成 work package 时自动注入该字段。自然语言只辅助生成，不作为硬阻断依据。

---

### 2.5 【P1】当前活跃需求的 work package 被 owned_files 问题卡住

**现象**：需求"前端重构"的 work package `owned_files: ["."]`（整个 repo），action 为 `continue_requirement_intake`，无法通过 governance gate 派发。

**根因**：`owned_files: ["."]` 太宽泛，governance gate 检测到宽 scope 且缺少结构化执行声明，判定为不可派发。每轮 continuation 都生成同一个被挡回来的包，形成死循环。

**修复方向**：把 work package 的 `owned_files` 替换为具体文件列表，并通过 `createRequirementPlanWorkPackages` 重新生成带 `execution_governance` 的包（修复后的 governance gate 会自动通过）。

---

### 2.6 【P2】Closeout 强依赖 Live Workbench Server，没有降级模式

**现象**：`npm run check:closeout` 的验收链依赖 Playwright + workbench server + snapshot API，在 server 未运行时整个 closeout 失败。

**根因**：Closeout 没有区分"业务验收"和"live publish 验收"两个阶段，任何情况都走完整链路。Child worker 在隔离 worktree 执行时，无机制确认 server 存活状态。

**修复方向**：Closeout 支持 `local-only` 模式：当 server 不可达时跳过 browser events 和远端 snapshot，标记 `partial`，不阻塞业务验收。Live publish 验收只在用户明确要求或改动影响 served-route 时强制。

---

### 2.7 【P2】双状态源（SQLite + JSON）一致性问题

**现象**：`PROCESS.md` 要求"Workbench 运行态只写 SQLite"，但 `autonomous-continuation.js` 的 `decideContinuation()` 主要从 `PROJECT_STATUS.json` 读取 `global_goals`、`next_work_packages`。`PROJECT_STATUS.json` 有过从 `.sqlite.backup` 手动恢复的记录（`restoration_note`），说明两者已出现不一致。

**修复方向**：Continuation 决策优先从 SQLite（通过 workbench server API）读当前状态，以 JSON 作 fallback。Operator events 从 SQLite 摄入，不通过 JSON 文件绕路。

---

### 2.8 【P2】Scheduler Dispatch 三步链的路径耦合脆弱

**现象**：三步计划（run-reviewer-shard-loop → prepare-reviewer-shard-loop-continuation → run-autonomous-closeout-loop）的 `--workflow-state` 路径由上一步 `--output` 决定。任意步骤失败，后续步骤无法从中间点恢复。

**根因**：这是一个三步瀑布，不是可恢复的 DAG。`continuation_output` 注入机制有多层路径标准化，任一异常路径会导致 host boundary check fail-closed。

**修复方向**：每步持久化中间 artifact 到固定的 session-scoped 路径，续跑时检查该路径是否已有有效 artifact，有则跳过重跑；无则从最近成功步骤重新开始。

---

### 2.9 【P3·已修复】Workflow Guard 误拦合法操作

**现象**（修复前）：Guard 把 `git worktree add`（创建新 worktree 目录）列为 canonical checkout mutation，导致自动创建 worktree 被阻断，与 guard 自己的错误提示（"Create or use an isolated task worktree"）直接矛盾。此外，`git diff > /tmp/file` 因 `>` 被识别为 mutation，且 redirect 目标未提取，导致 canonical CWD 被误判为 mutation 目标。

**已修复**（guard 补丁）：
1. 从 `isMutation` 中移除 `worktree\s+add`
2. 在 `toolTargetPaths` 中添加 redirect 目标提取，使 `> /tmp/file` 以 `/tmp/file` 为 mutation 目标

---

## 三、流程设计合理性总评

| 模块 | 评分 | 主要问题 |
|------|------|---------|
| 需求录入 → Plan 生成 → 审批 | ★★★★☆ | 审批通过后向执行的跳转不自动 |
| Work Package 派发 + Governance Gate | ★★★★☆ | 已修复：改为结构化字段判断；`owned_files: ["."]` 仍需修正 |
| Child Worker 隔离执行 | ★★★★☆ | 设计合理；prompt 安全降噪要求在实践中容易被忽略 |
| LLM Reviewer Gate + Shard | ★★★☆☆ | Provider health 恢复无 hard exit，易陷死循环 |
| Autonomous Continuation 决策 | ★★★★☆ | 逻辑健全，但结果无自动触发器 |
| Closeout → Snapshot | ★★☆☆☆ | 依赖 live server，无降级模式 |
| 循环继续 Re-entry | ★★☆☆☆ | 根本性缺口：artifact 写出后无自动 re-entry |
| 状态一致性（SQLite vs JSON） | ★★★☆☆ | 双轨状态，已出现不一致 |
| Workflow Guard | ★★★★☆ | 已修复：`worktree add` 和 redirect 目标检测 |

---

## 四、核心修复优先级

| 优先级 | 问题 | 修复状态 |
|--------|------|---------|
| P0 | Continuation re-entry 缺口（每轮需手动触发 2–3 步） | 待修复 |
| P1 | Provider health smoke 无 hard exit，易死循环 | 待修复 |
| P1 | `projected_next_action` 无 fallback 到 `scheduler_dispatch_chain` | 待修复 |
| P1 | Governance gate 使用中文正则误拦 | **已修复（本次 commit）** |
| P1 | 当前需求 `owned_files: ["."]` 导致派发死循环 | 待修复（重新生成 work package） |
| P2 | Closeout 无降级模式，依赖 live server | 待修复 |
| P2 | SQLite/JSON 双状态不一致 | 待修复 |
| P2 | Scheduler dispatch 三步链无中间恢复点 | 待修复 |
| P3 | Workflow Guard 误拦 `worktree add` 和 redirect | **已修复（guard 补丁）** |

---

## 五、当前最可能的卡死路径（结合现状）

`PROJECT_STATUS.json` 中活跃需求"前端重构"的 work package 是 `continue_requirement_intake` + `owned_files: ["."]`：

1. Continuation 生成该 work package → Governance gate 拦截（`owned_files` 太宽 + 原先依赖中文正则）
2. Governance gate 修复后（本次 commit），原有 work package 仍缺少 `execution_governance` 字段 → gate 报 `missing_execution_governance` 错误
3. Continuation `should_continue: true`，但 closeout artifact 写出后无自动触发，需手动接续
4. 手动接续后，再次生成同一个 `owned_files: ["."]` 包 → 死循环

**直接解决步骤**：
1. 通过 `createRequirementPlanWorkPackages` 为"前端重构"需求重新生成 work packages（会自动注入 `execution_governance`）
2. 把 `owned_files` 精确到具体文件列表（`apps/workbench/`、相关 workflow/test 文件）
3. 修复 continuation re-entry：在 closeout 后直接触发下一轮调度

---

*本报告由 Claude Sonnet 4.6 于 2026-05-27 生成，基于对项目源码、合同文档、hook 逻辑的全量静态分析。*
