# Run Manifest、Artifact Ledger 与 Task DAG 合同

状态：draft
宿主：`ai-control-platform`

## 1. 目标

Run Manifest 是一次自主开发运行的机器可读清单。它把 Context Pack、派发的 Work Package、运行事件、产物证据、门禁结果、评审发现和恢复尝试放到同一个对象里，让主进程、工作台和恢复引擎读取同一份事实。

Artifact Ledger 是 Run Manifest 的证据账本。它记录每个需求、Context Pack、patch、test、review、evaluation、design 等 artifact 的来源和可追踪证据，避免只靠口头总结判断一次运行是否完成。

Task DAG 是后续调度层。当前合同只约定它如何消费 Manifest 与 Ledger，不在本轮实现 DAG。

## 2. Run Manifest 字段

| 字段 | 含义 |
| --- | --- |
| `run_id` | 单次运行 id |
| `cycle_id` | 所属自主开发循环 id |
| `goal` | 本轮目标摘要 |
| `context_pack` | 派发前生成并通过门禁的 Context Pack |
| `work_packages` | 本轮实际派发或执行的 Work Package |
| `events` | 运行事件，例如创建、派发、测试、评审、恢复 |
| `artifacts` | 与 `evaluateRunResult` 兼容的 artifact 状态摘要 |
| `gate_results` | host boundary、owned files、测试、构建、发布验收等门禁结果 |
| `review_findings` | 主进程或 LLM reviewer 的结构化发现 |
| `recovery_attempts` | 自动重跑、修复或回退尝试 |

`validateRunManifest` 必须先复用 `validateContextPack` 与 `createWorkPackages` 的语义，确认 `context_pack` 已 ready。Manifest 中的 `work_packages` 只能引用 Context Pack 生成出的包；如果出现额外包、重复 id，或写入范围越过对应包的 `owned_files`，必须失败。

`buildRunResultFromManifest` 输出下列结构，可直接传给 `evaluateRunResult`：

```js
{
  run_id,
  cycle_id,
  work_packages,
  artifacts,
  gate_results,
  review_findings,
  recovery_attempts
}
```

它不执行测试、不读取仓库、不决定 rerun/rollback，只负责把 Manifest 投影成平台中立的 run result。

## 3. Artifact Ledger 字段

每条 artifact 必须包含：

| 字段 | 含义 |
| --- | --- |
| `id` | artifact id，同一 ledger 内唯一 |
| `type` | `requirement`、`context_pack`、`patch`、`test`、`review`、`evaluation`、`design` |
| `status` | 该证据状态，例如 `pass`、`fail`、`created` |
| `path` / `uri` / `content_hash` | 至少一项，用于定位或校验证据 |
| `producer` | 产出者，例如 user、main-process、agent-c、llm-reviewer、ci |
| `created_at` | 创建时间 |

Ledger 的最小职责是可追踪和可统计：

- `recordArtifact` 追加证据并返回新 ledger，不修改原对象。
- `validateArtifactLedger` 拦截缺少证据定位的条目。
- `summarizeArtifactLedger` 输出 total、by_type、by_status，供工作台展示。

Ledger 不要求 artifact 必须来自文件系统。远程 CI、GitHub PR、浏览器截图、设计稿或纯 content hash 都可以通过 `uri` 或 `content_hash` 入账。

## 4. 与 Task DAG 的关系

Task DAG 负责表达任务之间的依赖和调度顺序；Run Manifest 负责记录一次 DAG 执行的事实；Artifact Ledger 负责记录执行产生的证据。

接口预期：

```js
{
  dag_id: "cycle-20260521",
  nodes: [
    {
      id: "manifest",
      work_package_id: "manifest",
      depends_on: [],
      expected_artifacts: ["context_pack", "patch", "test"]
    }
  ],
  edges: [
    { from: "manifest", to: "ledger", reason: "ledger consumes manifest artifact summary" }
  ]
}
```

后续 DAG 实现必须遵守以下边界：

- DAG 节点只能引用 Context Pack 生成并允许派发的 Work Package。
- DAG 执行完成后必须写入 Run Manifest。
- 节点产物必须进入 Artifact Ledger，不能只留在日志或聊天总结里。
- `evaluateRunResult` 仍以 Manifest 投影出的 run result 为输入，不能直接依赖某个 DAG 引擎。

## 5. 平台中立边界

这三个对象都不绑定业务项目、CI 厂商、GitHub、浏览器或具体 agent 实现。业务项目只能作为 Context Pack 的 `target_project_id` 或 artifact 的证据来源出现，不能让平台本体逻辑落到 `stock_dashboard`、`lobechat` 等被纳管项目。

本轮只实现 Manifest 与 Ledger 基座。Task DAG 保持合同预期，待后续调度器轮次实现。
