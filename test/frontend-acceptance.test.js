import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  buildArtifact,
  parseAcceptanceOptions
} from "../tools/check-workbench-frontend-acceptance.mjs";
import {
  decideContinuation,
  CONTINUE
} from "../src/workflow/autonomous-continuation.js";
import {
  createFrontendAcceptanceDurableEvidence,
  createFrontendAcceptanceRepairWorkPackage,
  FRONTEND_ACCEPTANCE_RUN_VERSION,
  FRONTEND_ACCEPTANCE_REPAIR_ACTION,
  recordFrontendAcceptanceRunArtifact,
  summarizeFrontendAcceptance,
  validateFrontendAcceptanceRunArtifact
} from "../src/workflow/frontend-acceptance.js";
import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

const PROJECT_MANAGEMENT_TEXT = [
  "新建任务",
  "提交",
  "项目列表",
  "AI Control Platform",
  "ai-control-platform",
  "阶段",
  "当前任务",
  "Agent",
  "进度",
  "更新",
  "任务流",
  "需求",
  "拆解",
  "子任务",
  "Review",
  "发布",
  "Live 验证",
  "验收"
].join(" ");

function projectManagementSemanticResult(viewport, overrides = {}) {
  return {
    viewport,
    status: "pass",
    source_type: "browser_dom_product_semantics",
    has_required_nav: true,
    has_project_list: true,
    has_platform_project: true,
    has_project_fields: true,
    has_task_lifecycle: true,
    has_requirement_intake: true,
    diagnostics_primary: false,
    required_nav: viewport === "mobile" ? [] : ["总览", "项目", "任务流", "Agents", "风险", "治理"],
    required_lifecycle: ["需求", "拆解", "子任务", "Review", "发布", "Live 验证", "验收"],
    text_sample: PROJECT_MANAGEMENT_TEXT,
    blocking_finding_codes: [],
    ...overrides
  };
}

