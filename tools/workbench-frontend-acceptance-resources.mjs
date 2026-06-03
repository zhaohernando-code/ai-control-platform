import { normalizeText } from "./workbench-frontend-acceptance-content.mjs";

const WORKBENCH_MOUNT_PREFIX = "/projects/ai-control-platform";
const WORKBENCH_FAVICON_PATH = "/apps/workbench/favicon.svg";
const NEXT_WORKBENCH_FAVICON_PATH = "/favicon.svg";

function finding(code, severity, message, evidence = {}) {
  return { code, severity, status: "fail", message, evidence };
}

function pathnameOfUrl(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return normalizeText(value);
  }
}

export function faviconLinksOf(result = {}) {
  return Array.isArray(result.faviconLinks) ? result.faviconLinks : Array.isArray(result.favicon_links) ? result.favicon_links : [];
}

function mountedSvgFaviconResponsesOf(result = {}) {
  const responses = Array.isArray(result.mountedSvgFaviconResponses)
    ? result.mountedSvgFaviconResponses
    : Array.isArray(result.mounted_svg_favicon_responses)
      ? result.mounted_svg_favicon_responses
      : [];
  return responses.filter((response) => {
    const pathname = pathnameOfUrl(response.url || response.href);
    return pathname.endsWith(WORKBENCH_FAVICON_PATH) || pathname === `${WORKBENCH_MOUNT_PREFIX}${NEXT_WORKBENCH_FAVICON_PATH}`;
  });
}

function isWorkbenchFaviconLink(link = {}) {
  const hrefAttribute = normalizeText(link.href_attribute || link.hrefAttribute).replace(/^\.\//, "");
  const pathname = pathnameOfUrl(link.href);
  const type = normalizeText(link.type).toLowerCase();
  return (
    (hrefAttribute === "favicon.svg" ||
      pathname.endsWith(WORKBENCH_FAVICON_PATH) ||
      pathname === `${WORKBENCH_MOUNT_PREFIX}${NEXT_WORKBENCH_FAVICON_PATH}`) &&
    (!type || type === "image/svg+xml")
  );
}

function isRootFaviconLink(link = {}) {
  const hrefAttribute = normalizeText(link.href_attribute || link.hrefAttribute);
  return hrefAttribute === "/favicon.ico" || pathnameOfUrl(link.href) === "/favicon.ico";
}

function normalizeContentType(value) {
  return normalizeText(value).toLowerCase().split(";")[0].trim();
}

function contentTypeOf(response = {}) {
  return response.content_type || response.contentType || "";
}

function mountedSvgFaviconMimePasses(result = {}) {
  const okResponses = mountedSvgFaviconResponsesOf(result).filter((response) => response.status >= 200 && response.status < 300);
  return okResponses.length > 0 && okResponses.every((response) => normalizeContentType(contentTypeOf(response)) === "image/svg+xml");
}

export function mountedSafeFaviconCount(result = {}) {
  return faviconLinksOf(result).filter(isWorkbenchFaviconLink).length;
}

export function findingsForResources(viewportResults) {
  return viewportResults.flatMap((result) => {
    const links = faviconLinksOf(result);
    const rootLinks = links.filter(isRootFaviconLink);
    const findings = [];
    if (result.mounted !== true) findings.push(finding("frontend_non_mounted_workbench_route", "p1", `${result.viewport} did not exercise the live project-mounted workbench route`, { viewport: result.viewport, route_path: result.routePath || null }));
    if (links.length === 0) return findings.concat(finding("frontend_missing_favicon_link", "p1", `${result.viewport} has no explicit favicon link and may fall back to /favicon.ico`, { viewport: result.viewport, route_path: result.routePath || null }));
    if (rootLinks.length > 0) findings.push(finding("frontend_root_favicon_fallback", "p1", `${result.viewport} points favicon traffic at root /favicon.ico`, { viewport: result.viewport, links: rootLinks }));
    if (mountedSafeFaviconCount(result) === 0) findings.push(finding("frontend_favicon_not_mounted_safe", "p1", `${result.viewport} favicon is not mounted with the workbench static assets`, { viewport: result.viewport, links }));
    if (mountedSafeFaviconCount(result) > 0 && !mountedSvgFaviconMimePasses(result)) findings.push(finding("frontend_mounted_svg_favicon_mime_drift", "p1", `${result.viewport} mounted SVG favicon must be served as image/svg+xml`, { viewport: result.viewport, route_path: result.routePath || null, responses: mountedSvgFaviconResponsesOf(result) }));
    return findings;
  });
}

export function resourceResultForViewport(result = {}) {
  const links = faviconLinksOf(result);
  const responses = mountedSvgFaviconResponsesOf(result);
  const drifted = responses.find((response) => response.status >= 200 && response.status < 300 && normalizeContentType(contentTypeOf(response)) !== "image/svg+xml");
  const first = drifted || responses[0];
  return {
    viewport: result.viewport,
    route_path: result.routePath || null,
    mounted_workbench_route: result.mounted === true,
    favicon_link_count: links.length,
    mounted_safe_favicon_count: mountedSafeFaviconCount(result),
    root_favicon_count: links.filter(isRootFaviconLink).length,
    mounted_svg_favicon_mime: contentTypeOf(first) || null,
    mounted_svg_favicon_mime_ok: mountedSvgFaviconMimePasses(result),
    mounted_svg_favicon_responses: responses,
    favicon_links: links
  };
}
