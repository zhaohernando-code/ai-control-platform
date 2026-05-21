# 项目 Onboarding 配置同步合同

状态：draft
宿主：`ai-control-platform`

## 1. 背景

本次新中台建仓暴露出一个系统性问题：新增项目后，如果只创建源码目录，而没有同步 workspace 索引、hook 路由、根级入口文档、控制面路由测试和项目自身状态文件，后续会话和默认 skill 仍可能把任务路由到旧项目。

因此“新建项目”不能只等于 `mkdir + git init`。它必须是一个可检查的 onboarding 流程。

## 2. 必须同步的配置

每个正式项目至少需要：

- 项目仓：`projects/<project-id>`。
- 项目入口文档：`README.md`、`PROJECT_RULES.md`、`PROCESS.md`、`PROJECT_STATUS.json`、`DECISIONS.md`。
- 若有阶段计划：`PROJECT_PLAN.md`。
- 机器目录：根级 `WORKSPACE_INDEX.json`。
- 根级入口文档：`README.md`、`CLAUDE.md`、`CODEX.md`、`plan.md` 中的项目列表或路由规则。
- Hook 路由回归：`scripts/agent-workflow-guard.test.js`。
- 控制面任务路由回归：旧控制面仍存在时，`local-control-server/workspace-init-route.test.js`。
- 项目 manifest：`project-manifest.json`，用于描述 aliases、project_type、宿主边界和迁移来源。

## 3. 禁止状态

- 新项目已存在，但 `WORKSPACE_INDEX.json` 未登记。
- `WORKSPACE_INDEX.json` 已登记，但 canonical docs 缺入口文件。
- 默认 hook 仍把项目关键别名解析到旧项目。
- 根级文档仍把旧项目描述成新能力默认宿主。
- 新项目只在右侧输出或临时文件里存在，没有 git commit。

## 4. 代码化要求

`project-onboarding-sync` gate 至少检查：

- manifest 中的 `project_id` 与 workspace index 项一致。
- aliases 至少有一个在 workspace index 项中存在。
- required docs 都在 canonical docs 中登记。
- `project_type` 与 manifest 一致。
- 对平台本体项目，`project_type` 必须是 `platform-core`。

后续应接入：

- 根级文档引用检查。
- hook route snapshot 检查。
- 远端仓库和默认分支检查。
- 控制面项目目录注册检查。

