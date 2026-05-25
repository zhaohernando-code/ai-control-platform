export const MAINLINE_RELEASE_READINESS_GATE_ID = "mainline-release-readiness";
export const DEFAULT_MAINLINE_BRANCH = "main";
export const DEFAULT_MAINLINE_REMOTE_REF = "origin/main";

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function issue(code, message, path, details = {}) {
  return { code, message, path, gate_id: MAINLINE_RELEASE_READINESS_GATE_ID, ...details };
}

function parseCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : NaN;
}

function liveRouteStatus(input = {}) {
  const gate = input.live_route_gate || input.liveRouteGate || {};
  const artifact = input.live_route_evidence || input.liveRouteEvidence || {};
  const status = normalizeToken(gate.status || artifact.status);
  const evidenceStatus = normalizeToken(gate.evidence_status || gate.evidenceStatus);
  const artifactStatus = normalizeToken(artifact.status);
  const publicRouteVerified = artifact.public_route_verified === true ||
    artifact.publicRouteVerified === true ||
    artifact.route?.public_route_verified === true ||
    artifact.route?.verified === true;
  const workbenchRendered = artifact.workbench_rendered === true ||
    artifact.workbenchRendered === true ||
    artifact.workbench?.rendered === true;
  const mountedApiVerified = artifact.mounted_api_verified === true ||
    artifact.mountedApiVerified === true ||
    artifact.workbench?.mounted_api_verified === true;

  return {
    status,
    evidence_status: evidenceStatus,
    artifact_status: artifactStatus,
    public_route_verified: publicRouteVerified,
    workbench_rendered: workbenchRendered,
    mounted_api_verified: mountedApiVerified
  };
}

export function evaluateMainlineReleaseReadiness(input = {}) {
  const expectedBranch = normalizeString(input.expected_branch || input.expectedBranch) || DEFAULT_MAINLINE_BRANCH;
  const expectedRemoteRef = normalizeString(input.expected_remote_ref || input.expectedRemoteRef) || DEFAULT_MAINLINE_REMOTE_REF;
  const branch = normalizeString(input.branch);
  const headCommit = normalizeString(input.head_commit || input.headCommit);
  const remoteRef = normalizeString(input.remote_ref || input.remoteRef) || expectedRemoteRef;
  const remoteCommit = normalizeString(input.remote_commit || input.remoteCommit);
  const dirtyEntries = asArray(input.dirty_entries || input.dirtyEntries);
  const dirtyCount = Number.isFinite(Number(input.dirty_count || input.dirtyCount))
    ? Number(input.dirty_count || input.dirtyCount)
    : dirtyEntries.length;
  const aheadCount = parseCount(input.ahead_count ?? input.aheadCount);
  const behindCount = parseCount(input.behind_count ?? input.behindCount);
  const requirePublicRoute = input.require_public_route !== false && input.requirePublicRoute !== false;
  const route = liveRouteStatus(input);
  const issues = [];

  if (branch !== expectedBranch) {
    issues.push(issue("not_on_mainline_branch", `closeout must run on ${expectedBranch}`, "branch", { expected_branch: expectedBranch }));
  }
  if (dirtyCount > 0) {
    issues.push(issue("dirty_worktree_blocks_mainline_release", "worktree must be clean before mainline/release closeout", "dirty_entries"));
  }
  if (!headCommit) {
    issues.push(issue("missing_local_head_commit", "local HEAD commit must be known", "head_commit"));
  }
  if (remoteRef !== expectedRemoteRef) {
    issues.push(issue("unexpected_mainline_remote_ref", `mainline remote ref must be ${expectedRemoteRef}`, "remote_ref", {
      expected_remote_ref: expectedRemoteRef
    }));
  }
  if (!remoteCommit) {
    issues.push(issue("missing_remote_mainline_commit", "remote mainline commit must be known", "remote_commit"));
  }
  if (headCommit && remoteCommit && headCommit !== remoteCommit) {
    issues.push(issue("local_head_not_on_remote_mainline", "local HEAD must match the remote mainline commit", "head_commit", {
      head_commit: headCommit,
      remote_commit: remoteCommit
    }));
  }
  if (!Number.isFinite(aheadCount)) {
    issues.push(issue("missing_remote_ahead_count", "ahead count against remote mainline must be known", "ahead_count"));
  } else if (aheadCount !== 0) {
    issues.push(issue("local_commits_not_pushed_to_mainline", "local HEAD has commits not present on remote mainline", "ahead_count", {
      ahead_count: aheadCount
    }));
  }
  if (!Number.isFinite(behindCount)) {
    issues.push(issue("missing_remote_behind_count", "behind count against remote mainline must be known", "behind_count"));
  } else if (behindCount !== 0) {
    issues.push(issue("local_mainline_behind_remote", "local HEAD is behind remote mainline", "behind_count", {
      behind_count: behindCount
    }));
  }

  if (requirePublicRoute) {
    if (route.status !== "pass") {
      issues.push(issue("public_release_route_gate_not_passed", "public/live route gate must pass for release closeout", "live_route_gate.status"));
    }
    if (route.evidence_status && !["pass", "not_required"].includes(route.evidence_status)) {
      issues.push(issue("public_release_route_evidence_not_accepted", "public/live route evidence must be accepted", "live_route_gate.evidence_status"));
    }
    if (route.artifact_status && route.artifact_status !== "pass") {
      issues.push(issue("public_release_route_artifact_not_passed", "public/live route evidence artifact must pass", "live_route_evidence.status"));
    }
    if (route.artifact_status === "pass") {
      if (!route.public_route_verified) {
        issues.push(issue("public_release_route_not_verified", "public route must be verified in release evidence", "live_route_evidence.public_route_verified"));
      }
      if (!route.workbench_rendered) {
        issues.push(issue("public_release_workbench_not_rendered", "workbench render must be verified in release evidence", "live_route_evidence.workbench_rendered"));
      }
      if (!route.mounted_api_verified) {
        issues.push(issue("public_release_api_not_verified", "mounted workbench API must be verified in release evidence", "live_route_evidence.mounted_api_verified"));
      }
    }
  }

  return {
    gate_id: MAINLINE_RELEASE_READINESS_GATE_ID,
    status: issues.length > 0 ? "fail" : "pass",
    branch,
    expected_branch: expectedBranch,
    head_commit: headCommit || null,
    remote_ref: remoteRef,
    expected_remote_ref: expectedRemoteRef,
    remote_commit: remoteCommit || null,
    ahead_count: Number.isFinite(aheadCount) ? aheadCount : null,
    behind_count: Number.isFinite(behindCount) ? behindCount : null,
    dirty_count: dirtyCount,
    dirty_entries: dirtyEntries.slice(0, 20),
    live_route_status: route.status || null,
    live_route_evidence_status: route.evidence_status || route.artifact_status || null,
    issues
  };
}
