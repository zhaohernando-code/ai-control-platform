import assert from "node:assert/strict";
import test from "node:test";

import { buildArtifact } from "../tools/check-workbench-frontend-acceptance.mjs";
import { validateFrontendAcceptanceRunArtifact } from "../src/workflow/frontend-acceptance.js";
import { baseArtifact } from "./helpers/frontend-acceptance-fixtures.js";
import { viewportAudit } from "./helpers/frontend-acceptance-viewport.js";

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
