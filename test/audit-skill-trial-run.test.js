import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  AUDIT_SKILL_DIMENSIONS,
  AUDIT_SKILL_TRIAL_RUN_VERSION,
  DEFAULT_AUDIT_PROJECT_ROOT,
  evaluateAuditSkillTrialRun
} from "../src/workflow/audit-skill-trial-run.js";

function evidence(id, overrides = {}) {
  return {
    id,
    kind: "code",
    source: "src/workflow/self-governance.js",
    collected_at: "2026-05-25T00:00:00.000Z",
    collector: "audit-skill-trial",
    command_or_path: "src/workflow/self-governance.js:1",
    result_summary: "当前代码级审计证据",
    ...overrides
  };
}

function dimension(id, evidenceId = `${id}-evidence`) {
  return {
    id,
    status: "audited",
    skill_name: `${id.replaceAll("_", "-")}-audit`,
    skill_version_or_path: `/Users/hernando_zhao/.codex/skills/${id.replaceAll("_", "-")}-audit/SKILL.md`,
    prompt_scope: "real ai-control-platform code and tests",
    input_artifacts: ["src/workflow/self-governance.js"],
    output_artifact: `tmp/audit-skill-trial/${id}.json`,
    evidence_ids: [evidenceId]
  };
}

function validArtifact(overrides = {}) {
  const evidenceItems = [
    ...AUDIT_SKILL_DIMENSIONS.map((id) => evidence(`${id}-evidence`)),
    evidence("current-closeout-evidence", {
      kind: "command",
      source: "npm run check:closeout",
      command_or_path: "npm run check:closeout",
      exit_code: 0,
      result_summary: "当前 closeout 门禁通过"
    })
  ];
  return {
    version: AUDIT_SKILL_TRIAL_RUN_VERSION,
    project_root: DEFAULT_AUDIT_PROJECT_ROOT,
    input_mode: "real_project_state",
    scope: "current ai-control-platform self-governance flow",
    created_at: "2026-05-25T00:00:00.000Z",
    final_verdict: "带条件通过",
    dimensions: AUDIT_SKILL_DIMENSIONS.map((id) => dimension(id)),
    evidence: evidenceItems,
    findings: [
      {
        id: "self-governance-evidence-gate",
        dimension: "quality_gate",
        type: "明确缺陷",
        severity: "中",
        disposition: "立即修复",
        evidence_ids: ["quality_gate-evidence"],
        repair_schedule: {
          scope: "self-governance audit evidence gate",
          target_files_or_modules: ["src/workflow/audit-skill-trial-run.js"],
          owner_role: "platform_core",
          verification_commands: ["node --test test/audit-skill-trial-run.test.js"],
          post_repair_evidence_required: "audit-skill-trial-run.v1 passes",
          rollback_risk: "low"
        }
      },
      {
        id: "live-route-proof-gap",
        dimension: "user_experience",
        type: "证据缺口",
        severity: "中",
        disposition: "继续取证",
        evidence_ids: ["user_experience-evidence"],
        evidence_plan: {
          missing_evidence: "public browser evidence",
          how_to_collect: "run workbench live route probe",
          blocking_closure: false,
          minimum_command_or_entrypoint: "npm run probe:workbench:live-route"
        }
      },
      {
        id: "weekly-audit-cadence",
        dimension: "iteration_evolution",
        type: "可选迭代",
        severity: "低",
        disposition: "用户决策",
        evidence_ids: ["iteration_evolution-evidence"],
        decision_package: {
          options: ["每周深度审计", "发布后审计"],
          tradeoffs: "每周覆盖更全，发布后成本更低",
          recommended_option: "每周深度审计",
          estimated_cost: "中",
          confidence_gain: "高"
        }
      }
    ],
    coverage_summary: {
      required_dimensions_count: AUDIT_SKILL_DIMENSIONS.length,
      covered_dimensions_count: AUDIT_SKILL_DIMENSIONS.length,
      justified_not_applicable_count: 0,
      findings_without_evidence_count: 0,
      defects_without_repair_schedule_count: 0,
      optional_without_decision_package_count: 0
    },
    ...overrides
  };
}

test("audit skill trial run passes only with full real-project coverage and structured findings", () => {
  const result = evaluateAuditSkillTrialRun(validArtifact());

  assert.equal(result.status, "pass");
  assert.equal(result.required_dimensions_count, AUDIT_SKILL_DIMENSIONS.length);
  assert.equal(result.covered_dimensions_count, AUDIT_SKILL_DIMENSIONS.length);
  assert.equal(result.finding_count, 3);
  assert.equal(result.issues.length, 0);
});