function baseArtifact(overrides = {}) {
  return {
    version: FRONTEND_ACCEPTANCE_RUN_VERSION,
    status: "pass",
    created_at: "2026-05-24T00:00:00.000Z",
    screenshots: [],
    acceptance_target: "latest_projection",
    acceptance_mode: "release_default_latest_projection",
    release_default: true,
    projection_evidence: {
      mode: "latest",
      source: "workbench_projection_history",
      projection_id: "headless-live-context-cycle-1779570720000",
      history_path: "docs/examples/projection-history.json",
      input_path: "docs/examples/headless-live-context-cycle-1779570720000.workbench-input.json"
    },
    viewport_results: [
      { viewport: "desktop", route_path: "/projects/ai-control-platform/apps/workbench/desktop.html", mounted_workbench_route: true, mounted_safe_favicon_count: 1, dimensions: { width: 1440, scrollWidth: 1440 } },
      { viewport: "desktop_narrow", route_path: "/projects/ai-control-platform/apps/workbench/desktop.html", mounted_workbench_route: true, mounted_safe_favicon_count: 1, dimensions: { width: 1024, scrollWidth: 1024 } },
      { viewport: "mobile", route_path: "/projects/ai-control-platform/apps/workbench/mobile.html", mounted_workbench_route: true, mounted_safe_favicon_count: 1, dimensions: { width: 390, scrollWidth: 390 } }
    ],
    navigation_results: [],
    layout_results: [
      {
        viewport: "desktop",
        dimensions: { width: 1440, scrollWidth: 1440 },
        overlap_count: 0,
        visible_section_count: 1,
        visible_command_count: 0,
        command_density: 0,
        dense_command_layout: false,
        source_type: "browser_dom_layout"
      },
      {
        viewport: "desktop_narrow",
        dimensions: { width: 1024, scrollWidth: 1024 },
        overlap_count: 0,
        visible_section_count: 1,
        visible_command_count: 0,
        command_density: 0,
        dense_command_layout: false,
        source_type: "browser_dom_layout"
      },
      {
        viewport: "mobile",
        dimensions: { width: 390, scrollWidth: 390 },
        overlap_count: 0,
        visible_section_count: 1,
        visible_command_count: 0,
        command_density: 0,
        dense_command_layout: false,
        source_type: "browser_dom_layout"
      }
    ],
    copy_results: [],
    content_completion_results: [
      {
        viewport: "desktop",
        source_type: "browser_dom_text",
        status: "pass",
        body_text_length: 80,
        body_text_sample: "当前目标 下一步处理 阻塞风险 证据验收",
        section_count: 1,
        diagnostic_field_count: 0,
        placeholder_count: 0,
        telemetry_token_count: 0,
        actionable_label_count: 4,
        next_step_context_count: 2,
        diagnostic_dominated: false,
        mobile_telemetry_dump: false,
        placeholder_dominated_sections: [],
        blocking_finding_codes: [],
        content_sections: [
          {
            index: 0,
            section_key: "overview",
            heading: "当前目标",
            text_sample: "当前目标 下一步处理 阻塞风险 证据验收",
            text_length: 80,
            data_bind_count: 0,
            placeholder_count: 0,
            telemetry_token_count: 0,
            actionable_label_count: 4,
            next_step_context_count: 2,
            placeholder_ratio: 0,
            source_type: "browser_dom_text"
          }
        ]
      },
      {
        viewport: "desktop_narrow",
        source_type: "browser_dom_text",
        status: "pass",
        body_text_length: 80,
        body_text_sample: "当前目标 下一步处理 阻塞风险 证据验收",
        section_count: 1,
        diagnostic_field_count: 0,
        placeholder_count: 0,
        telemetry_token_count: 0,
        actionable_label_count: 4,
        next_step_context_count: 2,
        diagnostic_dominated: false,
        mobile_telemetry_dump: false,
        placeholder_dominated_sections: [],
        blocking_finding_codes: [],
        content_sections: [
          {
            index: 0,
            section_key: "overview",
            heading: "当前目标",
            text_sample: "当前目标 下一步处理 阻塞风险 证据验收",
            text_length: 80,
            data_bind_count: 0,
            placeholder_count: 0,
            telemetry_token_count: 0,
            actionable_label_count: 4,
            next_step_context_count: 2,
            placeholder_ratio: 0,
            source_type: "browser_dom_text"
          }
        ]
      },
      {
        viewport: "mobile",
        source_type: "browser_dom_text",
        status: "pass",
        body_text_length: 80,
        body_text_sample: "当前目标 下一步处理 阻塞风险 证据验收",
        section_count: 1,
        diagnostic_field_count: 0,
        placeholder_count: 0,
        telemetry_token_count: 0,
        actionable_label_count: 4,
        next_step_context_count: 2,
        diagnostic_dominated: false,
        mobile_telemetry_dump: false,
        placeholder_dominated_sections: [],
        blocking_finding_codes: [],
        content_sections: [
          {
            index: 0,
            section_key: "overview",
            heading: "当前目标",
            text_sample: "当前目标 下一步处理 阻塞风险 证据验收",
            text_length: 80,
            data_bind_count: 0,
            placeholder_count: 0,
            telemetry_token_count: 0,
            actionable_label_count: 4,
            next_step_context_count: 2,
            placeholder_ratio: 0,
            source_type: "browser_dom_text"
          }
        ]
      }
    ],
    project_management_semantic_results: [
      projectManagementSemanticResult("desktop"),
      projectManagementSemanticResult("desktop_narrow"),
      projectManagementSemanticResult("mobile")
    ],
    resource_results: [
      { viewport: "desktop", route_path: "/projects/ai-control-platform/apps/workbench/desktop.html", mounted_workbench_route: true, favicon_link_count: 1, mounted_safe_favicon_count: 1, root_favicon_count: 0, mounted_svg_favicon_mime: "image/svg+xml", mounted_svg_favicon_mime_ok: true },
      { viewport: "desktop_narrow", route_path: "/projects/ai-control-platform/apps/workbench/desktop.html", mounted_workbench_route: true, favicon_link_count: 1, mounted_safe_favicon_count: 1, root_favicon_count: 0, mounted_svg_favicon_mime: "image/svg+xml", mounted_svg_favicon_mime_ok: true },
      { viewport: "mobile", route_path: "/projects/ai-control-platform/apps/workbench/mobile.html", mounted_workbench_route: true, favicon_link_count: 1, mounted_safe_favicon_count: 1, root_favicon_count: 0, mounted_svg_favicon_mime: "image/svg+xml", mounted_svg_favicon_mime_ok: true }
    ],
    control_results: [
      {
        viewport: "desktop",
        button_count: 0,
        control_count: 0,
        native_button_count: 0,
        role_button_count: 0,
        data_command_count: 0,
        buttons: [],
        controls: [],
        command_architecture: {
          viewport: "desktop",
          source_type: "browser_dom_controls",
          status: "pass",
          control_count: 0,
          primary_control_count: 0,
          advanced_control_count: 0,
          risky_control_count: 0,
          risky_primary_control_count: 0,
          ungrouped_risky_control_count: 0,
          repeated_actions: [],
          overloaded_sections: [],
          blocking_finding_codes: [],
          controls: []
        }
      },
      {
        viewport: "desktop_narrow",
        button_count: 0,
        control_count: 0,
        native_button_count: 0,
        role_button_count: 0,
        data_command_count: 0,
        buttons: [],
        controls: [],
        command_architecture: {
          viewport: "desktop_narrow",
          source_type: "browser_dom_controls",
          status: "pass",
          control_count: 0,
          primary_control_count: 0,
          advanced_control_count: 0,
          risky_control_count: 0,
          risky_primary_control_count: 0,
          ungrouped_risky_control_count: 0,
          repeated_actions: [],
          overloaded_sections: [],
          blocking_finding_codes: [],
          controls: []
        }
      },
      {
        viewport: "mobile",
        button_count: 0,
        control_count: 0,
        native_button_count: 0,
        role_button_count: 0,
        data_command_count: 0,
        buttons: [],
        controls: [],
        command_architecture: {
          viewport: "mobile",
          source_type: "browser_dom_controls",
          status: "pass",
          control_count: 0,
          primary_control_count: 0,
          advanced_control_count: 0,
          risky_control_count: 0,
          risky_primary_control_count: 0,
          ungrouped_risky_control_count: 0,
          repeated_actions: [],
          overloaded_sections: [],
          blocking_finding_codes: [],
          controls: []
        }
      }
    ],
    mobile_results: [],
    findings: [],
    blocking_count: 0,
    blocking_findings: [],
    ...overrides
  };
}

