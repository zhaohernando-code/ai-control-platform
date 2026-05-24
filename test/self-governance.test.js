import assert from "node:assert/strict";
import test from "node:test";

import {
  GOVERNANCE_DIMENSIONS,
  GOVERNANCE_ROLES,
  createSelfGovernanceCyclePlan,
  createSelfGovernanceReport,
  summarizeSelfGovernance,
  validateSelfGovernanceInput
} from "../src/workflow/self-governance.js";
import {
  createSelfGovernanceDispatchPlan,
  dispatchSelfGovernanceAutoRepairs
} from "../src/workflow/self-governance-dispatch.js";
import { generateSelfGovernanceFindings } from "../src/workflow/self-governance-scanner.js";

function sampleFindings() {
  return [
    {
      id: "missing-browser-gate-remediation",
      category: "defect",
      dimension: "quality_gate",
      severity: "high",
      title: "工作台验收缺少浏览器验证自动修复",
      message: "明确缺陷不能只告警，必须进入中台开发流程补齐验证。",
      owned_files: ["tools/check-workbench-browser-events.mjs", "test/workbench-server.test.js"],
      acceptance_gates: ["node --test test/workbench-server.test.js"]
    },
    {
      id: "reviewer-timeout-sample-too-small",
      category: "evidence_gap",
      dimension: "model_collaboration",
      severity: "medium",
      title: "模型评审超时样本不足",
      evidence_needed: "补充 provider smoke 和小范围复现，确认是服务健康还是任务粒度问题。",
      owned_files: ["src/workflow/reviewer-provider-health.js", "test/reviewer-provider-health.test.js"]
    },
    {
      id: "weekly-governance-review",
      category: "evolution_opportunity",
      dimension: "iteration_evolution",
      severity: "medium",
      title: "建立周期性自我治理周报",
      recommendation: "把质量、健壮性、模型协作和产品演进汇总为用户可决策议题。"
    }
  ];
}

test("self-governance covers the expanded inspection dimensions", () => {
  assert.deepEqual(GOVERNANCE_DIMENSIONS, [
    "code_quality",
    "system_robustness",
    "iteration_evolution",
    "user_experience",
    "flow_integrity",
    "quality_gate",
    "recovery_capability",
    "model_collaboration",
    "cost_efficiency",
    "security_permission",
    "knowledge_retention",
    "product_capability_gap"
  ]);
  assert.equal(GOVERNANCE_ROLES.length, 4);
  assert.ok(GOVERNANCE_ROLES.some((role) => role.id === "code_quality_guard"));
  assert.ok(GOVERNANCE_ROLES.some((role) => role.id === "robustness_assessor"));
  assert.ok(GOVERNANCE_ROLES.some((role) => role.id === "product_evolution_planner"));
  assert.ok(GOVERNANCE_ROLES.some((role) => role.id === "model_collaboration_auditor"));
});

