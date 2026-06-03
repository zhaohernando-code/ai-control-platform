import assert from "node:assert/strict";
import test from "node:test";

import { buildArtifact } from "../tools/check-workbench-frontend-acceptance.mjs";
import { validateFrontendAcceptanceRunArtifact } from "../src/workflow/frontend-acceptance.js";
import { baseArtifact, projectManagementSemanticResult } from "./helpers/frontend-acceptance-fixtures.js";
import { viewportAudit } from "./helpers/frontend-acceptance-viewport.js";

test("frontend acceptance blocks workbench pages without project-management semantics", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        nav: ["总览", "运行", "审查", "模型", "风险"].map((text) => ({ text })),
        bodyText: "运行诊断 状态投影 任务包 证据 调度执行 审查通道",
        contentSections: [
          {
            index: 0,
            section_key: "runs",
            heading: "运行诊断",
            text: "运行诊断 状态投影 任务包 证据 调度执行 审查通道",
            text_length: 36,
            data_bind_count: 0,
            visible: true,
            source_type: "browser_dom_text"
          }
        ]
      }),
      viewportAudit({ viewport: "desktop_narrow", dimensions: { width: 1024, height: 768, scrollWidth: 1024, scrollHeight: 768 } }),
      viewportAudit({ viewport: "mobile", dimensions: { width: 390, height: 844, scrollWidth: 390, scrollHeight: 844 } })
    ],
    navigationResults: [],
    screenshots: [],
    targetInfo: {
      acceptance_target: "latest_projection",
      acceptance_mode: "release_default_latest_projection",
      release_default: true
    }
  });

  assert.equal(artifact.status, "fail");
  assert.ok(artifact.findings.some((finding) => finding.code === "frontend_project_management_nav_missing"));
  assert.ok(artifact.findings.some((finding) => finding.code === "frontend_project_management_project_list_missing"));
  assert.ok(artifact.findings.some((finding) => finding.code === "frontend_project_management_task_flow_missing"));
  assert.equal(validateFrontendAcceptanceRunArtifact(artifact).status, "pass");
});

test("frontend acceptance validation rejects false-pass project-management semantics", () => {
  const validation = validateFrontendAcceptanceRunArtifact(baseArtifact({
    project_management_semantic_results: [
      projectManagementSemanticResult("desktop", {
        status: "pass",
        has_platform_project: false,
        has_task_lifecycle: false,
        has_requirement_intake: false,
        blocking_finding_codes: ["frontend_project_management_project_list_missing"]
      }),
      projectManagementSemanticResult("desktop_narrow"),
      projectManagementSemanticResult("mobile")
    ]
  }));

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "project_management_platform_project_missing"));
  assert.ok(validation.issues.some((issue) => issue.code === "project_management_task_lifecycle_missing"));
  assert.ok(validation.issues.some((issue) => issue.code === "project_management_requirement_intake_missing"));
  assert.ok(validation.issues.some((issue) => issue.code === "project_management_semantic_finding_mismatch"));
});

test("frontend acceptance validation blocks legacy desktop diagnostic false pass artifacts", () => {
  const diagnosticSectionText = [
    "审查通道 未配置 健康未知 下一步-- 重试策略--",
    "分片0 待处理0 下个分片-- 审查未配置 完成0",
    "下个分片-- 执行器-- 预算使用0 执行配置--",
    "分片发现0 连通正常 连通超时"
  ].join(" ");
  const legacyPassResult = (viewport) => ({
    viewport,
    source_type: "browser_dom_text",
    status: "pass",
    body_text_length: 1900,
    body_text_sample: diagnosticSectionText,
    section_count: 1,
    diagnostic_field_count: 58,
    placeholder_count: 45,
    telemetry_token_count: 0,
    actionable_label_count: 40,
    next_step_context_count: 18,
    diagnostic_dominated: false,
    mobile_telemetry_dump: false,
    placeholder_dominated_sections: [],
    blocking_finding_codes: [],
    content_sections: [
      {
        index: 0,
        section_key: "review-diagnostics",
        heading: "审查通道",
        text_sample: diagnosticSectionText,
        text_length: diagnosticSectionText.length,
        data_bind_count: 14,
        placeholder_count: 9,
        unresolved_placeholder_count: 9,
        telemetry_token_count: 0,
        actionable_label_count: 12,
        next_step_context_count: 5,
        placeholder_ratio: 0.346,
        source_type: "browser_dom_text"
      }
    ]
  });
  const validation = validateFrontendAcceptanceRunArtifact(baseArtifact({
    content_completion_results: [
      legacyPassResult("desktop"),
      legacyPassResult("desktop_narrow"),
      baseArtifact().content_completion_results[2]
    ]
  }));

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "frontend_content_completion_false_pass"));
  assert.ok(validation.issues.some((issue) => issue.code === "frontend_content_completion_missing_finding_codes"));
});
