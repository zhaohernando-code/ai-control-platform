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
import { baseArtifact } from "./helpers/frontend-acceptance-fixtures.js";
import { baseWorkflowState, viewportAudit } from "./helpers/frontend-acceptance-viewport.js";

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

test("frontend acceptance validation rejects browser error false-pass artifacts", () => {
  const validation = validateFrontendAcceptanceRunArtifact(baseArtifact({
    browser_error_results: [
      { viewport: "desktop", error_count: 1, blocked_error_count: 1, errors: [{ source: "console", type: "error", text: "boom" }] },
      { viewport: "desktop_narrow", error_count: 0, blocked_error_count: 0, errors: [] },
      { viewport: "mobile", error_count: 0, blocked_error_count: 0, errors: [] }
    ]
  }));

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "frontend_browser_error_false_pass"));
  assert.ok(validation.issues.some((issue) => issue.code === "frontend_browser_error_finding_mismatch"));
});

test("frontend acceptance validation rejects Next artifacts that used the legacy static shell", () => {
  const validation = validateFrontendAcceptanceRunArtifact(baseArtifact({
    route_family: "nextjs_app_router",
    legacy_static_shell_used: true
  }));

  assert.equal(validation.status, "fail");
  assert.ok(validation.issues.some((issue) => issue.code === "next_frontend_acceptance_legacy_shell_not_allowed"));
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
    "node tools/run-with-node18.mjs tools/check-workbench-next-frontend-acceptance.mjs"
  );
  assert.equal(pkg.scripts["check:workbench:legacy-frontend-acceptance"], undefined);
  assert.match(closeout, /check-workbench-next-frontend-acceptance\.mjs/);
  assert.match(closeout, /validateFrontendAcceptanceArtifact/);
  assert.match(closeoutValidation, /frontend acceptance artifact did not pass/);
  assert.match(closeoutValidation, /release default latest projection/);
});

test("closeout and package scripts wire public workbench live-route acceptance as a hard gate", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const closeout = readFileSync("tools/check-closeout.mjs", "utf8");
  const liveRouteGate = readFileSync("tools/check-workbench-live-route.mjs", "utf8");
  const publicBrowserGate = readFileSync("tools/check-workbench-public-browser-route.mjs", "utf8");
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
  assert.match(closeout, /AI_CONTROL_WORKBENCH_API_PORT \|\| "4182"/);
  assert.doesNotMatch(closeout, /record-workbench-url", `http:\/\/\$\{WORKBENCH_HOST\}:\$\{WORKBENCH_PORT\}/);
  assert.match(liveRouteGate, /WORKBENCH_LIVE_ROUTE_EVIDENCE/);
  assert.match(publicBrowserGate, /waitUntil: "domcontentloaded"/);
  assert.match(publicBrowserGate, /locator\("\.ant-layout"\)\.first\(\)\.waitFor/);
  assert.match(publicBrowserGate, /pathname === "\/projects\/ai-control-platform"/);
  assert.match(evidencePath, /^docs\/examples\/public-live-route-evidence-.+\.json$/);
  assert.equal(projectStatus.workbench_live_route_evidence?.status, "pass");
  assert.equal(evidence.version, "workbench-live-route-evidence.v1");
  assert.equal(evidence.status, "pass");
});