test("self-governance cycle plan makes the inspection periodic and role-based", () => {
  const plan = createSelfGovernanceCyclePlan({
    cadence: "daily",
    dimensions: ["code_quality", "system_robustness", "iteration_evolution"]
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.cadence, "daily");
  assert.equal(plan.cadence_label, "每日");
  assert.equal(plan.next_trigger, "下一次日常巡检窗口");
  assert.ok(plan.roles.some((role) => role.id === "code_quality_guard"));
  assert.ok(plan.roles.some((role) => role.id === "robustness_assessor"));
  assert.ok(plan.roles.some((role) => role.id === "product_evolution_planner"));
  assert.equal(plan.handoff_policy.defects, "明确缺陷直接生成中台修复工作包");
});

test("self-governance report routes defects, evidence gaps, and evolution opportunities differently", () => {
  const report = createSelfGovernanceReport({
    created_at: "2026-05-24T00:00:00.000Z",
    findings: sampleFindings()
  });

  assert.equal(report.status, "available");
  assert.equal(report.finding_count, 3);
  assert.equal(report.auto_repair.count, 1);
  assert.equal(report.evidence_building.count, 1);
  assert.equal(report.user_decisions.count, 1);
  assert.equal(report.next_work_packages.length, 2);
  assert.equal(report.cycle_plan.cadence, "weekly");
  assert.equal(report.cycle_plan.roles.length, 4);

  const repair = report.auto_repair.work_packages[0];
  assert.equal(repair.action, "run_context_work_packages");
  assert.equal(repair.governance_action, "auto_remediate_defect");
  assert.equal(repair.source_finding_id, "missing-browser-gate-remediation");
  assert.deepEqual(repair.owned_files, ["tools/check-workbench-browser-events.mjs", "test/workbench-server.test.js"]);
  assert.deepEqual(repair.acceptance_gates, ["node --test test/workbench-server.test.js"]);

  const evidence = report.evidence_building.work_packages[0];
  assert.equal(evidence.governance_action, "collect_evidence_before_remediation");
  assert.equal(evidence.source_finding_id, "reviewer-timeout-sample-too-small");
});

test("evolution opportunities become structured user decision packages, not simple yes/no prompts", () => {
  const report = createSelfGovernanceReport({ findings: sampleFindings() });
  const decision = report.user_decisions.packages[0];

  assert.equal(decision.status, "waiting_for_user_decision");
  assert.equal(decision.title, "建立周期性自我治理周报");
  assert.ok(decision.options.length >= 3);
  assert.deepEqual(Object.keys(decision.facets), [
    "priority",
    "scope",
    "depth",
    "automation_authority",
    "cadence",
    "cost_ceiling",
    "output"
  ]);
  assert.ok(decision.facets.priority.includes("现在做"));
  assert.ok(decision.facets.automation_authority.includes("可自动修复"));
  assert.ok(decision.facets.output.includes("自动生成修复任务"));
  assert.equal(decision.default_decision.automation_authority, "修复前需确认");
});

test("self-governance can read durable findings from workflow state events", () => {
  const report = createSelfGovernanceReport({
    workflow_state: {
      manifest: {
        events: [
          {
            id: "event-governance-finding",
            type: "self_governance_finding",
            status: "pass",
            metadata: sampleFindings()[0]
          }
        ]
      }
    }
  });

  assert.equal(report.finding_count, 1);
  assert.equal(report.auto_repair.count, 1);
});

test("self-governance scanner generates findings from real gate and acceptance evidence without sample input", () => {
  const scan = generateSelfGovernanceFindings({
    project_status: {
      blockers: [],
      next_step: ""
    },
    git_worktree_isolation: {
      status: "fail",
      issues: [
        {
          code: "dirty_main_worktree_not_allowed",
          message: "main branch must stay clean"
        }
      ]
    },
    frontend_acceptance: {
      status: "fail",
      artifact_id: "frontend-acceptance-current-workbench",
      blocking_count: 1,
      latest_finding: "mobile navigation overlaps control buttons",
      finding_codes: ["mobile_control_overlap"],
      repair_required: true,
      repair_work_package: {
        owned_files: ["apps/workbench/mobile.html"],
        acceptance_gates: ["npm run check:workbench:frontend-acceptance"]
      }
    },
    scheduler_continuation: {
      status: "pass",
      ready: true,
      next_work_package_count: 1,
      artifact_id: "scheduler-continuation-ready"
    }
  });

  assert.equal(scan.status, "pass");
  assert.equal(scan.finding_count, 3);
  assert.ok(scan.findings.some((finding) => finding.id === "git-worktree-isolation-failed"));
  assert.ok(scan.findings.some((finding) => finding.id === "frontend-acceptance-blockers"));
  assert.ok(scan.findings.some((finding) => finding.id === "scheduler-continuation-ready-not-consumed"));

  const report = createSelfGovernanceReport({
    generate_findings: true,
    governance_sources: {
      git_worktree_isolation: scan.findings.find(() => false),
      frontend_acceptance: {
        status: "fail",
        artifact_id: "frontend-acceptance-current-workbench",
        blocking_count: 1,
        latest_finding: "mobile navigation overlaps control buttons",
        repair_required: true
      },
      scheduler_continuation: {
        status: "pass",
        ready: true,
        next_work_package_count: 1
      }
    }
  });

  assert.equal(report.auto_repair.count, 1);
  assert.equal(report.evidence_building.count, 1);
  assert.equal(report.findings[0].id, "frontend-acceptance-blockers");
});

test("self-governance scan records evidence coverage when real sources have no findings", () => {
  const report = createSelfGovernanceReport({
    generate_findings: true,
    governance_sources: {
      require_scanner_findings: true,
      evidence_sources: ["frontend_acceptance", "workbench_browser_events", "scheduler_dispatch"],
      frontend_acceptance: { status: "pass", blocking_count: 0 },
      workbench_browser_events: { status: "pass", scenario_count: 15 },
      scheduler_dispatch: { status: "pass" },
      scheduler_continuation: { status: "not_configured", ready: false },
      scheduler_loop: { status: "not_configured" },
      project_status: { blockers: [], next_step: "" }
    }
  });

  assert.equal(report.finding_count, 1);
  assert.equal(report.evidence_building.count, 1);
  assert.equal(report.findings[0].id, "self-governance-no-real-findings-recorded");
});

test("self-governance scanner turns unrunnable evidence commands into evidence gaps", () => {
  const report = createSelfGovernanceReport({
    generate_findings: true,
    governance_sources: {
      command_results: [
        {
          id: "workbench-frontend-acceptance",
          command: "node tools/check-workbench-frontend-acceptance.mjs",
          status: "fail",
          stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'playwright'"
        }
      ],
      project_status: { blockers: [], next_step: "" }
    }
  });

  assert.equal(report.finding_count, 1);
  assert.equal(report.evidence_building.count, 1);
  assert.equal(report.findings[0].id, "governance-command-workbench-frontend-acceptance");
  assert.equal(report.findings[0].category, "evidence_gap");
});

test("self-governance auto-repair dispatch starts context workflow execution", () => {
  const report = createSelfGovernanceReport({
    findings: [
      {
        id: "project-status-has-blockers",
        category: "defect",
        dimension: "flow_integrity",
        severity: "high",
        title: "项目状态仍存在阻塞项",
        recommended_fix: "把 PROJECT_STATUS.blockers 转成可派发修复工作包。",
        owned_files: ["PROJECT_STATUS.json", "src/workflow/project-status-continuation.js"],
        acceptance_gates: ["npm run check:closeout"]
      }
    ]
  });
  const plan = createSelfGovernanceDispatchPlan(report, {
    run_id: "run-self-governance-dispatch-test",
    cycle_id: "cycle-self-governance-dispatch-test",
    created_at: "2026-05-24T00:00:00.000Z"
  });

  assert.equal(plan.status, "ready");
  assert.equal(plan.auto_repair_count, 1);
  assert.equal(plan.workflow_state.manifest.work_packages[0].id, "self-governance-fix-project-status-has-blockers");

  const run = dispatchSelfGovernanceAutoRepairs(report, {
    run_id: "run-self-governance-dispatch-test",
    cycle_id: "cycle-self-governance-dispatch-test",
    created_at: "2026-05-24T00:01:00.000Z"
  });

  assert.equal(run.status, "pass");
  assert.equal(run.started_work_package_count, 1);
  assert.deepEqual(run.started_work_package_ids, ["self-governance-fix-project-status-has-blockers"]);
  assert.equal(
    run.workflow_state.manifest.work_packages[0].status,
    "completed"
  );
  assert.ok(run.workflow_state.manifest.events.some((event) => event.type === "context_work_packages_run"));
  assert.ok(run.workflow_state.manifest.events.some((event) => event.type === "WorkerSpawned"));
});

test("self-governance summary is workbench-friendly", () => {
  const report = createSelfGovernanceReport({ findings: sampleFindings() });
  const summary = summarizeSelfGovernance(report);

  assert.equal(summary.status, "available");
  assert.equal(summary.cadence, "weekly");
  assert.equal(summary.role_count, 4);
  assert.equal(summary.next_trigger, "下一次周度治理窗口");
  assert.equal(summary.dimensions_checked, 12);
  assert.equal(summary.auto_repair_count, 1);
  assert.equal(summary.evidence_building_count, 1);
  assert.equal(summary.user_decision_count, 1);
  assert.equal(summary.next_work_package_count, 2);
  assert.equal(summary.latest_decision_title, "建立周期性自我治理周报");
});

test("self-governance validation rejects non-object findings", () => {
  const validation = validateSelfGovernanceInput({ findings: ["bad"] });

  assert.equal(validation.status, "fail");
  assert.equal(validation.issues[0].code, "invalid_governance_finding");
});