test("audit skill trial run rejects sample input and missing dimensions", () => {
  const artifact = validArtifact({
    input_mode: "sample",
    dimensions: validArtifact().dimensions.slice(1),
    coverage_summary: {
      required_dimensions_count: AUDIT_SKILL_DIMENSIONS.length,
      covered_dimensions_count: AUDIT_SKILL_DIMENSIONS.length - 1,
      justified_not_applicable_count: 0,
      findings_without_evidence_count: 0,
      defects_without_repair_schedule_count: 0,
      optional_without_decision_package_count: 0
    }
  });
  const result = evaluateAuditSkillTrialRun(artifact);

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "invalid_audit_input_mode"));
  assert.ok(result.issues.some((issue) => issue.code === "sample_input_forbidden"));
  assert.ok(result.issues.some((issue) => issue.code === "missing_required_dimension"));
});

test("audit skill trial run rejects findings without repair, evidence, or decision packages", () => {
  const artifact = validArtifact({
    findings: [
      {
        id: "missing-repair",
        dimension: "quality_gate",
        type: "明确缺陷",
        severity: "高",
        disposition: "立即修复",
        evidence_ids: ["quality_gate-evidence"]
      },
      {
        id: "missing-evidence-plan",
        dimension: "user_experience",
        type: "证据缺口",
        severity: "中",
        disposition: "继续取证",
        evidence_ids: ["user_experience-evidence"]
      },
      {
        id: "missing-decision-package",
        dimension: "iteration_evolution",
        type: "可选迭代",
        severity: "低",
        disposition: "立即修复",
        evidence_ids: ["iteration_evolution-evidence"]
      }
    ],
    final_verdict: "通过"
  });
  const result = evaluateAuditSkillTrialRun(artifact);

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "missing_repair_schedule"));
  assert.ok(result.issues.some((issue) => issue.code === "missing_evidence_plan"));
  assert.ok(result.issues.some((issue) => issue.code === "missing_decision_package"));
  assert.ok(result.issues.some((issue) => issue.code === "high_defect_requires_fail_verdict"));
});

test("audit skill trial run rejects summary-only evidence", () => {
  const artifact = validArtifact({
    evidence: [
      evidence("quality_gate-evidence", {
        kind: "file",
        source: "PROJECT_STATUS.json",
        command_or_path: "PROJECT_STATUS.json",
        line: "1",
        result_summary: "状态总结"
      }),
      evidence("current-closeout-evidence", {
        kind: "command",
        source: "npm run check:closeout",
        command_or_path: "npm run check:closeout",
        exit_code: 0,
        result_summary: "当前 closeout 门禁通过"
      })
    ],
    dimensions: AUDIT_SKILL_DIMENSIONS.map((id) => dimension(id, "quality_gate-evidence")),
    findings: [],
    coverage_summary: {
      required_dimensions_count: AUDIT_SKILL_DIMENSIONS.length,
      covered_dimensions_count: AUDIT_SKILL_DIMENSIONS.length,
      justified_not_applicable_count: 0,
      findings_without_evidence_count: 0,
      defects_without_repair_schedule_count: 0,
      optional_without_decision_package_count: 0
    }
  });
  const result = evaluateAuditSkillTrialRun(artifact);

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "dimension_summary_only_evidence"));
});

test("audit skill trial run requires current closeout evidence", () => {
  const artifact = validArtifact({
    evidence: AUDIT_SKILL_DIMENSIONS.map((id) => evidence(`${id}-evidence`))
  });
  const result = evaluateAuditSkillTrialRun(artifact);

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "missing_current_closeout_evidence"));
});

test("audit skill trial CLI fails closed for invalid artifacts", () => {
  const dir = mkdtempSync(join(tmpdir(), "audit-skill-trial-"));
  const validPath = join(dir, "valid.json");
  const invalidPath = join(dir, "invalid.json");
  writeFileSync(validPath, `${JSON.stringify(validArtifact(), null, 2)}\n`);
  writeFileSync(invalidPath, `${JSON.stringify(validArtifact({ project_root: "/tmp/wrong" }), null, 2)}\n`);

  const valid = spawnSync(process.execPath, ["tools/check-audit-skill-trial-run.mjs", validPath], {
    encoding: "utf8"
  });
  const invalid = spawnSync(process.execPath, ["tools/check-audit-skill-trial-run.mjs", invalidPath], {
    encoding: "utf8"
  });

  assert.equal(valid.status, 0);
  assert.match(valid.stdout, /"status": "pass"/);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stdout, /audit_project_root_mismatch/);
});
