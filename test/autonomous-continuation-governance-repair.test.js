import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTINUE,
  decideContinuation
} from "../src/workflow/autonomous-continuation.js";
import { GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT } from "../src/workflow/governance-audit-skill-trial.js";

function projectStatus(overrides = {}) {
  return {
    project: "ai-control-platform",
    blockers: [],
    next_step: "Start the PC/mobile workbench frontend shell against validated projection JSON.",
    ...overrides
  };
}

test("self-governance defects and evidence gaps become continuation work packages", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: {
      manifest: {
        events: [
          {
            id: "self-governance-defect",
            type: "self_governance_finding",
            metadata: {
              id: "governance-defect",
              category: "defect",
              dimension: "quality_gate",
              severity: "high",
              title: "Self-governance defect must be repaired",
              owned_files: ["src/workflow/self-governance.js"],
              acceptance_gates: ["node --test test/self-governance.test.js"]
            }
          },
          {
            id: "self-governance-evidence-gap",
            type: "self_governance_finding",
            metadata: {
              id: "governance-evidence-gap",
              category: "evidence_gap",
              dimension: "model_collaboration",
              severity: "medium",
              title: "Self-governance evidence must be collected",
              owned_files: ["src/workflow/model-router.js"],
              acceptance_gates: ["node --test test/model-router.test.js"]
            }
          },
          {
            id: "self-governance-iteration",
            type: "self_governance_finding",
            metadata: {
              id: "governance-iteration",
              category: "evolution_opportunity",
              dimension: "iteration_evolution",
              severity: "low",
              title: "Optional governance improvement"
            }
          }
        ]
      }
    }
  });

  const packageIds = decision.next_work_packages.map((workPackage) => workPackage.id);
  assert.equal(decision.action, CONTINUE);
  assert.ok(packageIds.includes("self-governance-fix-governance-defect"));
  assert.ok(packageIds.includes("self-governance-evidence-governance-evidence-gap"));
  assert.ok(!packageIds.includes("self-governance-decision-governance-iteration"));
  assert.ok(decision.context_pack_seed.subtasks.some((subtask) => subtask.id === "self-governance-fix-governance-defect"));
  assert.ok(decision.context_pack_seed.acceptance_gates.includes("node --test test/self-governance.test.js"));
});

test("invalid self-governance findings do not become continuation work packages", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: {
      manifest: {
        events: [
          {
            id: "invalid-self-governance-finding",
            type: "self_governance_finding",
            metadata: {
              id: "invalid-governance",
              category: "made_up",
              dimension: "fake_dimension",
              title: "Invalid governance finding"
            }
          }
        ]
      }
    }
  });

  assert.ok(!decision.next_work_packages.some((workPackage) => workPackage.id.includes("invalid-governance")));
});

