import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertShouldContinue,
  CONTINUE,
  decideContinuation,
  RERUN,
  ROLLBACK,
  STOP_FOR_HUMAN
} from "../src/workflow/autonomous-continuation.js";

function projectStatus(overrides = {}) {
  return {
    project: "ai-control-platform",
    blockers: [],
    next_step: "Start the PC/mobile workbench frontend shell against validated projection JSON.",
    ...overrides
  };
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("continues when a completed run has a durable next step and no blockers", () => {
  const decision = assertShouldContinue({
    project_status: projectStatus(),
    run_evaluation: { status: "pass", next_work_packages: [] }
  });

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.should_continue, true);
  assert.equal(decision.context_pack_seed.target_project_id, "ai-control-platform");
  assert.match(decision.context_pack_seed.requirement_summary, /PC\/mobile workbench/);
});

test("does not stop just because a cycle summary was produced", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "Generate the next run manifest from the accepted projection fixture."
    }),
    run_evaluation: {
      status: "pass",
      reasons: ["all gates passed"]
    },
    summary_emitted: true
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.action, CONTINUE);
  assert.ok(decision.reasons.includes("project_status.next_step is present"));
});

test("reruns when autonomous run returns recoverable next work packages", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: {
      status: "rerun",
      next_work_packages: [
        {
          id: "rerun-reviewer",
          title: "Rerun reviewer gate with smaller scope",
          owned_files: ["src/workflow/llm-reviewer-gate.js"]
        }
      ]
    }
  });

  assert.equal(decision.action, RERUN);
  assert.equal(decision.should_continue, true);
  assert.equal(decision.context_pack_seed.subtasks[0].id, "rerun-reviewer");
});

test("approved requirement plans split broad intake into bounded implementation steps", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "",
      requirement_intake: {
        items: [
          {
            id: "requirement-frontend-refactor",
            title: "前端重构",
            status: "submitted",
            owned_files: ["."],
            acceptance_gates: ["npm run check:closeout"]
          }
        ]
      },
      plan_reviews: {
        "requirement-frontend-refactor": {
          phase: "in_development",
          id: "plan-review-requirement-frontend-refactor",
          plan_id: "plan-requirement-frontend-refactor",
          implementation_outline: ["盘点现状", "建立 Next.js + antd 骨架"],
          acceptance_gates: ["Next.js build passes"]
        }
      },
      next_work_packages: [
        {
          id: "requirement-frontend-refactor-intake",
          action: "continue_requirement_intake",
          global_goal_id: "requirement-frontend-refactor",
          owned_files: ["."]
        }
      ]
    }),
    run_evaluation: { status: "pass", next_work_packages: [] }
  });

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.next_work_packages.length, 2);
  assert.equal(decision.next_work_packages[0].id, "requirement-frontend-refactor-plan-step-01");
  assert.equal(decision.next_work_packages[0].action, "execute_requirement_plan_step");
  assert.ok(!decision.next_work_packages[0].acceptance_gates.some((gate) => gate.includes("建立 Next.js")));
  assert.equal(decision.next_work_packages[1].depends_on[0], "requirement-frontend-refactor-plan-step-01");
  assert.equal(decision.context_pack_seed.subtasks[0].action, "execute_requirement_plan_step");
});

test("approved requirement plan continuation removes dependencies already completed in prior cycles", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "",
      requirement_intake: {
        items: [
          {
            id: "requirement-frontend-refactor",
            title: "前端重构",
            status: "submitted",
            owned_files: ["."],
            acceptance_gates: ["npm run check:closeout"]
          }
        ]
      },
      plan_reviews: {
        "requirement-frontend-refactor": {
          phase: "in_development",
          id: "plan-review-requirement-frontend-refactor",
          plan_id: "plan-requirement-frontend-refactor",
          implementation_outline: ["盘点现状", "建立 Next.js + antd 骨架"],
          acceptance_gates: ["现状清单入库", "Next.js build passes"]
        }
      },
      next_work_packages: [
        {
          id: "requirement-frontend-refactor-intake",
          action: "continue_requirement_intake",
          global_goal_id: "requirement-frontend-refactor",
          owned_files: ["."]
        }
      ]
    }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: {
      manifest: {
        work_packages: [
          {
            id: "requirement-frontend-refactor-plan-step-01",
            status: "pass",
            global_goal_id: "requirement-frontend-refactor"
          }
        ]
      }
    }
  });

  assert.equal(decision.action, CONTINUE);
  assert.deepEqual(decision.next_work_packages.map((workPackage) => workPackage.id), [
    "requirement-frontend-refactor-plan-step-02"
  ]);
  assert.deepEqual(decision.next_work_packages[0].depends_on, []);
  assert.deepEqual(decision.context_pack_seed.subtasks[0].depends_on, []);
  assert.equal(decision.context_pack_seed.subtasks[0].source.implementation_step, "建立 Next.js + antd 骨架");
});

