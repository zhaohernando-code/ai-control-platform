import assert from "node:assert/strict";
import test from "node:test";

import { GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT } from "../src/workflow/governance-audit-skill-trial.js";
import {
  createMobileWorkbenchProjection,
  createWorkbenchProjection
} from "../src/workflow/workbench-projection.js";
import { baseInput } from "./helpers/workbench-projection.js";

test("workbench projection exposes governance audit repair as an automation next action", () => {
  const input = baseInput();
  const artifactId = "governance-audit-current";
  input.manifest.events.push({
    id: `event-${artifactId}`,
    type: GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT,
    status: "fail",
    artifact_id: artifactId,
    metadata: {
      status: "fail",
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
  });
  input.artifact_ledger.artifacts.push({
    id: artifactId,
    type: "evaluation",
    status: "fail",
    producer: "governance-audit-skill-trial",
    created_at: "2026-05-27T00:00:00.000Z",
    metadata: input.manifest.events.at(-1).metadata
  });
  const projection = createWorkbenchProjection(input);

  assert.equal(projection.governance_audit.status, "fail");
  assert.equal(projection.governance_audit.repair_required, true);
  assert.equal(projection.governance_audit.repair_work_package.action, "repair_governance_audit_defect");
  assert.equal(projection.next_action_readout.action, "prepare_project_status_continuation");
  assert.equal(projection.next_action_readout.source_type, GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT);
  assert.equal(projection.one_screen.counters.governance_audit_blockers, 1);
  assert.ok(projection.one_screen.next_actions.some((action) => action.action === "repair_governance_audit_defect"));
});

test("workbench projection uses the latest governance audit artifact with a repeated id", () => {
  const input = baseInput();
  const artifactId = "governance-audit-current";
  const failedMetadata = {
    status: "fail",
    final_verdict: "不通过",
    blocking_count: 1,
    findings: [
      {
        id: "stale-mainline-release-readiness",
        type: "明确缺陷",
        severity: "高",
        summary: "stale failure",
        repair_schedule: {
          target_files_or_modules: ["tools/check-closeout.mjs"],
          verification_commands: ["npm run check:closeout"]
        }
      }
    ]
  };
  const passedMetadata = {
    status: "pass",
    final_verdict: "带条件通过",
    blocking_count: 0,
    findings: [
      {
        id: "live-frontend-entry-verified",
        type: "可选迭代",
        severity: "低",
        summary: "latest pass",
        decision_package: {
          options: ["defer", "schedule follow-up"],
          tradeoffs: "low risk",
          recommended_option: "defer",
          estimated_cost: "low",
          confidence_gain: "low"
        }
      }
    ]
  };
  input.manifest.events.push(
    {
      id: `event-${artifactId}-failed`,
      type: GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT,
      status: "fail",
      artifact_id: artifactId,
      metadata: failedMetadata
    },
    {
      id: `event-${artifactId}-passed`,
      type: GOVERNANCE_AUDIT_SKILL_TRIAL_EVENT,
      status: "pass",
      artifact_id: artifactId,
      metadata: passedMetadata
    }
  );
  input.artifact_ledger.artifacts.push(
    {
      id: artifactId,
      type: "evaluation",
      status: "fail",
      producer: "governance-audit-skill-trial",
      created_at: "2026-05-27T00:00:00.000Z",
      metadata: failedMetadata
    },
    {
      id: artifactId,
      type: "evaluation",
      status: "pass",
      producer: "governance-audit-skill-trial",
      created_at: "2026-05-28T00:00:00.000Z",
      metadata: passedMetadata
    }
  );
  const projection = createWorkbenchProjection(input);

  assert.equal(projection.governance_audit.status, "pass");
  assert.equal(projection.governance_audit.final_verdict, "带条件通过");
  assert.equal(projection.governance_audit.blocking_count, 0);
  assert.equal(projection.one_screen.counters.governance_audit_blockers, 0);
});

test("workbench projection and mobile expose self-governance repair, evidence, and decision readout", () => {
  const input = baseInput({
    self_governance_findings: [
      {
        id: "fix-missing-live-verification",
        category: "defect",
        dimension: "quality_gate",
        title: "缺少真实页面验收",
        owned_files: ["tools/check-workbench-browser-events.mjs"]
      },
      {
        id: "sample-reviewer-timeout",
        category: "evidence_gap",
        dimension: "model_collaboration",
        title: "评审超时需要补样本"
      },
      {
        id: "weekly-self-review",
        category: "evolution_opportunity",
        dimension: "iteration_evolution",
        title: "周期性自我治理周报"
      }
    ]
  });

  const projection = createWorkbenchProjection(input);
  const mobile = createMobileWorkbenchProjection(input);

  assert.equal(projection.self_governance.status, "available");
  assert.equal(projection.self_governance.finding_count, 3);
  assert.equal(projection.self_governance.cadence, "weekly");
  assert.equal(projection.self_governance.role_count, 4);
  assert.equal(projection.self_governance.auto_repair_count, 1);
  assert.equal(projection.self_governance.evidence_building_count, 1);
  assert.equal(projection.self_governance.user_decision_count, 1);
  assert.equal(projection.self_governance.next_work_package_count, 2);
  assert.equal(projection.self_governance.decision_packages[0].status, "waiting_for_user_decision");
  assert.ok(projection.self_governance.decision_packages[0].facets.automation_authority.includes("可自动修复"));
  assert.equal(projection.one_screen.counters.self_governance_findings, 3);
  assert.equal(projection.one_screen.counters.self_governance_auto_repairs, 1);
  assert.equal(projection.one_screen.counters.self_governance_evidence_tasks, 1);
  assert.equal(projection.one_screen.counters.self_governance_user_decisions, 1);
  assert.equal(mobile.self_governance.finding_count, 3);
  assert.equal(mobile.self_governance.cadence, "weekly");
  assert.equal(mobile.self_governance.role_count, 4);
  assert.equal(mobile.self_governance.user_decision_count, 1);
});
