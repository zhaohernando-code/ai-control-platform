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
  createFrontendAcceptanceRepairWorkPackage,
  FRONTEND_ACCEPTANCE_RUN_VERSION,
  FRONTEND_ACCEPTANCE_REPAIR_ACTION,
  recordFrontendAcceptanceRunArtifact,
  summarizeFrontendAcceptance,
  validateFrontendAcceptanceRunArtifact
} from "../src/workflow/frontend-acceptance.js";
import { createWorkbenchProjection } from "../src/workflow/workbench-projection.js";

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
    layout_results: [],
    copy_results: [],
    resource_results: [
      { viewport: "desktop", route_path: "/projects/ai-control-platform/apps/workbench/desktop.html", mounted_workbench_route: true, favicon_link_count: 1, mounted_safe_favicon_count: 1, root_favicon_count: 0, mounted_svg_favicon_mime: "image/svg+xml", mounted_svg_favicon_mime_ok: true },
      { viewport: "desktop_narrow", route_path: "/projects/ai-control-platform/apps/workbench/desktop.html", mounted_workbench_route: true, favicon_link_count: 1, mounted_safe_favicon_count: 1, root_favicon_count: 0, mounted_svg_favicon_mime: "image/svg+xml", mounted_svg_favicon_mime_ok: true },
      { viewport: "mobile", route_path: "/projects/ai-control-platform/apps/workbench/mobile.html", mounted_workbench_route: true, favicon_link_count: 1, mounted_safe_favicon_count: 1, root_favicon_count: 0, mounted_svg_favicon_mime: "image/svg+xml", mounted_svg_favicon_mime_ok: true }
    ],
    control_results: [],
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
  return {
    viewport,
    routePath: `/projects/ai-control-platform/apps/workbench/${shell}`,
    mounted: true,
    dimensions: { width: 1440, height: 900, scrollWidth: 1440, scrollHeight: 900 },
    nav: [],
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
    bodyText: "中台工作台 状态投影 任务包 证据 调度执行 收口验收 续跑健康 审查通道",
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
        bodyText: "任务包 证据 审查发现 可派发 调度步数 准备上下文 执行 审查 续跑 收口验收 状态快照 续跑健康 审查通道 连通正常"
      }),
      viewportAudit({
        viewport: "desktop_narrow",
        dimensions: { width: 1024, height: 768, scrollWidth: 1024, scrollHeight: 768 },
        bodyText: "任务包 证据 调度执行 状态投影"
      }),
      viewportAudit({
        viewport: "mobile",
        dimensions: { width: 390, height: 844, scrollWidth: 390, scrollHeight: 844 },
        bodyText: "中台工作台 状态投影 收口验收 自动调度 续跑健康 模型与审查 通道连通"
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
  assert.equal(validateFrontendAcceptanceRunArtifact(artifact).status, "pass");
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
  const closeout = readFileSync("tools/check-closeout.mjs", "utf8");

  assert.match(closeout, /frontend acceptance artifact must validate the release default latest projection/);
  assert.match(closeout, /latest projection evidence/);
  assert.match(closeout, /current-session/);
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
});

test("closeout and package scripts wire frontend acceptance as a hard gate", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const closeout = readFileSync("tools/check-closeout.mjs", "utf8");

  assert.equal(
    pkg.scripts["check:workbench:frontend-acceptance"],
    "node tools/run-with-node18.mjs tools/check-workbench-frontend-acceptance.mjs"
  );
  assert.match(closeout, /check-workbench-frontend-acceptance\.mjs/);
  assert.match(closeout, /frontend acceptance artifact did not pass/);
  assert.match(closeout, /release default latest projection/);
});

test("closeout and package scripts wire public workbench live-route acceptance as a hard gate", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const closeout = readFileSync("tools/check-closeout.mjs", "utf8");
  const liveRouteGate = readFileSync("tools/check-workbench-live-route.mjs", "utf8");
  const projectStatus = JSON.parse(readFileSync("PROJECT_STATUS.json", "utf8"));

  assert.equal(
    pkg.scripts["check:workbench:live-route"],
    "node tools/run-with-node18.mjs tools/check-workbench-live-route.mjs"
  );
  assert.match(closeout, /check-workbench-live-route\.mjs/);
  assert.match(liveRouteGate, /WORKBENCH_LIVE_ROUTE_EVIDENCE/);
  assert.ok(projectStatus.blockers.some((blocker) => blocker.id === "public-project-route-auth-gate"));
});
