const INTERNAL_VISIBLE_COPY_PATTERNS = [
  ["Work Packages", /\bWork Packages\b/i],
  ["Context Pack -> Run -> Review -> Continuation", /\bContext Pack\s*(?:->|→)\s*Run\s*(?:->|→)\s*Review\s*(?:->|→)\s*Continuation\b/i],
  ["Provider Health", /\bProvider Health\b/i],
  ["Smoke OK", /\bSmoke OK\b/i],
  ["Smoke Timeout", /\bSmoke Timeout\b/i],
  ["role(s)", /\brole\(s\)\b/i],
  ["Projection", /\bProjection\b/i],
  ["Closeout", /\bCloseout\b/i],
  ["Resume Health", /\bResume Health\b/i],
  ["Snapshot", /\bSnapshot\b/i],
  ["Evidence", /\bEvidence\b/i],
  ["Artifacts", /\bArtifacts\b/i],
  ["Reviewer Findings", /\bReviewer Findings\b/i],
  ["Dispatchable", /\bDispatchable\b/i],
  ["Scheduler Steps", /\bScheduler Steps\b/i],
  ["Global Pending", /\bGlobal Pending\b/i],
  ["Global Done", /\bGlobal Done\b/i],
  ["Scheduler Dispatch", /\bScheduler Dispatch\b/i],
  ["Dry run", /\bDry run\b/i],
  ["Projected Mock Loop", /\bProjected Mock Loop\b/i],
  ["Projected Real Loop", /\bProjected Real Loop\b/i],
  ["Provider smoke", /\bProvider smoke\b/i],
  ["Headless live context cycle", /\bHeadless live context cycle\b/i],
  ["Context pack cycle", /\bContext pack cycle\b/i],
  ["Current autonomous platform self-trial", /\bCurrent autonomous platform self-trial\b/i],
  ["Platform repository bootstrap", /\bPlatform repository bootstrap\b/i]
];
const LONG_ARTIFACT_IDENTIFIER_PATTERN = /\b(?:scheduler-dispatch-run-run|scheduler-dispatch-policy-run|context-work-packages-run-run|agent-lifecycle-[A-Za-z]+|project-status-continuation|context-pack-cycle|headless-live-context-cycle|frontend-acceptance|workbench-live-route-evidence|cycle-headless-live)[A-Za-z0-9._-]{16,}\b/g;
const CONTENT_PLACEHOLDER_PATTERN = /--|未配置|未就绪|未知|(?:^|[\s:：,，;；([（])0(?=$|[\s,，;；)\]）])/g;
const CONTENT_UNRESOLVED_PLACEHOLDER_PATTERN = /--|未配置|未就绪|未知/g;
const CONTENT_TELEMETRY_PATTERN = /\b(?:run_id|cycle_id|artifact_id|artifact|manifest|ledger|payload|metadata|projection|status|not_configured|no_next_action|frontend_acceptance|scheduler_dispatch|next_action_readout|work_package|context_pack|provider_health|resume_health|closeout|snapshot|diagnostics?|telemetry|null|undefined)\b|(?:状态码|遥测|诊断字段|原始状态|后端字段)/gi;
const CONTENT_ACTIONABLE_PATTERN = /下一步|待处理|优先|处理|执行|派发|修复|恢复|审查|验收|收口|阻塞|风险|决策|建议|证据|任务|工作包|原因|影响|需要|可执行|继续|重试|发布|入口|选择|确认|失败原因|动作|模型|预算|健康|完成|通过|异常|人工|操作/g;
const CONTENT_NEXT_STEP_PATTERN = /下一步|待处理|需要|建议|修复|处理|执行|派发|恢复|重试|继续|验收|收口|查看|确认|选择|阻塞原因|风险处理|可执行/g;

function finding(code, severity, message, evidence = {}) {
  return { code, severity, status: "fail", message, evidence };
}

export function normalizeText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function countValue(value) {
  const count = Number(value);
  return Number.isFinite(count) ? count : 0;
}

function countContentMatches(text, pattern) {
  return (normalizeText(text).match(pattern) || []).length;
}

function contentTextMetrics(text = "") {
  const normalized = normalizeText(text);
  return {
    text_length: normalized.length,
    placeholder_count: countContentMatches(normalized, CONTENT_PLACEHOLDER_PATTERN),
    unresolved_placeholder_count: countContentMatches(normalized, CONTENT_UNRESOLVED_PLACEHOLDER_PATTERN),
    telemetry_token_count: countContentMatches(normalized, CONTENT_TELEMETRY_PATTERN),
    actionable_label_count: countContentMatches(normalized, CONTENT_ACTIONABLE_PATTERN),
    next_step_context_count: countContentMatches(normalized, CONTENT_NEXT_STEP_PATTERN)
  };
}

