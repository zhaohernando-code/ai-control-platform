import { PROJECT_MANAGEMENT_TEXT } from "./frontend-acceptance-fixtures.js";

export function viewportAudit(overrides = {}) {
  const viewport = overrides.viewport || "desktop";
  const routePath = viewport === "mobile"
    ? "/projects/ai-control-platform/requirements"
    : "/projects/ai-control-platform/";
  const nav = viewport === "mobile"
    ? []
    : ["总览", "项目", "任务流", "Agents", "风险", "治理", "运行诊断"].map((text) => ({ text }));
  return {
    viewport,
    routePath,
    mounted: true,
    dimensions: { width: 1440, height: 900, scrollWidth: 1440, scrollHeight: 900 },
    nav,
    buttons: [],
    faviconLinks: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href_attribute: "/favicon.svg",
        href: "http://127.0.0.1:4180/projects/ai-control-platform/favicon.svg"
      }
    ],
    mountedSvgFaviconResponses: [
      {
        url: "http://127.0.0.1:4180/projects/ai-control-platform/favicon.svg",
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

export function baseWorkflowState() {
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