function viewportAudit(overrides = {}) {
  const viewport = overrides.viewport || "desktop";
  const shell = viewport === "mobile" ? "mobile.html" : "desktop.html";
  const nav = viewport === "mobile"
    ? []
    : ["总览", "项目", "任务流", "Agents", "风险", "治理", "运行诊断"].map((text) => ({ text }));
  return {
    viewport,
    routePath: `/projects/ai-control-platform/apps/workbench/${shell}`,
    mounted: true,
    dimensions: { width: 1440, height: 900, scrollWidth: 1440, scrollHeight: 900 },
    nav,
    buttons: [],
    faviconLinks: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href_attribute: "./favicon.svg",
        href: "http://127.0.0.1:4180/projects/ai-control-platform/apps/workbench/favicon.svg"
      }
    ],
    mountedSvgFaviconResponses: [
      {
        url: "http://127.0.0.1:4180/projects/ai-control-platform/apps/workbench/favicon.svg",
        status: 200,
        content_type: "image/svg+xml"
      }
    ],
    browserErrors: [],
    riskyTokens: [],
    bodyText: `中台工作台 ${PROJECT_MANAGEMENT_TEXT} 状态投影 任务包 证据 调度执行 收口验收 续跑健康 审查通道`,
    contentSections: [
      {
        index: 0,
        section_key: viewport === "mobile" ? "mobile-priority" : "overview",
        heading: viewport === "mobile" ? "项目列表" : "项目总览",
        text: `${PROJECT_MANAGEMENT_TEXT} 当前任务 下一步处理 阻塞风险 证据验收 任务派发 审查恢复`,
        text_length: PROJECT_MANAGEMENT_TEXT.length + 42,
        data_bind_count: 0,
        visible: true,
        source_type: "browser_dom_text"
      }
    ],
    diagnosticsCount: 0,
    hero: {
      text: "AI Control Platform",
      lineHeight: 32,
      fontSize: 24,
      height: 32,
      width: 500,
      top: 0
    },
    overlapPairs: [],
    ...overrides
  };
}

function baseWorkflowState() {
  return {
    manifest: {
      run_id: "run-frontend",
      cycle_id: "cycle-frontend",
      goal: "frontend acceptance gate",
      status: "pass",
      work_packages: [],
      events: [],
      artifacts: []
    },
    artifact_ledger: {
      run_id: "run-frontend",
      cycle_id: "cycle-frontend",
      artifacts: []
    }
  };
}

test("frontend acceptance artifact fails closed on blocking findings", () => {
  const artifact = baseArtifact({
    status: "pass",
    findings: [
      {
        code: "frontend_dead_navigation",
        severity: "p1",
        status: "fail",
        message: "运行 tab cannot be clicked"
      }
    ],
    blocking_count: 1
  });
  const validation = validateFrontendAcceptanceRunArtifact(artifact);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "frontend_acceptance_false_pass"));
});

