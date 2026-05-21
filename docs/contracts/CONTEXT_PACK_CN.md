# Context Pack 与 Work Package 合同

状态：draft
宿主：`ai-control-platform`

## 1. 目标

Context Pack 是主进程派发子进程前必须生成的机器可读边界包。它把需求、宿主、禁止动作、owned files、验收门禁和回退条件放在同一个对象里，先通过 `host-boundary` gate，再拆成可执行的 Work Package。

Work Package 是对子任务的最小派发单元。每个包必须有明确 `id`、`owned_files`、`depends_on`、`dispatch_allowed` 和 `blocked_reasons`，让主进程能在派发前阻止跑偏。

## 2. Context Pack 必填字段

| 字段 | 含义 | 门禁 |
| --- | --- | --- |
| `requirement_summary` | 用户需求的压缩摘要 | 作为 `host-boundary` 的 request 输入 |
| `host` | 宿主分类：`platform_core`、`managed_project` 或 `integration_adapter` | `platform_core` 必须落在 `ai-control-platform` |
| `target_project_id` | 目标项目 id | 平台核心需求不得指向 `stock_dashboard`、`lobechat` 等被纳管项目 |
| `non_goals` | 本轮明确不做的事项 | 缺失会让任务范围不可控 |
| `forbidden_actions` | 禁止动作，例如写入业务项目或回退他人改动 | 派发前可转成执行约束 |
| `owned_files` | 本轮允许写入的文件集合 | 子任务 owned files 必须是它的子集 |
| `acceptance_gates` | 测试、构建、文档或服务验收命令 | 主进程评审时逐项核对 |
| `rollback_conditions` | 需要回退或重跑的条件 | 让失败处理可执行 |
| `subtasks` | 子任务列表 | 每个子任务必须声明自己的 `owned_files` |

## 3. Work Package 字段

| 字段 | 含义 |
| --- | --- |
| `id` | 子任务 id；未提供时由系统生成 `wp-1`、`wp-2` |
| `owned_files` | 该子任务允许写入的文件 |
| `depends_on` | 依赖的 Work Package id，顺序原样保留 |
| `dispatch_allowed` | 是否允许派发 |
| `blocked_reasons` | 阻止派发的原因，例如 `host_boundary_violation`、`missing_owned_files`、`owned_file_out_of_scope` |

## 4. 派发门禁

派发前应调用 `assertContextPackReady(contextPack)`：

1. 校验 Context Pack 是否包含全部必填字段。
2. 复用 `src/workflow/host-boundary.js` 判断需求是否落在正确宿主。
3. 确认 `platform_core` 只能指向 `ai-control-platform`。
4. 确认每个子任务有 `owned_files`，且不超出 Context Pack 的 `owned_files`。
5. 保留并校验 `depends_on`，避免子任务在依赖未完成前被误派发。

如果任一门禁失败，函数抛出 `CONTEXT_PACK_NOT_READY`，错误对象中包含 `validation` 与 `work_packages`，主进程可直接展示阻断原因或重生成 Context Pack。

## 5. 为什么能防跑偏

过去的跑偏通常发生在需求已经说明“中台/平台”，但执行层被 cwd、历史上下文或业务项目惯性带到 `stock_dashboard` 等被纳管项目。Context Pack 把宿主分类和目标项目作为必填字段，并把平台核心需求重新交给 `host-boundary` 判定；只要平台需求指向业务项目，Work Package 会得到 `dispatch_allowed: false`。

同时，Work Package 不允许缺省写入范围。子进程只能处理自己声明的 `owned_files`，且这些文件必须来自 Context Pack 顶层集合。这样可以把“不要改其他仓库、不要覆盖别人文件”从口头约束变成可执行 gate。