test("existing broad frontend view migration packages are split before dispatch", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: {
      status: "rerun",
      next_work_packages: [
        {
          id: "requirement-frontend-refactor-plan-step-04",
          title: "前端重构：实施步骤 04 / 7",
          action: "execute_requirement_plan_step",
          owned_files: ["."],
          acceptance_gates: ["npm run check:workbench:browser-events"],
          depends_on: ["requirement-frontend-refactor-plan-step-03"],
          reason: "按视图切片迁移：优先迁移高频核心视图（如工作台主页、需求录入、计划审核），每个切片以独立 PR 落地，并保持旧入口可回退。",
          source: {
            requirement_id: "requirement-frontend-refactor",
            plan_step_index: 4,
            plan_step_total: 7,
            constraints: "当前中台的所有前端代码，都用antd作为ui框架、react+next.js(app模式) 作为项目框架进行重构。",
            implementation_step: "按视图切片迁移：优先迁移高频核心视图（如工作台主页、需求录入、计划审核），每个切片以独立 PR 落地，并保持旧入口可回退。"
          }
        }
      ]
    }
  });

  assert.equal(decision.action, RERUN);
  assert.deepEqual(decision.next_work_packages.map((workPackage) => workPackage.id), [
    "requirement-frontend-refactor-plan-step-04-workbench-home",
    "requirement-frontend-refactor-plan-step-04-requirement-intake",
    "requirement-frontend-refactor-plan-step-04-plan-review"
  ]);
  assert.deepEqual(decision.next_work_packages[0].depends_on, ["requirement-frontend-refactor-plan-step-03"]);
  assert.deepEqual(decision.next_work_packages[1].depends_on, ["requirement-frontend-refactor-plan-step-04-workbench-home"]);
  assert.equal(decision.context_pack_seed.subtasks[0].source.plan_step_slice, "workbench-home");
});

test("rolls back without asking human when rollback is automatic", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: {
      status: "rollback",
      next_work_packages: [{ id: "rollback-host-drift", title: "Rollback host drift" }]
    }
  });

  assert.equal(decision.action, ROLLBACK);
  assert.equal(decision.should_continue, true);
});

test("stops only for human intervention blockers", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "Continue after credentials are supplied." }),
    run_evaluation: {
      status: "human_intervention",
      projection: {
        blockers: [{ id: "missing-token", category: "credentials" }]
      }
    }
  });

  assert.equal(decision.action, STOP_FOR_HUMAN);
  assert.equal(decision.should_continue, false);
  assert.equal(decision.context_pack_seed, null);
  assert.throws(() => assertShouldContinue({
    project_status: projectStatus(),
    run_evaluation: { status: "human_intervention", blockers: [{ category: "credentials" }] }
  }), { code: "AUTONOMOUS_CONTINUATION_STOPPED" });
});

test("stops when continuation points at the wrong host", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ project: "stock_dashboard" }),
    run_evaluation: { status: "pass" }
  });

  assert.equal(decision.status, "fail");
  assert.equal(decision.action, STOP_FOR_HUMAN);
  assert.equal(decision.should_continue, false);
  assert.ok(decision.validation.issues.some((issue) => issue.code === "project_mismatch"));
});

test("continuation emits a workbench snapshot publish plan when workflow state is projection-ready", () => {
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "Continue after publishing the latest workflow state."
    }),
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.snapshot_publish_plan.action, "publish_workbench_snapshot");
  assert.equal(decision.snapshot_publish_plan.endpoint, "/api/workbench/snapshots");
  assert.equal(decision.snapshot_publish_plan.id, "run-20260521-platform-self-trial");
  assert.equal(decision.snapshot_publish_plan.input, workflowState);
  assert.deepEqual(decision.snapshot_publish_issues, []);
});

test("continuation does not emit a snapshot publish plan when workflow state is not projection-ready", () => {
  const workflowState = {
    manifest: {
      run_id: "run-closeout",
      cycle_id: "cycle-closeout"
    },
    artifact_ledger: {
      artifacts: []
    }
  };
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "Continue after publishing the latest workflow state."
    }),
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.snapshot_publish_plan, null);
  assert.ok(decision.snapshot_publish_issues.includes("projection input validation must pass before snapshot publish"));
});

test("continuation does not emit a snapshot publish plan without operator event facts", () => {
  const workflowState = readJson("docs/examples/current-session-workbench-input.json");
  delete workflowState.operator_event_ledger;
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "Continue after publishing the latest workflow state."
    }),
    run_evaluation: { status: "pass" },
    workflow_state: workflowState
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.snapshot_publish_plan, null);
  assert.ok(decision.snapshot_publish_issues.includes("operator events must apply before snapshot publish"));
});

test("project status next work packages are durable continuation inputs", () => {
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "Continue from scheduler continuation.",
      next_work_packages: [
        {
          id: "scheduler-continuation-next",
          title: "Continue from scheduler continuation.",
          action: "continue_scheduler",
          owned_files: ["src/workflow/scheduler-dispatch-continuation.js"]
        }
      ]
    }),
    run_evaluation: { status: "pass", next_work_packages: [] }
  });

  assert.equal(decision.should_continue, true);
  assert.equal(decision.next_work_packages.length, 1);
  assert.equal(decision.next_work_packages[0].id, "scheduler-continuation-next");
  assert.deepEqual(decision.context_pack_seed.owned_files, ["src/workflow/scheduler-dispatch-continuation.js"]);
});