test("frontend acceptance artifact requires desktop and mobile viewport evidence", () => {
  const validation = validateFrontendAcceptanceRunArtifact(baseArtifact({
    viewport_results: [{ viewport: "desktop" }]
  }));

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_frontend_acceptance_viewport" && issue.path === "viewport_results"));
});

test("frontend acceptance requires mounted route and explicit workbench favicon readiness", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        mounted: false,
        routePath: "/apps/workbench/desktop.html",
        faviconLinks: []
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
  const codes = artifact.findings.map((finding) => finding.code);
  const validation = validateFrontendAcceptanceRunArtifact(artifact);

  assert.equal(artifact.status, "fail");
  assert.ok(codes.includes("frontend_non_mounted_workbench_route"));
  assert.ok(codes.includes("frontend_missing_favicon_link"));
  assert.equal(artifact.resource_results.find((result) => result.viewport === "desktop").mounted_safe_favicon_count, 0);
  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_mounted_workbench_route"));
  assert.ok(validation.issues.some((issue) => issue.code === "missing_frontend_favicon_readiness"));
});

test("frontend acceptance blocks root favicon fallback links", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        faviconLinks: [
          {
            rel: "icon",
            type: "image/x-icon",
            href_attribute: "/favicon.ico",
            href: "http://127.0.0.1:4180/favicon.ico"
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
  const validation = validateFrontendAcceptanceRunArtifact(artifact);

  assert.equal(artifact.status, "fail");
  assert.ok(artifact.findings.some((finding) => finding.code === "frontend_root_favicon_fallback"));
  assert.ok(artifact.findings.some((finding) => finding.code === "frontend_favicon_not_mounted_safe"));
  assert.ok(validation.issues.some((issue) => issue.code === "root_favicon_fallback_not_allowed"));
});

test("frontend acceptance requires mounted SVG favicon MIME evidence", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        mountedSvgFaviconResponses: [
          {
            url: "http://127.0.0.1:4180/projects/ai-control-platform/apps/workbench/favicon.svg",
            status: 200,
            content_type: "application/octet-stream"
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
  const desktopResources = artifact.resource_results.find((result) => result.viewport === "desktop");
  const validation = validateFrontendAcceptanceRunArtifact(artifact);

  assert.equal(artifact.status, "fail");
  assert.equal(desktopResources.mounted_svg_favicon_mime, "application/octet-stream");
  assert.equal(desktopResources.mounted_svg_favicon_mime_ok, false);
  assert.ok(artifact.findings.some((finding) => finding.code === "frontend_mounted_svg_favicon_mime_drift"));
  assert.ok(validation.issues.some((issue) => issue.code === "mounted_svg_favicon_mime_required"));
  assert.ok(validation.issues.some((issue) => issue.code === "mounted_svg_favicon_mime_drift"));
});

test("frontend acceptance run records durable workflow facts and projection summary", () => {
  const workflowState = baseWorkflowState();
  const artifact = baseArtifact();
  const recorded = recordFrontendAcceptanceRunArtifact(workflowState, artifact);

  assert.equal(recorded.status, "pass");
  assert.equal(recorded.workflow_state.manifest.events.at(-1).type, "frontend_acceptance_run");
  assert.equal(recorded.workflow_state.artifact_ledger.artifacts.at(-1).metadata.version, FRONTEND_ACCEPTANCE_RUN_VERSION);

  const summary = summarizeFrontendAcceptance(recorded.workflow_state.manifest, recorded.workflow_state.artifact_ledger);
  assert.equal(summary.status, "pass");
  assert.equal(summary.blocking_count, 0);

  const projection = createWorkbenchProjection(recorded.workflow_state);
  assert.equal(projection.frontend_acceptance.status, "pass");
  assert.equal(projection.one_screen.counters.frontend_acceptance_blockers, 0);
});

test("release frontend acceptance fails closed without durable workflow and projection evidence", () => {
  const validation = validateFrontendAcceptanceRunArtifact(baseArtifact(), {
    requireDurableReleaseEvidence: true
  });

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "missing_frontend_acceptance_durable_evidence"));
});

