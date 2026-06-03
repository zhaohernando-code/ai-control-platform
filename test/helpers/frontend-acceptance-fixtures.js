import { FRONTEND_ACCEPTANCE_RUN_VERSION } from "../../src/workflow/frontend-acceptance.js";

export const PROJECT_MANAGEMENT_TEXT = [
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

export function projectManagementSemanticResult(viewport, overrides = {}) {
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

export function baseArtifact(overrides = {}) {
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
      { viewport: "desktop", route_path: "/projects/ai-control-platform/", mounted_workbench_route: true, mounted_safe_favicon_count: 1, dimensions: { width: 1440, scrollWidth: 1440 } },
      { viewport: "desktop_narrow", route_path: "/projects/ai-control-platform/", mounted_workbench_route: true, mounted_safe_favicon_count: 1, dimensions: { width: 1024, scrollWidth: 1024 } },
      { viewport: "mobile", route_path: "/projects/ai-control-platform/requirements", mounted_workbench_route: true, mounted_safe_favicon_count: 1, dimensions: { width: 390, scrollWidth: 390 } }
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
      { viewport: "desktop", route_path: "/projects/ai-control-platform/", mounted_workbench_route: true, favicon_link_count: 1, mounted_safe_favicon_count: 1, root_favicon_count: 0, mounted_svg_favicon_mime: "image/svg+xml", mounted_svg_favicon_mime_ok: true },
      { viewport: "desktop_narrow", route_path: "/projects/ai-control-platform/", mounted_workbench_route: true, favicon_link_count: 1, mounted_safe_favicon_count: 1, root_favicon_count: 0, mounted_svg_favicon_mime: "image/svg+xml", mounted_svg_favicon_mime_ok: true },
      { viewport: "mobile", route_path: "/projects/ai-control-platform/requirements", mounted_workbench_route: true, favicon_link_count: 1, mounted_safe_favicon_count: 1, root_favicon_count: 0, mounted_svg_favicon_mime: "image/svg+xml", mounted_svg_favicon_mime_ok: true }
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
    browser_error_results: [
      { viewport: "desktop", error_count: 0, blocked_error_count: 0, errors: [] },
      { viewport: "desktop_narrow", error_count: 0, blocked_error_count: 0, errors: [] },
      { viewport: "mobile", error_count: 0, blocked_error_count: 0, errors: [] }
    ],
    mobile_results: [],
    findings: [],
    blocking_count: 0,
    blocking_findings: [],
    ...overrides
  };
}
