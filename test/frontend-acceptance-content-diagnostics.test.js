import assert from "node:assert/strict";
import test from "node:test";

import { buildArtifact } from "../tools/check-workbench-frontend-acceptance.mjs";
import { validateFrontendAcceptanceRunArtifact } from "../src/workflow/frontend-acceptance.js";
import { baseArtifact } from "./helpers/frontend-acceptance-fixtures.js";
import { viewportAudit } from "./helpers/frontend-acceptance-viewport.js";

test("frontend acceptance blocks desktop diagnostic field wall content", () => {
  const diagnosticText = Array.from({ length: 24 }, (_, index) => {
    return `run_id cycle_id artifact_id projection status scheduler_dispatch telemetry diagnostic_${index}`;
  }).join(" ");
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        bodyText: diagnosticText,
        diagnosticsCount: 30,
        contentSections: [
          {
            index: 0,
            section_key: "overview",
            heading: "状态",
            text: diagnosticText,
            text_length: diagnosticText.length,
            data_bind_count: 30,
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
  const contentResult = artifact.content_completion_results.find((result) => result.viewport === "desktop");

  assert.equal(artifact.status, "fail");
  assert.equal(contentResult.status, "fail");
  assert.equal(contentResult.source_type, "browser_dom_text");
  assert.ok(artifact.findings.some((finding) => finding.code === "frontend_content_diagnostic_wall"));
  assert.equal(validateFrontendAcceptanceRunArtifact(artifact).status, "pass");
});

test("frontend acceptance blocks realistic desktop diagnostic field walls with high actionable labels", () => {
  const diagnosticSectionText = [
    "审查通道 未配置 健康未知 下一步-- 重试策略--",
    "分片0 待处理0 下个分片-- 审查未配置 完成0",
    "下个分片-- 执行器-- 预算使用0 执行配置--",
    "分片发现0 连通正常 连通超时"
  ].join(" ");
  const bodyText = Array.from({ length: 5 }, () => diagnosticSectionText).join(" ");
  const diagnosticSection = {
    index: 0,
    section_key: "review-diagnostics",
    heading: "审查通道",
    text: diagnosticSectionText,
    text_length: diagnosticSectionText.length,
    data_bind_count: 14,
    visible: true,
    source_type: "browser_dom_text"
  };
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        bodyText,
        diagnosticsCount: 58,
        contentSections: [diagnosticSection]
      }),
      viewportAudit({
        viewport: "desktop_narrow",
        dimensions: { width: 1024, height: 768, scrollWidth: 1024, scrollHeight: 768 },
        bodyText,
        diagnosticsCount: 58,
        contentSections: [diagnosticSection]
      }),
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
  const desktopContent = artifact.content_completion_results.find((result) => result.viewport === "desktop");
  const narrowContent = artifact.content_completion_results.find((result) => result.viewport === "desktop_narrow");
  const diagnosticFindings = artifact.findings.filter((finding) => finding.code === "frontend_content_diagnostic_wall");

  assert.equal(artifact.status, "fail");
  assert.equal(desktopContent.status, "fail");
  assert.equal(narrowContent.status, "fail");
  assert.equal(desktopContent.diagnostic_field_count, 58);
  assert.equal(narrowContent.diagnostic_field_count, 58);
  assert.equal(desktopContent.diagnostic_dominated, true);
  assert.equal(narrowContent.diagnostic_dominated, true);
  assert.equal(desktopContent.content_sections[0].data_bind_count, 14);
  assert.ok(desktopContent.actionable_label_count >= 14);
  assert.ok(desktopContent.placeholder_count >= 40);
  assert.ok(desktopContent.diagnostic_wall_sections.length > 0);
  assert.equal(diagnosticFindings.length, 2);
  assert.equal(validateFrontendAcceptanceRunArtifact(artifact).status, "pass");
});