test("release frontend acceptance accepts recordFrontendAcceptanceRunArtifact durable projection evidence", () => {
  const workflowState = baseWorkflowState();
  const artifact = baseArtifact();
  const recorded = recordFrontendAcceptanceRunArtifact(workflowState, artifact, {
    artifact_id: "frontend-acceptance-release"
  });
  const projection = createWorkbenchProjection(recorded.workflow_state);
  const releaseArtifact = {
    ...artifact,
    durable_evidence: createFrontendAcceptanceDurableEvidence(recorded, projection)
  };
  const validation = validateFrontendAcceptanceRunArtifact(releaseArtifact, {
    requireDurableReleaseEvidence: true
  });

  assert.equal(validation.status, "pass");
  assert.equal(releaseArtifact.durable_evidence.workflow_state.manifest.events.at(-1).type, "frontend_acceptance_run");
  assert.equal(releaseArtifact.durable_evidence.projection.frontend_acceptance.status, "pass");
  assert.equal(releaseArtifact.durable_evidence.projection.one_screen.counters.frontend_acceptance_blockers, 0);
});

test("frontend acceptance CLI defaults to release latest projection mode", () => {
  assert.deepEqual(parseAcceptanceOptions([]), {
    target: "latest",
    outputPath: null,
    screenshotDir: null,
    expectPass: true
  });
  assert.equal(parseAcceptanceOptions(["--allow-fail", "--target", "latest"]).target, "latest");
  assert.equal(parseAcceptanceOptions(["--target", "fixture"]).target, "fixture");
  assert.equal(parseAcceptanceOptions(["--fixture"]).target, "fixture");
  assert.equal(parseAcceptanceOptions(["--current-session"]).target, "fixture");
});

test("frontend acceptance artifact identifies latest projection evidence", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({ viewport: "desktop" }),
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
        source: "workbench_projection_history",
        projection_id: "headless-live-context-cycle-1779570720000",
        history_path: "docs/examples/projection-history.json"
      }
    }
  });

  assert.equal(artifact.acceptance_target, "latest_projection");
  assert.equal(artifact.acceptance_mode, "release_default_latest_projection");
  assert.equal(artifact.release_default, true);
  assert.equal(artifact.projection_evidence.projection_id, "headless-live-context-cycle-1779570720000");
  assert.equal(validateFrontendAcceptanceRunArtifact(artifact).status, "pass");
});

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