test("frontend repair continuation deduplicates package ids and preserves repair gates", () => {
  const repairPackageId = "frontend-acceptance-repair-frontend-acceptance-current-workbench";
  const repairOwnedFiles = ["apps/workbench", "test/workbench-shell.test.js"];
  const repairGates = [
    "npm run check:workbench:frontend-acceptance",
    "npm run check:workbench:browser-events",
    "npm run check:closeout"
  ];
  const decision = decideContinuation({
    project_status: projectStatus({
      next_step: "",
      next_work_packages: [
        {
          id: repairPackageId,
          title: "Repair PC/mobile workbench frontend acceptance blockers",
          action: "repair_frontend_acceptance",
          owned_files: repairOwnedFiles,
          acceptance_gates: repairGates
        }
      ],
      global_goals: [
        {
          id: "pc-mobile-autonomous-workbench",
          title: "PC/mobile autonomous workbench",
          status: "in_progress",
          next_step: "Repair frontend acceptance blockers.",
          owned_files: repairOwnedFiles
        }
      ]
    }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: {
      manifest: {
        run_id: "run-frontend-continuation-dedupe",
        cycle_id: "cycle-frontend-continuation-dedupe",
        events: [
          {
            id: "event-frontend-acceptance-current-workbench",
            type: "frontend_acceptance_run",
            status: "fail",
            artifact_id: "frontend-acceptance-current-workbench",
            metadata: {
              status: "fail",
              blocking_count: 1,
              blocking_findings: [
                {
                  code: "desktop-dead-tabs",
                  status: "fail",
                  severity: "p1",
                  message: "Desktop navigation tabs do not change content."
                }
              ],
              findings: [
                {
                  code: "desktop-dead-tabs",
                  status: "fail",
                  severity: "p1",
                  message: "Desktop navigation tabs do not change content."
                }
              ],
              viewport_results: [
                { viewport: "desktop" },
                { viewport: "desktop_narrow" },
                { viewport: "mobile" }
              ]
            }
          }
        ],
        artifacts: []
      },
      artifact_ledger: {
        artifacts: [
          {
            id: "frontend-acceptance-current-workbench",
            status: "fail",
            metadata: {
              status: "fail",
              blocking_count: 1,
              blocking_findings: [
                {
                  code: "desktop-dead-tabs",
                  status: "fail",
                  severity: "p1",
                  message: "Desktop navigation tabs do not change content."
                }
              ],
              findings: [
                {
                  code: "desktop-dead-tabs",
                  status: "fail",
                  severity: "p1",
                  message: "Desktop navigation tabs do not change content."
                }
              ],
              viewport_results: [
                { viewport: "desktop" },
                { viewport: "desktop_narrow" },
                { viewport: "mobile" }
              ]
            }
          }
        ]
      }
    }
  });

  const repairPackages = decision.next_work_packages.filter((workPackage) => {
    return workPackage.id === repairPackageId;
  });
  const subtaskIds = decision.context_pack_seed.subtasks.map((subtask) => subtask.id);

  assert.equal(repairPackages.length, 1);
  assert.equal(subtaskIds.filter((id) => id === repairPackageId).length, 1);
  assert.equal(new Set(subtaskIds).size, subtaskIds.length);
  assert.ok(decision.context_pack_seed.acceptance_gates.includes("npm run check:workbench:frontend-acceptance"));
  assert.ok(decision.context_pack_seed.acceptance_gates.includes("npm run check:workbench:browser-events"));
  assert.ok(decision.context_pack_seed.acceptance_gates.includes("npm run check:closeout"));
  assert.deepEqual(decision.context_pack_seed.subtasks[0].source.acceptance_gates, repairGates);
});

test("governance audit failure schedules a bounded repair package for continuation", () => {
  const artifactId = "governance-audit-current";
  const workflowState = {
    manifest: {
      run_id: "run-governance-repair",
      cycle_id: "cycle-governance-repair",
      events: [
        {
          id: `event-${artifactId}`,
          type: GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT,
          status: "fail",
          artifact_id: artifactId,
          metadata: {
            final_verdict: "不通过",
            blocking_count: 1,
            findings: [
              {
                id: "served-entry-stack-mismatch",
                type: "明确缺陷",
                severity: "高",
                summary: "真实入口仍服务 desktop.html",
                repair_schedule: {
                  target_files_or_modules: ["tools/workbench-server.mjs", "apps/workbench"],
                  verification_commands: ["npm run run:governance-audit-skill-trial", "npm run check:closeout"]
                }
              }
            ]
          }
        }
      ],
      artifacts: []
    },
    artifact_ledger: {
      artifacts: [
        {
          id: artifactId,
          status: "fail",
          metadata: {
            final_verdict: "不通过",
            blocking_count: 1,
            findings: [
              {
                id: "served-entry-stack-mismatch",
                type: "明确缺陷",
                severity: "高",
                summary: "真实入口仍服务 desktop.html",
                repair_schedule: {
                  target_files_or_modules: ["tools/workbench-server.mjs", "apps/workbench"],
                  verification_commands: ["npm run run:governance-audit-skill-trial", "npm run check:closeout"]
                }
              }
            ]
          }
        }
      ]
    }
  };
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "", next_work_packages: [] }),
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: workflowState
  });
  const repairPackage = decision.next_work_packages.find((workPackage) => {
    return workPackage.action === "repair_governance_audit_defect";
  });

  assert.equal(decision.action, CONTINUE);
  assert.ok(repairPackage);
  assert.ok(repairPackage.owned_files.includes("tools/workbench-server.mjs"));
  assert.ok(repairPackage.owned_files.includes("apps/workbench"));
  assert.ok(repairPackage.acceptance_gates.includes("npm run run:governance-audit-skill-trial"));
  assert.ok(decision.context_pack_seed.subtasks.some((subtask) => subtask.source.governance_audit?.artifact_id === artifactId));
});
