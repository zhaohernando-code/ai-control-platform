import { WORKBENCH_MOUNT_PREFIX } from "./workbench-next-served-route-runtime.mjs";

const ROUTE_TIMEOUT_MS = 30000;

function compactResponse(response) {
  return {
    url: response.url(),
    status: response.status(),
    content_type: response.headers()["content-type"] || null
  };
}

export async function auditViewport(browser, baseUrl, viewportName, contextOptions = {}) {
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const consoleErrors = [];
  const pageErrors = [];
  const failedRequests = [];
  const httpErrors = [];
  const importantResponses = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });
  page.on("requestfailed", (request) => {
    const failure = request.failure()?.errorText || "unknown";
    if (failure === "net::ERR_ABORTED" && request.url().includes("/api/workbench/projection")) {
      return;
    }
    failedRequests.push({
      url: request.url(),
      failure
    });
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes(WORKBENCH_MOUNT_PREFIX) || url.includes("/_next/static/")) {
      importantResponses.push(compactResponse(response));
    }
    if (response.status() >= 400) {
      httpErrors.push(compactResponse(response));
    }
  });

  const response = await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/`, {
    waitUntil: "domcontentloaded",
    timeout: ROUTE_TIMEOUT_MS
  });
  await page.locator(".ant-layout").first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  await page.locator('[data-component="workbench-nav"]').first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  await page.waitForLoadState("networkidle", { timeout: ROUTE_TIMEOUT_MS }).catch(() => {});

  const root = await page.evaluate(() => ({
    title: document.title,
    final_url: location.href,
    body_text_sample: document.body.innerText.slice(0, 1200),
    ant_layout_count: document.querySelectorAll(".ant-layout").length,
    ant_menu_count: document.querySelectorAll(".ant-menu").length,
    mounted_next_script_count: document.querySelectorAll('script[src*="/projects/ai-control-platform/_next/static"]').length,
    root_next_script_count: document.querySelectorAll('script[src^="/_next/static"]').length,
    desktop_shell_count: document.querySelectorAll(".desktop-shell").length,
    mobile_shell_count: document.querySelectorAll(".mobile-shell").length,
    legacy_data_bind_count: document.querySelectorAll("[data-bind]").length,
    has_legacy_static_entry: document.documentElement.outerHTML.includes("apps/workbench/desktop.html") ||
      document.documentElement.outerHTML.includes("apps/workbench/mobile.html") ||
      document.documentElement.outerHTML.includes("workbench.js"),
    dimensions: {
      width: document.documentElement.clientWidth,
      scrollWidth: document.documentElement.scrollWidth
    }
  }));

  const projectionResponse = importantResponses.find((entry) => entry.url.includes("/api/workbench/projection"));
  const projectionApiProbe = await page.evaluate(async () => {
    const response = await fetch("/projects/ai-control-platform/api/workbench/projection", { cache: "no-store" });
    const body = await response.json().catch(() => ({}));
    return {
      url: response.url,
      status: response.status,
      content_type: response.headers.get("content-type") || "",
      projection_status: body?.status || null,
      run_id: body?.run_id || null,
      cycle_id: body?.cycle_id || null
    };
  });
  const faviconResponse = await page.evaluate(async () => {
    const response = await fetch("/projects/ai-control-platform/favicon.svg", { cache: "no-store" });
    return {
      url: response.url,
      status: response.status,
      content_type: response.headers.get("content-type") || ""
    };
  });

  await context.close();

  return {
    viewport: viewportName,
    route_path: `${WORKBENCH_MOUNT_PREFIX}/`,
    http_status: response?.status() || 0,
    projection_response: projectionResponse || null,
    projection_api_probe: projectionApiProbe,
    favicon_response: faviconResponse,
    console_error_count: consoleErrors.length,
    page_error_count: pageErrors.length,
    failed_request_count: failedRequests.length,
    http_error_count: httpErrors.length,
    console_errors: consoleErrors.slice(0, 10),
    page_errors: pageErrors.slice(0, 10),
    failed_requests: failedRequests.slice(0, 10),
    http_errors: httpErrors.slice(0, 10),
    responses: importantResponses.slice(0, 80),
    ...root
  };
}

export async function auditNavigation(browser, baseUrl) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}/`, {
    waitUntil: "domcontentloaded",
    timeout: ROUTE_TIMEOUT_MS
  });
  await page.locator('[data-component="workbench-nav"]').first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  await page.getByText("新建任务", { exact: true }).click();
  await page.locator("form").first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  const requirementsUrl = page.url();
  const requirementText = await page.locator("body").innerText();
  await page.getByRole("button", { name: "查看任务流" }).click();
  await page.waitForURL(new RegExp(`${WORKBENCH_MOUNT_PREFIX}/flow/?$`), { timeout: ROUTE_TIMEOUT_MS });
  await page.locator("text=任务流").first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
  const flowUrl = page.url();
  await page.close();
  return {
    status: "pass",
    requirements_url: requirementsUrl,
    flow_url: flowUrl,
    requirements_contains_form: requirementText.includes("任务标题") &&
      requirementText.includes("所属项目") &&
      requirementText.includes("需求描述")
  };
}

export async function auditRouteSet(browser, baseUrl) {
  const routes = [
    { label: "overview", path: "/" },
    { label: "requirements", path: "/requirements" },
    { label: "projects", path: "/projects" },
    { label: "flow", path: "/flow" },
    { label: "agents", path: "/agents" },
    { label: "risks", path: "/risks" },
    { label: "governance", path: "/governance" },
    { label: "runs", path: "/runs" }
  ];
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const results = [];
  try {
    for (const route of routes) {
      const response = await page.goto(`${baseUrl}${WORKBENCH_MOUNT_PREFIX}${route.path}`, {
        waitUntil: "domcontentloaded",
        timeout: ROUTE_TIMEOUT_MS
      });
      await page.locator(".ant-layout").first().waitFor({ state: "visible", timeout: ROUTE_TIMEOUT_MS });
      const dom = await page.evaluate(() => ({
        final_url: location.href,
        ant_layout_count: document.querySelectorAll(".ant-layout").length,
        ant_menu_count: document.querySelectorAll(".ant-menu").length,
        legacy_data_bind_count: document.querySelectorAll("[data-bind]").length,
        desktop_shell_count: document.querySelectorAll(".desktop-shell").length,
        mobile_shell_count: document.querySelectorAll(".mobile-shell").length,
        body_text_sample: document.body.innerText.slice(0, 360)
      }));
      results.push({
        ...route,
        route_path: `${WORKBENCH_MOUNT_PREFIX}${route.path}`,
        http_status: response?.status() || 0,
        ...dom
      });
    }
  } finally {
    await page.close();
  }
  return results;
}