test("frontend acceptance counts and blocks semantic command controls", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        buttons: [
          {
            text: "Run context work packages",
            action: "run_context_work_packages",
            action_attribute: "data-workbench-next-action",
            tag: "span",
            role: "button",
            command: "role_button"
          },
          {
            text: "批准 mock non-dry-run dispatch",
            action: "approved_mock_non_dry_run",
            action_attribute: "data-scheduler-dispatch",
            tag: "span",
            role: "button",
            command: "role_button"
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
  const controlResult = artifact.control_results.find((result) => result.viewport === "desktop");
  const dangerFinding = artifact.findings.find((finding) => finding.code === "frontend_danger_controls_unscoped");

  assert.equal(artifact.status, "fail");
  assert.equal(controlResult.control_count, 2);
  assert.equal(controlResult.role_button_count, 2);
  assert.equal(controlResult.native_button_count, 0);
  assert.ok(dangerFinding);
  assert.equal(dangerFinding.evidence.buttons[0].role, "button");
  assert.equal(dangerFinding.evidence.buttons[0].action, "run_context_work_packages");
});

test("frontend acceptance blocks overloaded command information architecture", () => {
  const overloadedButtons = [
    {
      text: "调度预检",
      action: "dry-run",
      action_attribute: "data-scheduler-dispatch",
      tag: "button",
      command: "native_button",
      scope: "primary_actions",
      section_key: "overview"
    },
    {
      text: "执行推荐动作",
      action: "guarded",
      action_attribute: "data-workbench-next-action",
      tag: "button",
      command: "native_button",
      scope: "primary_actions",
      section_key: "overview"
    },
    {
      text: "运行调度轮次",
      action: "bounded",
      action_attribute: "data-autonomous-scheduler-loop",
      tag: "button",
      command: "native_button",
      scope: "primary_actions",
      section_key: "overview"
    },
    {
      text: "按投影受控审查",
      action: "projected-real",
      action_attribute: "data-autonomous-scheduler-loop",
      tag: "button",
      command: "native_button",
      scope: "primary_actions",
      section_key: "overview"
    },
    ...Array.from({ length: 5 }, (_, index) => ({
      text: `高级动作 ${index + 1}`,
      action: `advanced-${index + 1}`,
      action_attribute: "data-scheduler-dispatch",
      tag: "button",
      command: "native_button",
      scope: "advanced_drawer",
      section_key: "overview"
    }))
  ];
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        buttons: overloadedButtons
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
  const controlResult = artifact.control_results.find((result) => result.viewport === "desktop");
  const architecture = controlResult.command_architecture;
  const layoutResult = artifact.layout_results.find((result) => result.viewport === "desktop");
  const codes = artifact.findings.map((finding) => finding.code);
  const validation = validateFrontendAcceptanceRunArtifact(artifact);

  assert.equal(artifact.status, "fail");
  assert.equal(architecture.status, "fail");
  assert.equal(architecture.control_count, 9);
  assert.equal(architecture.primary_control_count, 4);
  assert.equal(architecture.risky_primary_control_count, 3);
  assert.equal(layoutResult.dense_command_layout, true);
  assert.ok(codes.includes("frontend_command_control_overload"));
  assert.ok(codes.includes("frontend_primary_action_overload"));
  assert.ok(codes.includes("frontend_primary_risky_action_overload"));
  assert.ok(codes.includes("frontend_action_cluster_overload"));
  assert.equal(validation.status, "pass");
});

test("frontend acceptance validation rejects command architecture false pass artifacts", () => {
  const legacyArtifact = baseArtifact({
    layout_results: [
      {
        viewport: "desktop",
        dimensions: { width: 1440, scrollWidth: 1440 },
        overlap_count: 0,
        visible_section_count: 1,
        visible_command_count: 9,
        command_density: 9,
        dense_command_layout: true,
        source_type: "browser_dom_layout"
      },
      baseArtifact().layout_results[1],
      baseArtifact().layout_results[2]
    ],
    control_results: [
      {
        viewport: "desktop",
        button_count: 9,
        control_count: 9,
        native_button_count: 9,
        role_button_count: 0,
        data_command_count: 0,
        buttons: Array.from({ length: 9 }, (_, index) => `动作 ${index + 1}`),
        controls: [],
        command_architecture: {
          viewport: "desktop",
          source_type: "browser_dom_controls",
          status: "pass",
          control_count: 9,
          primary_control_count: 4,
          advanced_control_count: 5,
          risky_control_count: 4,
          risky_primary_control_count: 4,
          ungrouped_risky_control_count: 0,
          repeated_actions: [],
          overloaded_sections: [{ section_key: "overview", count: 9 }],
          blocking_finding_codes: [],
          controls: []
        }
      },
      baseArtifact().control_results[1],
      baseArtifact().control_results[2]
    ]
  });
  const validation = validateFrontendAcceptanceRunArtifact(legacyArtifact);

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "frontend_control_overload_missing_architecture_finding"));
  assert.ok(validation.issues.some((issue) => issue.code === "frontend_control_architecture_false_pass"));
  assert.ok(validation.issues.some((issue) => issue.code === "frontend_control_architecture_missing_finding_codes"));
  assert.ok(validation.issues.some((issue) => issue.code === "frontend_dense_command_layout_missing_finding"));
});

test("frontend acceptance records and blocks browser console or page errors", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        browserErrors: [
          {
            source: "response",
            type: "http_error",
            status: 404,
            url: "http://127.0.0.1:9999/favicon.ico"
          },
          {
            source: "console",
            type: "error",
            text: "Failed to load resource: the server responded with a status of 404 (Not Found)"
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
  const viewportResult = artifact.viewport_results.find((result) => result.viewport === "desktop");
  const browserErrorResult = artifact.browser_error_results.find((result) => result.viewport === "desktop");
  const consoleFinding = artifact.findings.find((finding) => finding.code === "frontend_browser_console_error");

  assert.equal(artifact.status, "fail");
  assert.equal(viewportResult.browser_error_count, 2);
  assert.equal(viewportResult.blocked_browser_error_count, 2);
  assert.equal(browserErrorResult.blocked_error_count, 2);
  assert.ok(consoleFinding);
  assert.equal(consoleFinding.evidence.viewport, "desktop");
  assert.match(consoleFinding.evidence.errors[0].url, /favicon\.ico/);
});

test("frontend acceptance rejects active-class-only navigation", () => {
  const navigationResults = [
    {
      label: "运行",
      before: {
        active: "总览",
        scrollTop: 0,
        mainText: "same visible workbench content",
        visibleSections: [{ section: "overview", text: "same visible workbench content" }],
        focusedSection: null
      },
      after: {
        active: "运行",
        scrollTop: 0,
        mainText: "same visible workbench content",
        visibleSections: [{ section: "overview", text: "same visible workbench content" }],
        focusedSection: null
      },
      active_changed: true,
      scroll_changed: false,
      visible_text_changed: false,
      visible_sections_changed: false,
      focused_section_changed: false,
      semantic_changed: false,
      active_only: true,
      changed: true
    }
  ];
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({ viewport: "desktop" }),
      viewportAudit({ viewport: "desktop_narrow", dimensions: { width: 1024, height: 768, scrollWidth: 1024, scrollHeight: 768 } }),
      viewportAudit({ viewport: "mobile", dimensions: { width: 390, height: 844, scrollWidth: 390, scrollHeight: 844 } })
    ],
    navigationResults,
    screenshots: [],
    targetInfo: {
      acceptance_target: "latest_projection",
      acceptance_mode: "release_default_latest_projection",
      release_default: true
    }
  });
  const validation = validateFrontendAcceptanceRunArtifact(baseArtifact({
    navigation_results: navigationResults
  }));

  assert.equal(artifact.status, "fail");
  assert.ok(artifact.findings.some((finding) => finding.code === "frontend_dead_navigation"));
  assert.ok(validation.issues.some((issue) => issue.code === "frontend_navigation_semantic_change_required"));
  assert.ok(validation.issues.some((issue) => issue.code === "frontend_navigation_active_only_not_allowed"));
});