export function contentSectionsOf(result = {}) {
  const sections = Array.isArray(result.contentSections)
    ? result.contentSections
    : Array.isArray(result.content_sections)
      ? result.content_sections
      : [];
  if (sections.length > 0) return sections;
  return [{
    index: 0,
    section_key: "body",
    heading: "body",
    text: result.bodyText || "",
    text_length: normalizeText(result.bodyText).length,
    data_bind_count: countValue(result.diagnosticsCount ?? result.diagnostics_count),
    visible: true,
    source_type: "browser_dom_text"
  }];
}

export function contentCompletionResultForViewport(result = {}) {
  const bodyMetrics = contentTextMetrics(result.bodyText);
  const sections = contentSectionsOf(result).map((section, index) => {
    const text = normalizeText(section.text || section.text_sample || "");
    const metrics = contentTextMetrics(text);
    const operatorContextCount = metrics.actionable_label_count + metrics.next_step_context_count;
    return {
      index: Number.isFinite(Number(section.index)) ? Number(section.index) : index,
      section_key: normalizeText(section.section_key || section.section || section.id) || `section-${index + 1}`,
      heading: normalizeText(section.heading || section.title).slice(0, 120),
      text_sample: text.slice(0, 360),
      ...metrics,
      text_length: Number(section.text_length ?? metrics.text_length),
      data_bind_count: countValue(section.data_bind_count ?? section.dataBindCount),
      placeholder_ratio: Number((metrics.placeholder_count / Math.max(metrics.placeholder_count + operatorContextCount, 1)).toFixed(3)),
      source_type: "browser_dom_text"
    };
  });
  const diagnosticFieldCount = Math.max(
    countValue(result.diagnosticsCount ?? result.diagnostics_count),
    sections.reduce((total, section) => total + countValue(section.data_bind_count), 0)
  );
  const operatorContextCount = bodyMetrics.actionable_label_count + bodyMetrics.next_step_context_count;
  const placeholderDominatedSections = sections.filter((section) => {
    const sectionOperatorContext = section.actionable_label_count + section.next_step_context_count;
    return (section.text_length > 0 && section.placeholder_count >= 3 && sectionOperatorContext < 4 && section.placeholder_ratio >= 0.45) ||
      (section.placeholder_count >= 5 && sectionOperatorContext < 6);
  });
  const isDesktop = result.viewport === "desktop" || result.viewport === "desktop_narrow";
  const diagnosticWallSections = sections.filter((section) => isDesktop && section.data_bind_count >= 10 && section.unresolved_placeholder_count >= 6);
  const diagnosticDominated = isDesktop && (
    diagnosticFieldCount >= 48 ||
    (diagnosticFieldCount >= 18 && bodyMetrics.unresolved_placeholder_count >= 36) ||
    diagnosticWallSections.length > 0 ||
    (diagnosticFieldCount >= 18 && diagnosticFieldCount > Math.max(operatorContextCount * 2, 12)) ||
    (bodyMetrics.telemetry_token_count >= 18 && bodyMetrics.telemetry_token_count > Math.max(operatorContextCount * 2, 12))
  );
  const mobileTelemetryDump = result.viewport === "mobile" && (
    diagnosticFieldCount > 20 ||
    (bodyMetrics.text_length > 1400 && bodyMetrics.telemetry_token_count > Math.max(bodyMetrics.next_step_context_count * 2, 10)) ||
    (bodyMetrics.text_length > 2200 && operatorContextCount < 14)
  );
  const codes = [
    diagnosticDominated ? "frontend_content_diagnostic_wall" : null,
    mobileTelemetryDump ? "frontend_content_mobile_telemetry_dump" : null,
    placeholderDominatedSections.length > 0 ? "frontend_content_placeholder_section" : null
  ].filter(Boolean);
  return {
    viewport: result.viewport,
    source_type: "browser_dom_text",
    status: codes.length > 0 ? "fail" : "pass",
    body_text_length: bodyMetrics.text_length,
    body_text_sample: normalizeText(result.bodyText).slice(0, 360),
    section_count: sections.length,
    diagnostic_field_count: diagnosticFieldCount,
    placeholder_count: bodyMetrics.placeholder_count,
    unresolved_placeholder_count: bodyMetrics.unresolved_placeholder_count,
    telemetry_token_count: bodyMetrics.telemetry_token_count,
    actionable_label_count: bodyMetrics.actionable_label_count,
    next_step_context_count: bodyMetrics.next_step_context_count,
    diagnostic_dominated: diagnosticDominated,
    mobile_telemetry_dump: mobileTelemetryDump,
    diagnostic_wall_sections: diagnosticWallSections,
    placeholder_dominated_sections: placeholderDominatedSections,
    blocking_finding_codes: codes,
    content_sections: sections
  };
}

