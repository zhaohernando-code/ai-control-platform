import assert from "node:assert/strict";
import test from "node:test";

import { buildArtifact } from "../tools/check-workbench-frontend-acceptance.mjs";
import { validateFrontendAcceptanceRunArtifact } from "../src/workflow/frontend-acceptance.js";
import { baseArtifact } from "./helpers/frontend-acceptance-fixtures.js";
import { viewportAudit } from "./helpers/frontend-acceptance-viewport.js";

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

test("frontend acceptance accepts mounted Next workbench favicon links", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        routePath: "/projects/ai-control-platform/",
        faviconLinks: [
          {
            rel: "icon",
            type: "image/svg+xml",
            href_attribute: "/projects/ai-control-platform/favicon.svg",
            href: "http://127.0.0.1:4191/projects/ai-control-platform/favicon.svg"
          }
        ],
        mountedSvgFaviconResponses: [
          {
            url: "http://127.0.0.1:4191/projects/ai-control-platform/favicon.svg",
            status: 200,
            content_type: "image/svg+xml"
          }
        ]
      }),
      viewportAudit({ viewport: "desktop_narrow", routePath: "/projects/ai-control-platform/", dimensions: { width: 1024, height: 768, scrollWidth: 1024, scrollHeight: 768 } }),
      viewportAudit({ viewport: "mobile", routePath: "/projects/ai-control-platform/", dimensions: { width: 390, height: 844, scrollWidth: 390, scrollHeight: 844 } })
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

  assert.equal(desktopResources.mounted_safe_favicon_count, 1);
  assert.equal(desktopResources.root_favicon_count, 0);
  assert.equal(desktopResources.mounted_svg_favicon_mime_ok, true);
  assert.ok(!artifact.findings.some((finding) => finding.code === "frontend_favicon_not_mounted_safe"));
  assert.ok(!validation.issues.some((issue) => issue.code === "missing_frontend_favicon_readiness"));
});

test("frontend acceptance requires mounted SVG favicon MIME evidence", () => {
  const artifact = buildArtifact({
    viewportResults: [
      viewportAudit({
        viewport: "desktop",
        mountedSvgFaviconResponses: [
          {
            url: "http://127.0.0.1:4180/projects/ai-control-platform/favicon.svg",
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