test("frontend acceptance allows navigation with distinct visible content", () => {
  const artifact = baseArtifact({
    navigation_results: [
      {
        label: "运行",
        before: {
          active: "总览",
          scrollTop: 0,
          mainText: "overview status",
          visibleSections: [{ section: "overview", text: "overview status" }],
          focusedSection: { section: "overview", heading: "当前目标" }
        },
        after: {
          active: "运行",
          scrollTop: 0,
          mainText: "scheduler dispatch details",
          visibleSections: [{ section: "runs", text: "scheduler dispatch details" }],
          focusedSection: { section: "runs", heading: "Scheduler Dispatch" }
        },
        active_changed: true,
        visible_text_changed: true,
        visible_sections_changed: true,
        focused_section_changed: true,
        semantic_changed: true,
        changed: true
      }
    ]
  });

  assert.equal(validateFrontendAcceptanceRunArtifact(artifact).status, "pass");
});

test("closeout rejects fixture-only frontend acceptance artifacts", () => {
  const closeoutValidation = readFileSync("src/workflow/closeout-validation.js", "utf8");

  assert.match(closeoutValidation, /frontend acceptance artifact must validate the release default latest projection/);
  assert.match(closeoutValidation, /latest projection evidence/);
  assert.match(closeoutValidation, /current-session/);
});

test("failed frontend acceptance creates a bounded repair work package", () => {
  const artifact = baseArtifact({
    status: "fail",
    findings: [
      {
        code: "frontend_dead_navigation",
        severity: "p1",
        status: "fail",
        message: "Navigation tabs do not change active state"
      }
    ],
    blocking_count: 1
  });
  const workflowState = baseWorkflowState();
  const recorded = recordFrontendAcceptanceRunArtifact(workflowState, artifact, {
    artifact_id: "frontend-acceptance-current-workbench"
  });
  const summary = summarizeFrontendAcceptance(recorded.workflow_state.manifest, recorded.workflow_state.artifact_ledger);
  const workPackage = summary.repair_work_package;

  assert.equal(summary.status, "fail");
  assert.equal(summary.repair_required, true);
  assert.equal(workPackage.action, FRONTEND_ACCEPTANCE_REPAIR_ACTION);
  assert.equal(workPackage.id, "frontend-acceptance-repair-frontend-acceptance-current-workbench");
  assert.ok(workPackage.owned_files.includes("apps/workbench"));
  assert.ok(workPackage.owned_files.includes("test/workbench-shell.test.js"));
  assert.ok(workPackage.acceptance_gates.includes("npm run check:workbench:frontend-acceptance"));
  assert.deepEqual(workPackage.frontend_acceptance.finding_codes, ["frontend_dead_navigation"]);

  assert.deepEqual(
    createFrontendAcceptanceRepairWorkPackage(summary),
    workPackage
  );
});

