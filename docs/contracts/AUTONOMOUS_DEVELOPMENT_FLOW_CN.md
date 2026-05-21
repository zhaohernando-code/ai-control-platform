# 自主开发流程合同

状态：draft
宿主：`ai-control-platform`

## 1. 目标

建立一个让 AI 项目组在低人工介入下持续推进的流程：主进程负责流程设计和评审，子进程负责受限落地，系统负责门禁、状态、恢复和证据固化。

## 2. 标准循环

```text
用户需求
-> 宿主边界判定
-> Context Pack
-> 子任务拆解
-> 子进程实现
-> 主进程评审
-> 不合格则回退/修 gate/重跑
-> 合格则合并/发布/固化流程
```

## 3. 宿主边界

| 分类 | 含义 | 允许落点 |
| --- | --- | --- |
| `platform_core` | 中台本体能力 | `ai-control-platform` |
| `managed_project` | 被纳管业务项目功能 | 对应业务项目 |
| `integration_adapter` | 平台与业务项目之间的适配 | 双方明确 owns files 后执行 |

平台本体能力包括：Ops Workbench、任务 DAG、agent 调度、Recovery Engine、LLM Reviewer、CI/CD 门禁、周期体检、代码地图和流程治理。

## 4. Context Pack 必填项

- 原始需求摘要。
- 宿主分类和目标仓库。
- 非目标和禁止动作。
- owned files 或允许写入范围。
- 依赖能力成熟度。
- 子进程输入。
- 评审标准。
- 回退条件。

## 5. 主进程评审

主进程必须检查：

- 文件是否写在正确宿主。
- 是否遵守 owned files。
- 是否把 scaffold/partial 能力冒充 production。
- 是否通过测试、构建、registry、视觉或服务验收。
- 是否需要回退和重跑。

## 6. 代码化要求

成功流程必须沉淀到以下至少一类：

- gate 代码。
- JSON schema。
- 测试。
- generator/template。
- Workbench 可见状态。

仅写入总结文档不算完成。