function includesAllText(text, values) {
  const normalized = normalizeText(text);
  return values.every((value) => normalized.includes(value));
}

export function projectManagementSemanticResultForViewport(result = {}) {
  const text = normalizeText(result.bodyText);
  const contentText = normalizeText(contentSectionsOf(result).map((section) => `${section.heading || ""} ${section.text || section.text_sample || ""}`).join(" ")) || text;
  const navLabels = new Set((result.nav || []).map((item) => normalizeText(item.text)));
  const requiredNav = result.viewport === "mobile" ? [] : ["总览", "项目", "任务流", "Agents", "风险", "治理"];
  const requiredLifecycle = ["需求", "拆解", "子任务", "Review", "发布", "Live 验证", "验收"];
  const requiredProjectFields = ["项目列表", "AI Control Platform", "ai-control-platform", "阶段", "当前任务", "Agent", "进度", "更新"];
  const hasRequiredNav = requiredNav.every((label) => navLabels.has(label));
  const hasProjectList = includesAllText(text, requiredProjectFields);
  const hasLifecycle = includesAllText(text, requiredLifecycle);
  const hasRequirementIntake = includesAllText(text, ["新建任务", "提交"]);
  const diagnosticsPrimary = contentText.indexOf("运行诊断") >= 0 && contentText.indexOf("项目列表") > contentText.indexOf("运行诊断");
  const codes = [
    hasRequiredNav ? null : "frontend_project_management_nav_missing",
    hasProjectList ? null : "frontend_project_management_project_list_missing",
    hasLifecycle ? null : "frontend_project_management_task_flow_missing",
    hasRequirementIntake ? null : "frontend_requirement_intake_missing",
    diagnosticsPrimary ? "frontend_projection_diagnostics_primary" : null
  ].filter(Boolean);
  return {
    viewport: result.viewport,
    status: codes.length > 0 ? "fail" : "pass",
    source_type: "browser_dom_product_semantics",
    has_required_nav: hasRequiredNav,
    has_project_list: hasProjectList,
    has_platform_project: text.includes("AI Control Platform") && text.includes("ai-control-platform"),
    has_project_fields: includesAllText(text, ["阶段", "当前任务", "Agent", "进度", "更新"]),
    has_task_lifecycle: hasLifecycle,
    has_requirement_intake: hasRequirementIntake,
    diagnostics_primary: diagnosticsPrimary,
    required_nav: requiredNav,
    required_lifecycle: requiredLifecycle,
    text_sample: contentText.slice(0, 1000),
    blocking_finding_codes: codes
  };
}

export function internalVisibleCopyMatches(bodyText = "") {
  const text = normalizeText(bodyText);
  const matches = INTERNAL_VISIBLE_COPY_PATTERNS.flatMap(([label, pattern]) => pattern.test(text) ? [{ label }] : []);
  return matches.concat((text.match(LONG_ARTIFACT_IDENTIFIER_PATTERN) || []).map((match) => ({
    label: "raw_artifact_identifier",
    text: match.slice(0, 160)
  })));
}

export function findingsForContentCompletion(results) {
  return results.flatMap((result) => [
    result.diagnostic_dominated ? finding("frontend_content_diagnostic_wall", "p1", `${result.viewport} default surface is dominated by diagnostic fields or telemetry instead of operator decisions`, result) : null,
    result.mobile_telemetry_dump ? finding("frontend_content_mobile_telemetry_dump", "p1", "mobile workbench content is a long telemetry/status dump instead of prioritized operator tasks", result) : null,
    result.placeholder_dominated_sections.length > 0 ? finding("frontend_content_placeholder_section", "p1", `${result.viewport} contains visible sections whose content is mostly placeholders without actionable context`, {
      viewport: result.viewport,
      sections: result.placeholder_dominated_sections.slice(0, 8)
    }) : null
  ].filter(Boolean));
}

export function findingsForProjectManagementSemantics(results) {
  const messages = {
    frontend_project_management_nav_missing: "desktop workbench navigation must expose project-management sections from the original design",
    frontend_project_management_project_list_missing: "workbench must show a project list with ai-control-platform and current project work fields",
    frontend_project_management_task_flow_missing: "workbench must show the project task lifecycle from requirement through acceptance",
    frontend_requirement_intake_missing: "workbench must let operators submit requirements into the autonomous development flow",
    frontend_projection_diagnostics_primary: "projection diagnostics must not appear before the project-management surface"
  };
  return results.flatMap((result) => result.status === "pass" ? [] : (result.blocking_finding_codes || []).map((code) => {
    return finding(code, "p1", messages[code] || "project-management semantic requirement failed", {
      viewport: result.viewport,
      text_sample: result.text_sample,
      required_nav: result.required_nav,
      required_lifecycle: result.required_lifecycle
    });
  }));
}