test("failed frontend acceptance schedules a bounded UI repair child-worker package", () => {
  const workflowState = baseWorkflowState();
  workflowState.manifest.run_id = "run-frontend-repair";
  workflowState.manifest.cycle_id = "cycle-frontend-repair";
  workflowState.artifact_ledger.run_id = "run-frontend-repair";
  workflowState.artifact_ledger.cycle_id = "cycle-frontend-repair";
  const artifact = baseArtifact({
    status: "fail",
    findings: [
      {
        code: "frontend_dead_navigation",
        severity: "p1",
        status: "fail",
        message: "Navigation tabs do not change active state"
      }
    ],
    blocking_count: 1
  });
  const recorded = recordFrontendAcceptanceRunArtifact(workflowState, artifact, {
    artifact_id: "frontend-acceptance-current-workbench"
  });
  const projection = createWorkbenchProjection(recorded.workflow_state);
  const decision = decideContinuation({
    project_status: {
      project: "ai-control-platform",
      next_step: ""
    },
    run_evaluation: { status: "pass", next_work_packages: [] },
    workflow_state: recorded.workflow_state
  });
  const repairPackage = decision.next_work_packages.find((workPackage) => {
    return workPackage.action === FRONTEND_ACCEPTANCE_REPAIR_ACTION;
  });
  const repairSubtask = decision.context_pack_seed.subtasks.find((subtask) => subtask.id === repairPackage.id);

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.should_continue, true);
  assert.ok(repairPackage);
  assert.ok(repairPackage.owned_files.includes("apps/workbench"));
  assert.ok(repairPackage.acceptance_gates.includes("npm run check:workbench:frontend-acceptance"));
  assert.equal(repairPackage.frontend_acceptance.artifact_id, "frontend-acceptance-current-workbench");
  assert.equal(repairPackage.frontend_acceptance.blocking_count, 1);
  assert.ok(decision.context_pack_seed.owned_files.includes("apps/workbench"));
  assert.ok(decision.context_pack_seed.owned_files.includes("test/workbench-shell.test.js"));
  assert.equal(repairSubtask.action, FRONTEND_ACCEPTANCE_REPAIR_ACTION);
  assert.equal(repairSubtask.source.frontend_acceptance.artifact_id, "frontend-acceptance-current-workbench");
  assert.deepEqual(repairSubtask.source.acceptance_gates, repairPackage.acceptance_gates);
  assert.equal(projection.next_action_readout.action, FRONTEND_ACCEPTANCE_REPAIR_ACTION);
  assert.ok(projection.one_screen.next_actions.some((action) => action.action === FRONTEND_ACCEPTANCE_REPAIR_ACTION));
});

test("closeout and package scripts wire frontend acceptance as a hard gate", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const closeout = readFileSync("tools/check-closeout.mjs", "utf8");
  const closeoutValidation = readFileSync("src/workflow/closeout-validation.js", "utf8");

  assert.equal(
    pkg.scripts["check:workbench:frontend-acceptance"],
    "node tools/run-with-node18.mjs tools/check-workbench-frontend-acceptance.mjs"
  );
  assert.match(closeout, /check-workbench-frontend-acceptance\.mjs/);
  assert.match(closeout, /validateFrontendAcceptanceArtifact/);
  assert.match(closeoutValidation, /frontend acceptance artifact did not pass/);
  assert.match(closeoutValidation, /release default latest projection/);
});

test("closeout and package scripts wire public workbench live-route acceptance as a hard gate", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const closeout = readFileSync("tools/check-closeout.mjs", "utf8");
  const liveRouteGate = readFileSync("tools/check-workbench-live-route.mjs", "utf8");
  const projectStatus = JSON.parse(readFileSync("PROJECT_STATUS.json", "utf8"));
  const evidencePath = projectStatus.workbench_live_route_evidence?.path;
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));

  assert.equal(
    pkg.scripts["check:workbench:live-route"],
    "node tools/run-with-node18.mjs tools/check-workbench-live-route.mjs"
  );
  assert.equal(
    pkg.scripts["check:workbench:public-browser-route"],
    "node tools/run-with-node18.mjs tools/check-workbench-public-browser-route.mjs"
  );
  assert.match(closeout, /check-workbench-live-route\.mjs/);
  assert.match(closeout, /check-workbench-public-browser-route\.mjs/);
  assert.match(liveRouteGate, /WORKBENCH_LIVE_ROUTE_EVIDENCE/);
  assert.match(evidencePath, /^docs\/examples\/public-live-route-evidence-.+\.json$/);
  assert.equal(projectStatus.workbench_live_route_evidence?.status, "pass");
  assert.equal(evidence.version, "workbench-live-route-evidence.v1");
  assert.equal(evidence.status, "pass");
});
