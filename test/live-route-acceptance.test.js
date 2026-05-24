import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  detectWorkbenchLiveRouteBlockers,
  evaluateWorkbenchLiveRouteAcceptance,
  extractExpectedPublicRouteUrls,
  validateWorkbenchLiveRouteEvidenceArtifact,
  WORKBENCH_LIVE_ROUTE_EVIDENCE_VERSION
} from "../src/workflow/live-route-acceptance.js";

function projectStatus(overrides = {}) {
  return {
    project: "ai-control-platform",
    blockers: [
      {
        id: "public-project-route-auth-gate",
        category: "canonical_route_unverified",
        severity: "p1",
        requires_human: true,
        evidence: "curl --http1.1 -k -D - https://hernando-zhao.cn/projects/ai-control-platform/ returned HTTP/1.1 302 Found with Location: /?next=%2Fprojects%2Fai-control-platform%2F; local 127.0.0.1:4180 mounted route verified successfully."
      }
    ],
    next_step: "Resolve the public https://hernando-zhao.cn/projects/ai-control-platform/ auth gate before closeout.",
    latest_update: "Public canonical verification is still blocked.",
    ...overrides
  };
}

function liveEvidence(overrides = {}) {
  return {
    version: WORKBENCH_LIVE_ROUTE_EVIDENCE_VERSION,
    status: "pass",
    created_at: "2026-05-24T16:00:00.000Z",
    project: "ai-control-platform",
    route_url: "https://hernando-zhao.cn/projects/ai-control-platform/",
    final_url: "https://hernando-zhao.cn/projects/ai-control-platform/",
    http_status: 200,
    public_route_verified: true,
    mounted_workbench_route_verified: true,
    workbench_rendered: true,
    mounted_api_verified: true,
    auth_redirect_detected: false,
    local_loopback: false,
    ...overrides
  };
}

test("detects unresolved public canonical workbench route blockers in project status", () => {
  const blockers = detectWorkbenchLiveRouteBlockers(projectStatus());
  const expectedUrls = extractExpectedPublicRouteUrls(projectStatus());

  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].id, "public-project-route-auth-gate");
  assert.deepEqual(expectedUrls, ["https://hernando-zhao.cn/projects/ai-control-platform/"]);
});

test("live route acceptance fails closed when blocker has no verified public evidence", () => {
  const result = evaluateWorkbenchLiveRouteAcceptance({
    projectStatus: projectStatus()
  });

  assert.equal(result.status, "fail");
  assert.equal(result.blocker_count, 1);
  assert.equal(result.evidence_status, "missing");
  assert.ok(result.issues.some((issue) => issue.code === "missing_verified_public_live_route_evidence"));
});

test("live route evidence rejects local loopback or auth redirect evidence", () => {
  const localValidation = validateWorkbenchLiveRouteEvidenceArtifact(liveEvidence({
    route_url: "http://127.0.0.1:4180/projects/ai-control-platform/",
    final_url: "http://127.0.0.1:4180/projects/ai-control-platform/",
    local_loopback: true
  }), {
    projectId: "ai-control-platform",
    expectedRouteUrls: ["https://hernando-zhao.cn/projects/ai-control-platform/"]
  });
  const redirectValidation = validateWorkbenchLiveRouteEvidenceArtifact(liveEvidence({
    final_url: "https://hernando-zhao.cn/?next=%2Fprojects%2Fai-control-platform%2F",
    http_status: 302,
    auth_redirect_detected: true
  }), {
    projectId: "ai-control-platform",
    expectedRouteUrls: ["https://hernando-zhao.cn/projects/ai-control-platform/"]
  });

  assert.equal(localValidation.status, "fail");
  assert.ok(localValidation.issues.some((issue) => issue.code === "live_route_url_not_public_https"));
  assert.ok(localValidation.issues.some((issue) => issue.code === "local_live_route_evidence_not_allowed"));
  assert.equal(redirectValidation.status, "fail");
  assert.ok(redirectValidation.issues.some((issue) => issue.code === "live_route_http_status_not_success"));
  assert.ok(redirectValidation.issues.some((issue) => issue.code === "live_route_auth_redirect_detected"));
});

test("live route acceptance passes only with matching public mounted workbench evidence", () => {
  const result = evaluateWorkbenchLiveRouteAcceptance({
    projectStatus: projectStatus(),
    evidenceArtifact: liveEvidence()
  });

  assert.equal(result.status, "pass");
  assert.equal(result.blocker_count, 1);
  assert.equal(result.evidence_status, "pass");
  assert.equal(result.evidence.route_url, "https://hernando-zhao.cn/projects/ai-control-platform/");
  assert.equal(result.issues.length, 0);
});

test("live route CLI blocks current project status without evidence and accepts explicit evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-live-route-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const evidencePath = join(dir, "live-route-evidence.json");
  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(evidencePath, `${JSON.stringify(liveEvidence(), null, 2)}\n`);

  const blocked = spawnSync(process.execPath, ["tools/check-workbench-live-route.mjs", "--project-status", projectStatusPath], {
    encoding: "utf8"
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /missing_verified_public_live_route_evidence/);

  const accepted = spawnSync(process.execPath, [
    "tools/check-workbench-live-route.mjs",
    "--project-status",
    projectStatusPath,
    "--evidence",
    evidencePath
  ], {
    encoding: "utf8"
  });
  assert.equal(accepted.status, 0);
  assert.match(accepted.stdout, /"status": "pass"/);
});
