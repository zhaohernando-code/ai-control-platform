import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  detectWorkbenchLiveRouteBlockers,
  evaluateWorkbenchLiveRouteAcceptance,
  extractExpectedPublicRouteUrls,
  validateWorkbenchLiveRouteEvidenceFreshness,
  validateWorkbenchLiveRouteEvidenceArtifact,
  WORKBENCH_LIVE_ROUTE_EVIDENCE_VERSION
} from "../src/workflow/live-route-acceptance.js";

const LIVE_ROUTE_EVIDENCE_ENV = "WORKBENCH_LIVE_ROUTE_EVIDENCE";
const FRESH_NOW = "2026-05-25T09:45:00.000Z";
const FRESH_EVIDENCE_TIME = "2026-05-25T09:30:00.000Z";
const STALE_EVIDENCE_TIME = "2026-05-24T16:13:13.897Z";

function withoutLiveRouteEvidenceEnv(env = process.env) {
  const nextEnv = { ...env };
  delete nextEnv[LIVE_ROUTE_EVIDENCE_ENV];
  return nextEnv;
}

function projectStatus(overrides = {}) {
  return {
    project: "ai-control-platform",
    updated_at: "2026-05-25T09:00:00.000Z",
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
    created_at: FRESH_EVIDENCE_TIME,
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
    projectStatus: projectStatus(),
    now: FRESH_NOW
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

test("local loopback evidence is accepted only through explicit probe test mode", () => {
  const evidence = liveEvidence({
    route_url: "http://127.0.0.1:4180/projects/ai-control-platform/",
    final_url: "http://127.0.0.1:4180/projects/ai-control-platform/",
    local_loopback: true
  });
  const testValidation = validateWorkbenchLiveRouteEvidenceArtifact(evidence, {
    projectId: "ai-control-platform",
    expectedRouteUrls: ["https://hernando-zhao.cn/projects/ai-control-platform/"],
    allowInsecureLocalTest: true
  });
  const realValidation = validateWorkbenchLiveRouteEvidenceArtifact(evidence, {
    projectId: "ai-control-platform",
    expectedRouteUrls: ["https://hernando-zhao.cn/projects/ai-control-platform/"]
  });

  assert.equal(testValidation.status, "pass");
  assert.equal(realValidation.status, "fail");
  assert.ok(realValidation.issues.some((issue) => issue.code === "local_live_route_evidence_not_allowed"));
});

test("live route acceptance passes only with matching public mounted workbench evidence", () => {
  const result = evaluateWorkbenchLiveRouteAcceptance({
    projectStatus: projectStatus(),
    evidenceArtifact: liveEvidence(),
    now: FRESH_NOW
  });

  assert.equal(result.status, "pass");
  assert.equal(result.blocker_count, 1);
  assert.equal(result.evidence_status, "pass");
  assert.equal(result.evidence.route_url, "https://hernando-zhao.cn/projects/ai-control-platform/");
  assert.equal(result.issues.length, 0);
});

test("live route acceptance rejects stale durable evidence while blocker is unresolved", () => {
  const result = evaluateWorkbenchLiveRouteAcceptance({
    projectStatus: projectStatus(),
    evidenceArtifact: liveEvidence({
      created_at: STALE_EVIDENCE_TIME
    }),
    evidenceMetadata: {
      captured_at: STALE_EVIDENCE_TIME
    },
    now: FRESH_NOW
  });

  assert.equal(result.status, "fail");
  assert.equal(result.evidence_status, "fail");
  assert.equal(result.evidence_freshness.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "stale_live_route_evidence"));
});

test("live route freshness requires evidence newer than current blocker state", () => {
  const freshness = validateWorkbenchLiveRouteEvidenceFreshness({
    projectStatus: projectStatus({
      updated_at: "2026-05-25T09:40:00.000Z"
    }),
    blockers: detectWorkbenchLiveRouteBlockers(projectStatus()),
    evidenceArtifact: liveEvidence({
      created_at: FRESH_EVIDENCE_TIME
    }),
    now: FRESH_NOW
  });

  assert.equal(freshness.status, "fail");
  assert.ok(freshness.issues.some((issue) => (
    issue.code === "stale_live_route_evidence" &&
      issue.reason === "older_than_project_status_update"
  )));
});

test("live route CLI blocks current project status without evidence and accepts explicit evidence", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-live-route-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const evidencePath = join(dir, "live-route-evidence.json");
  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus(), null, 2)}\n`);
  writeFileSync(evidencePath, `${JSON.stringify(liveEvidence(), null, 2)}\n`);
  const closeoutContaminatedEnv = {
    ...process.env,
    [LIVE_ROUTE_EVIDENCE_ENV]: evidencePath
  };

  const blocked = spawnSync(process.execPath, ["tools/check-workbench-live-route.mjs", "--project-status", projectStatusPath], {
    encoding: "utf8",
    env: withoutLiveRouteEvidenceEnv(closeoutContaminatedEnv)
  });
  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /missing_verified_public_live_route_evidence/);

  const accepted = spawnSync(process.execPath, [
    "tools/check-workbench-live-route.mjs",
    "--project-status",
    projectStatusPath,
    "--evidence",
    evidencePath,
    "--now",
    FRESH_NOW
  ], {
    encoding: "utf8",
    env: closeoutContaminatedEnv
  });
  assert.equal(accepted.status, 0);
  assert.match(accepted.stdout, /"status": "pass"/);
});

test("live route CLI accepts fresh PROJECT_STATUS durable evidence path when explicit evidence is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-live-route-durable-"));
  const evidenceRelativePath = "docs/examples/public-live-route-evidence.json";
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const evidencePath = join(dir, evidenceRelativePath);
  mkdirSync(join(dir, "docs/examples"), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(liveEvidence(), null, 2)}\n`);
  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus({
    workbench_live_route_evidence: {
      status: "pass",
      path: evidenceRelativePath,
      schema: WORKBENCH_LIVE_ROUTE_EVIDENCE_VERSION,
      durable: true
    }
  }), null, 2)}\n`);

  const accepted = spawnSync(process.execPath, [
    "tools/check-workbench-live-route.mjs",
    "--project-status",
    projectStatusPath,
    "--now",
    FRESH_NOW
  ], {
    encoding: "utf8",
    env: withoutLiveRouteEvidenceEnv()
  });

  assert.equal(accepted.status, 0);
  assert.match(accepted.stdout, /"status": "pass"/);
  assert.match(accepted.stdout, /"evidence_source": "project_status"/);
});

test("live route CLI rejects stale PROJECT_STATUS durable evidence path under unresolved blocker", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-live-route-stale-durable-"));
  const evidenceRelativePath = "docs/examples/public-live-route-evidence.json";
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  const evidencePath = join(dir, evidenceRelativePath);
  mkdirSync(join(dir, "docs/examples"), { recursive: true });
  writeFileSync(evidencePath, `${JSON.stringify(liveEvidence({
    created_at: STALE_EVIDENCE_TIME
  }), null, 2)}\n`);
  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus({
    workbench_live_route_evidence: {
      status: "pass",
      path: evidenceRelativePath,
      schema: WORKBENCH_LIVE_ROUTE_EVIDENCE_VERSION,
      captured_at: STALE_EVIDENCE_TIME,
      durable: true
    }
  }), null, 2)}\n`);

  const blocked = spawnSync(process.execPath, [
    "tools/check-workbench-live-route.mjs",
    "--project-status",
    projectStatusPath,
    "--now",
    FRESH_NOW
  ], {
    encoding: "utf8",
    env: withoutLiveRouteEvidenceEnv()
  });

  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /stale_live_route_evidence/);
  assert.match(blocked.stdout, /"evidence_source": "project_status"/);
});

test("live route CLI still fails closed when status has no durable evidence path", () => {
  const dir = mkdtempSync(join(tmpdir(), "ai-control-platform-live-route-no-durable-"));
  const projectStatusPath = join(dir, "PROJECT_STATUS.json");
  writeFileSync(projectStatusPath, `${JSON.stringify(projectStatus({
    workbench_live_route_evidence: {
      status: "missing",
      path: "",
      durable: false
    }
  }), null, 2)}\n`);

  const blocked = spawnSync(process.execPath, ["tools/check-workbench-live-route.mjs", "--project-status", projectStatusPath], {
    encoding: "utf8",
    env: withoutLiveRouteEvidenceEnv()
  });

  assert.equal(blocked.status, 1);
  assert.match(blocked.stdout, /missing_verified_public_live_route_evidence/);
  assert.doesNotMatch(blocked.stdout, /"evidence_source": "project_status"/);
});