test("frontend acceptance blocks mobile long telemetry/status dump content", () => {
  const telemetryText = Array.from({ length: 80 }, (_, index) => {
    return `status projection artifact_id manifest ledger telemetry_${index}`;
  }).join(" ");
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({ viewport: "desktop" }),
      viewportAudit({ viewport: "desktop_narrow", dimensions: { width: 1024, height: 768, scrollWidth: 1024, scrollHeight: 768 } }),
      viewportAudit({
        viewport: "mobile",
        dimensions: { width: 390, height: 844, scrollWidth: 390, scrollHeight: 3200 },
        bodyText: telemetryText,
        diagnosticsCount: 6,
        contentSections: [
          {
            index: 0,
            section_key: "mobile-status",
            heading: "状态",
            text: telemetryText,
            text_length: telemetryText.length,
            data_bind_count: 6,
            visible: true,
            source_type: "browser_dom_text"
          }
        ]
      })
    ],
    navigationResults: [],
    screenshots: [],
    targetInfo: {
      acceptance_target: "latest_projection",
      acceptance_mode: "release_default_latest_projection",
      release_default: true
    }
  });
  const contentResult = artifact.content_completion_results.find((result) => result.viewport === "mobile");

  assert.equal(artifact.status, "fail");
  assert.equal(contentResult.status, "fail");
  assert.equal(contentResult.mobile_telemetry_dump, true);
  assert.ok(artifact.findings.some((finding) => finding.code === "frontend_content_mobile_telemetry_dump"));
  assert.equal(validateFrontendAcceptanceRunArtifact(artifact).status, "pass");
});

test("frontend acceptance blocks placeholder-dominated visible sections", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        bodyText: "模型 未配置 -- 0 未知 风险 未就绪 -- 0 审查 -- 未配置 0",
        contentSections: [
          {
            index: 0,
            section_key: "models",
            heading: "模型",
            text: "模型通道 -- 未配置 未知 0 --",
            text_length: 22,
            data_bind_count: 2,
            visible: true,
            source_type: "browser_dom_text"
          },
          {
            index: 1,
            section_key: "review",
            heading: "审查",
            text: "审查发现 -- 未就绪 未配置 0 --",
            text_length: 23,
            data_bind_count: 2,
            visible: true,
            source_type: "browser_dom_text"
          },
          {
            index: 2,
            section_key: "risks",
            heading: "风险",
            text: "风险 -- 未知 未配置 0 --",
            text_length: 20,
            data_bind_count: 2,
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
  const finding = artifact.findings.find((item) => item.code === "frontend_content_placeholder_section");

  assert.equal(artifact.status, "fail");
  assert.ok(finding);
  assert.equal(finding.evidence.sections.length, 3);
  assert.equal(validateFrontendAcceptanceRunArtifact(artifact).status, "pass");
});

test("frontend acceptance validation rejects missing or inconsistent content completion evidence", () => {
  const missingEvidence = validateFrontendAcceptanceRunArtifact(baseArtifact({
    content_completion_results: []
  }));
  const falsePass = validateFrontendAcceptanceRunArtifact(baseArtifact({
    content_completion_results: [
      {
        viewport: "desktop",
        source_type: "browser_dom_text",
        status: "pass",
        body_text_length: 200,
        section_count: 1,
        diagnostic_dominated: true,
        blocking_finding_codes: ["frontend_content_diagnostic_wall"],
        placeholder_dominated_sections: [],
        content_sections: [
          {
            source_type: "browser_dom_text",
            section_key: "overview",
            text_sample: "run_id cycle_id artifact_id projection status"
          }
        ]
      },
      baseArtifact().content_completion_results[1],
      baseArtifact().content_completion_results[2]
    ]
  }));

  assert.equal(missingEvidence.status, "fail");
  assert.ok(missingEvidence.issues.some((issue) => issue.code === "missing_frontend_content_completion_evidence"));
  assert.equal(falsePass.status, "fail");
  assert.ok(falsePass.issues.some((issue) => issue.code === "frontend_content_completion_false_pass"));
  assert.ok(falsePass.issues.some((issue) => issue.code === "frontend_content_completion_finding_mismatch"));
});
