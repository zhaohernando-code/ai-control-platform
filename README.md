# AI Control Platform

AI Control Platform 是一个面向多项目软件研发的 AI 控制平台原型。它把需求录入、方案审核、任务拆解、Agent 调度、外部模型评审、质量门禁、恢复决策和工作台观察整合到同一套可追踪流程中，用于探索“由 AI 执行、由证据和门禁约束”的工程交付方式。

这个仓库重点展示的是平台级工程能力：如何把模糊需求转成可执行工作包，如何让多个模型和工具在受控边界内协作，如何把每次运行的决策、证据、产物和失败恢复记录沉淀为可复盘状态。

## Features

- Requirement intake: 将用户需求记录为结构化任务，并生成可审核的实施方案。
- Work package orchestration: 使用 Task DAG、Context Pack 和 Work Package 管理跨模块执行边界。
- Multi-agent execution control: 支持子任务分发、Agent 生命周期记录、执行证据回写和失败闭环。
- Reviewer gate: 将外部 LLM reviewer 作为质量门禁，而不是只依赖执行模型自评。
- Recovery engine: 根据运行状态、产物证据和阻塞原因生成恢复动作或下一轮任务。
- Ops Workbench: 提供 Next.js 工作台，用于查看项目、任务、运行状态、评审结果和下一步动作。
- Governance checks: 包含工作树隔离、流程硬化、主线发布准备、已知风险关闭和前端验收等自动化检查。

## Architecture

```text
User requirement
  -> plan generation and review
  -> task DAG / work package split
  -> context package dispatch
  -> agent execution
  -> artifact ledger and run manifest
  -> reviewer gate
  -> closeout / recovery / continuation
  -> Ops Workbench projection
```

Key directories:

- `src/workflow/`: workflow contracts, orchestration, recovery, reviewer, state, and governance logic.
- `tools/`: CLI entrypoints for checks, schedulers, workbench APIs, replay, and closeout.
- `apps/workbench/`: Next.js App Router frontend for the operator workbench.
- `test/`: Node.js regression tests for workflow behavior and platform gates.
- `docs/contracts/`: durable process and data contracts.
- `docs/examples/`: example workflow states, projections, and evidence artifacts.

## Tech Stack

- Runtime: Node.js 18+
- Frontend: Next.js 14, React 18, TypeScript, Ant Design
- Workflow core: JavaScript ES modules
- State and evidence: SQLite-backed workbench state, JSON manifests, artifact ledgers
- Testing: Node test runner, Playwright-based browser checks

## Quick Start

Install root dependencies and run the workflow regression suite:

```bash
npm install
npm test
```

Run the Workbench frontend:

```bash
cd apps/workbench
npm install
npm run dev
```

For the local Workbench service and API bridge, use the project script:

```bash
scripts/start-workbench-live.sh
```

The default development frontend runs on port `4181`; the service script starts the mounted workbench runtime and API bridge with the project defaults.

## Validation

Common checks:

```bash
npm run test:affected
npm run test:coverage
npm run check:process-hardening
npm run check:workbench:frontend-acceptance
npm run check:closeout
```

The full closeout check is intentionally broader than a unit test run. It validates process evidence, workbench behavior, closeout gates, and release readiness assumptions that matter for an AI-operated development flow.

## Project Notes

This repository is a platform prototype, not a generic task tracker. Its design assumes that AI agents can perform implementation work, but only inside explicit boundaries with durable state, review gates, replayable evidence, and recovery rules.

Related internal operating documents are kept out of the main narrative and can be read from:

- `PROJECT_STATUS.json`: current phase and handoff state
- `PROJECT_RULES.md`: repository rules and execution boundaries
- `PROCESS.md`: reusable workflow lessons
- `DECISIONS.md`: durable architecture and product decisions
- `PROJECT_PLAN.md`: long-lived plan and milestones
