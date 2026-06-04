import { createArtifactLedger } from "../../src/workflow/artifact-ledger.js";
import { createReviewerGateRequest, createReviewerTimeoutFinding } from "../../src/workflow/llm-reviewer-gate.js";
import { buildModelCollaborationPlan } from "../../src/workflow/model-router.js";
import { createRunManifest } from "../../src/workflow/run-manifest.js";

export const WORKBENCH_PROJECTION_TEST_FILES = [
  "test/workbench-projection.test.js",
  "test/workbench-projection-agent-lifecycle-closed.test.js",
  "test/workbench-projection-agent-lifecycle.test.js",
  "test/workbench-projection-continuation-terminal.test.js",
  "test/workbench-projection-continuation.test.js",
  "test/workbench-projection-fixture.test.js",
  "test/workbench-projection-governance-lifecycle.test.js",
  "test/workbench-projection-headless-evidence.test.js",
  "test/workbench-projection-one-screen.test.js",
  "test/workbench-projection-operations-timeline.test.js",
  "test/workbench-projection-operator-events.test.js",
  "test/workbench-projection-project-management-dispatch.test.js",
  "test/workbench-projection-project-management.test.js",
  "test/workbench-projection-purity.test.js",
  "test/workbench-projection-reviewer-aggregate.test.js",
  "test/workbench-projection-reviewer-recovery.test.js",
  "test/workbench-projection-scheduler-dispatch.test.js",
  "test/workbench-projection-scheduler-loop.test.js",
  "test/workbench-projection-schema.test.js"
];

export function contextPack() {
  return {
    requirement_summary: "继续开发新中台：构建工作台 projection assembler",
    host: "platform_core",
    target_project_id: "ai-control-platform",
    non_goals: ["不修改 stock_dashboard", "不开发孤立 UI"],
    forbidden_actions: ["不得写入业务项目", "不得把 reviewer timeout 作为人工阻塞"],
    owned_files: ["src/workflow/workbench-projection.js", ...WORKBENCH_PROJECTION_TEST_FILES],
    acceptance_gates: [`node tools/run-with-node18.mjs --test ${WORKBENCH_PROJECTION_TEST_FILES.join(" ")}`],
    rollback_conditions: ["projection 丢失 run decision"],
    subtasks: [
      {
        id: "projection-runtime",
        title: "Workbench projection assembler runtime",
        owned_files: ["src/workflow/workbench-projection.js"]
      },
      {
        id: "projection-test",
        title: "Workbench projection tests",
        owned_files: WORKBENCH_PROJECTION_TEST_FILES,
        depends_on: ["projection-runtime"]
      }
    ]
  };
}

export function baseInput(overrides = {}) {
  const reviewerRequest = createReviewerGateRequest({
    run_id: "run-projection",
    cycle_id: "cycle-20260521",
    scope: "Review workbench projection assembler.",
    files: ["src/workflow/workbench-projection.js"],
    questions: ["projection 是否包含运行、模型、reviewer 和 DAG 状态？"]
  });
  const timeoutFinding = createReviewerTimeoutFinding(reviewerRequest, 120);
  const manifest = createRunManifest({
    run_id: "run-projection",
    cycle_id: "cycle-20260521",
    goal: "构建工作台 projection assembler",
    context_pack: contextPack(),
    work_packages: [
      { id: "projection-runtime", status: "completed", owned_files: ["src/workflow/workbench-projection.js"] },
      { id: "projection-test", status: "completed", owned_files: ["test/workbench-projection.test.js"] }
    ],
    artifacts: [{ id: "projection-patch", status: "pass" }],
    gate_results: [{ gate_id: "unit-tests", status: "pass" }],
    review_findings: [timeoutFinding],
    recovery_attempts: []
  });

  return {
    manifest,
    artifact_ledger: createArtifactLedger({
      run_id: "run-projection",
      cycle_id: "cycle-20260521",
      artifacts: [
        {
          id: "projection-patch",
          type: "patch",
          status: "pass",
          path: "src/workflow/workbench-projection.js",
          producer: "main-process",
          created_at: "2026-05-21T00:00:00.000Z"
        }
      ]
    }),
    model_plan: buildModelCollaborationPlan({
      goal: "构建工作台 projection assembler",
      stage: "implementation",
      risk: "high",
      budget_tier: "high",
      host: "platform_core",
      tags: ["boundary_sensitive"]
    }),
    reviewer_gate: {
      request: reviewerRequest,
      findings: [timeoutFinding]
    },
    task_dag: manifest.work_packages.map((pkg) => ({ ...pkg })),
    generated_at: "2026-05-21T00:01:00.000Z",
    ...overrides
  };
}
