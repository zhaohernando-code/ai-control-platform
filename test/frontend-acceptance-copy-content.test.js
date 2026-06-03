import assert from "node:assert/strict";
import test from "node:test";

import { buildArtifact } from "../tools/check-workbench-frontend-acceptance.mjs";
import { validateFrontendAcceptanceRunArtifact } from "../src/workflow/frontend-acceptance.js";
import { PROJECT_MANAGEMENT_TEXT } from "./helpers/frontend-acceptance-fixtures.js";
import { viewportAudit } from "./helpers/frontend-acceptance-viewport.js";

test("frontend acceptance catches live latest unbounded copy and control pileup", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        hero: {
          text: "run_context_work_packages must inspect headless_projected_action_progress and approved_mock_non_dry_run scheduler_dispatch before closeout",
          lineHeight: 24,
          fontSize: 18,
          height: 96,
          width: 480,
          top: 0
        },
        riskyTokens: ["run_context_work_packages", "approved_mock_non_dry_run", "scheduler_dispatch"],
        buttons: Array.from({ length: 9 }, (_, index) => ({ text: `Control ${index + 1}` }))
      }),
      viewportAudit({ viewport: "desktop_narrow", dimensions: { width: 1024, height: 768, scrollWidth: 1024, scrollHeight: 768 } }),
      viewportAudit({ viewport: "mobile", dimensions: { width: 390, height: 844, scrollWidth: 390, scrollHeight: 844 } })
    ],
    navigationResults: [],
    screenshots: [],
    targetInfo: {
      acceptance_target: "latest_projection",
      acceptance_mode: "release_default_latest_projection",
      release_default: true,
      projection_evidence: {
        mode: "latest",
        projection_id: "headless-live-context-cycle-1779570720000"
      }
    }
  });
  const codes = artifact.findings.map((finding) => finding.code);

  assert.equal(artifact.status, "fail");
  assert.ok(codes.includes("frontend_unbounded_dynamic_headline"));
  assert.ok(codes.includes("frontend_raw_projection_copy"));
  assert.ok(codes.includes("frontend_button_pileup"));
});

test("frontend acceptance blocks visible internal workbench copy and raw artifact ids", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        bodyText: [
          "Work Packages",
          "Context Pack -> Run -> Review -> Continuation",
          "Provider Health",
          "Smoke OK",
          "Smoke Timeout",
          "role(s)",
          "Projection",
          "Closeout",
          "Resume Health",
          "Snapshot",
          "Evidence",
          "Headless live context cycle",
          "Context pack cycle",
          "scheduler-dispatch-run-run-20260521-platform-self-trial-cycle-headless-live-1779566400000-context-pack-1779561756582-001"
        ].join(" ")
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
  const finding = artifact.findings.find((item) => item.code === "frontend_internal_workbench_copy_visible");
  const copyResult = artifact.copy_results.find((result) => result.viewport === "desktop");

  assert.equal(artifact.status, "fail");
  assert.ok(finding);
  assert.ok(finding.evidence.matches.some((match) => match.label === "Work Packages"));
  assert.ok(copyResult.internal_copy_matches.some((match) => match.label === "raw_artifact_identifier"));
  assert.ok(copyResult.internal_copy_matches.length >= 3);
});

test("frontend acceptance allows translated operator workbench copy", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        bodyText: `${PROJECT_MANAGEMENT_TEXT} 任务包 证据 审查发现 可派发 调度步数 准备上下文 执行 审查 续跑 收口验收 状态快照 续跑健康 审查通道 连通正常`
      }),
      viewportAudit({
        viewport: "desktop_narrow",
        dimensions: { width: 1024, height: 768, scrollWidth: 1024, scrollHeight: 768 },
        bodyText: `${PROJECT_MANAGEMENT_TEXT} 任务包 证据 调度执行 状态投影`
      }),
      viewportAudit({
        viewport: "mobile",
        dimensions: { width: 390, height: 844, scrollWidth: 390, scrollHeight: 844 },
        bodyText: `中台工作台 ${PROJECT_MANAGEMENT_TEXT} 状态投影 收口验收 自动调度 续跑健康 模型与审查 通道连通`
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

  assert.equal(artifact.status, "pass");
  assert.equal(artifact.copy_results[0].internal_copy_matches.length, 0);
  assert.equal(artifact.content_completion_results.every((result) => result.status === "pass"), true);
  assert.equal(validateFrontendAcceptanceRunArtifact(artifact).status, "pass");
});

test("frontend acceptance allows labeled operator status counts with next-action context", () => {
  const statusCountText = [
    PROJECT_MANAGEMENT_TEXT,
    "目标 Agent 池恢复验证",
    "完成 8 待处理 2 失败 0",
    "原因 最近一轮审查需要补充成本证据",
    "影响 不影响已通过验收的工作台发布",
    "下一步 派发成本采集任务并在收口验收前确认证据"
  ].join(" ");
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        bodyText: statusCountText,
        diagnosticsCount: 12,
        contentSections: [
          {
            index: 0,
            section_key: "operator-status",
            heading: "当前状态",
            text: statusCountText,
            text_length: statusCountText.length,
            data_bind_count: 12,
            visible: true,
            source_type: "browser_dom_text"
          }
        ]
      }),
      viewportAudit({
        viewport: "desktop_narrow",
        dimensions: { width: 1024, height: 768, scrollWidth: 1024, scrollHeight: 768 },
        bodyText: statusCountText,
        diagnosticsCount: 12,
        contentSections: [
          {
            index: 0,
            section_key: "operator-status",
            heading: "当前状态",
            text: statusCountText,
            text_length: statusCountText.length,
            data_bind_count: 12,
            visible: true,
            source_type: "browser_dom_text"
          }
        ]
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

  assert.equal(artifact.status, "pass");
  assert.equal(artifact.content_completion_results.every((result) => result.status === "pass"), true);
  assert.equal(validateFrontendAcceptanceRunArtifact(artifact).status, "pass");
});
