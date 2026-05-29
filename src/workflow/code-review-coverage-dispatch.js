// Code-review-coverage domain vocabulary. "audited"/"covered"/"not_applicable" are
// coverage-specific terminal states with no equivalent in the shared status-vocabulary —
// do NOT replace with PASS_SYNONYMS, that would silently drop them and break coverage.
const PASS_STATUSES = new Set(["pass", "passed", "audited", "completed", "covered", "not_applicable"]);
const DISPATCH_STATUSES = new Set([
  "missing",
  "pending",
  "needs_evidence",
  "needs_rerun",
  "rerun",
  "retry",
  "fail",
  "failed",
  "blocked",
  "incomplete"
]);

const EXCLUDED_DIR_SEGMENTS = new Map([
  ["node_modules", "third_party_dependency"],
  [".git", "vcs_metadata"],
  [".next", "build_or_framework_output"],
  [".nuxt", "build_or_framework_output"],
  [".turbo", "cache"],
  [".cache", "cache"],
  ["dist", "build_output"],
  ["build", "build_output"],
  ["coverage", "coverage_output"],
  ["tmp", "temporary_file"],
  ["temp", "temporary_file"],
  ["logs", "log_output"],
  [".pytest_cache", "cache"],
  [".venv", "local_environment"],
  ["vendor", "third_party_dependency"]
]);

const EXCLUDED_SUFFIXES = new Map([
  [".min.js", "minified_output"],
  [".map", "source_map"],
  [".log", "log_output"],
  [".tmp", "temporary_file"],
  [".cache", "cache"]
]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function uniqueStrings(value) {
  return [...new Set(compactStrings(value))];
}

function slug(value) {
  return normalizeString(value).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "coverage";
}

function pathValue(value) {
  return normalizeString(value).replace(/\\/g, "/").replace(/^\.\//, "");
}

function fileListFrom(value = {}) {
  return uniqueStrings([
    ...compactStrings(value.files),
    ...compactStrings(value.paths),
    ...compactStrings(value.owned_files || value.ownedFiles),
    ...compactStrings(value.input_files || value.inputFiles),
    ...compactStrings(value.scoped_files || value.scopedFiles)
  ]).map(pathValue);
}

function issue(code, message, path = "") {
  return { code, message, path };
}

export function codeReviewPathExclusion(path) {
  const normalized = pathValue(path);
  if (!normalized) return { excluded: false, path: normalized, reason: "" };
  const segments = normalized.split("/").filter(Boolean);

  for (const segment of segments) {
    if (EXCLUDED_DIR_SEGMENTS.has(segment)) {
      return {
        excluded: true,
        path: normalized,
        reason: EXCLUDED_DIR_SEGMENTS.get(segment)
      };
    }
  }

  for (const [suffix, reason] of EXCLUDED_SUFFIXES.entries()) {
    if (normalized.endsWith(suffix)) {
      return { excluded: true, path: normalized, reason };
    }
  }

  const filename = segments.at(-1) || normalized;
  if (filename.includes(".generated.")) {
    return { excluded: true, path: normalized, reason: "generated_file" };
  }
  if (filename.includes(".gen.")) {
    return { excluded: true, path: normalized, reason: "generated_file" };
  }

  return { excluded: false, path: normalized, reason: "" };
}

function excludedPathRecords(files = []) {
  return fileListFrom({ files })
    .map(codeReviewPathExclusion)
    .filter((record) => record.excluded);
}

function uniqueExcludedRecords(records = []) {
  const byPath = new Map();
  for (const record of asArray(records)) {
    const path = normalizeString(record?.path);
    if (!path || byPath.has(path)) continue;
    byPath.set(path, {
      path,
      reason: normalizeString(record.reason)
    });
  }
  return [...byPath.values()];
}

function firstPartyFiles(files = []) {
  return fileListFrom({ files }).filter((file) => !codeReviewPathExclusion(file).excluded);
}

function shardStatus(shard = {}) {
  return normalizeToken(shard.status || shard.result || shard.outcome || shard.decision) || "missing";
}

function shardId(shard = {}, index = 0) {
  return normalizeString(shard.id || shard.shard_id || shard.shardId || shard.name) || `code-review-shard-${index + 1}`;
}

function normalizeShard(shard = {}, index = 0) {
  const files = fileListFrom(shard);
  const excluded = excludedPathRecords(files);
  return {
    id: shardId(shard, index),
    title: normalizeString(shard.title || shard.name),
    status: shardStatus(shard),
    files,
    first_party_files: firstPartyFiles(files),
    excluded_files: excluded,
    evidence: compactStrings(shard.evidence || shard.evidence_refs || shard.evidenceRefs),
    reason: normalizeString(shard.reason || shard.message || shard.summary)
  };
}

function declaredMissingShards(artifact = {}) {
  const summary = artifact.summary || artifact.coverage_summary || artifact.coverageSummary || {};
  const declared = [
    ...asArray(artifact.missing_shards || artifact.missingShards),
    ...asArray(artifact.pending_shards || artifact.pendingShards),
    ...asArray(artifact.needs_rerun_shards || artifact.needsRerunShards),
    ...asArray(summary.missing_shards || summary.missingShards),
    ...asArray(summary.pending_shards || summary.pendingShards),
    ...asArray(summary.needs_rerun_shards || summary.needsRerunShards),
    ...asArray(summary.failed_shards || summary.failedShards)
  ];
  const missingCount = Number(
    artifact.missing_shard_count ||
      artifact.missingShardCount ||
      summary.missing_shard_count ||
      summary.missingShardCount ||
      0
  );
  if (declared.length === 0 && missingCount > 0) {
    for (let index = 0; index < missingCount; index += 1) {
      declared.push({ id: `missing-shard-${index + 1}`, status: "missing", reason: "summary declares missing shard without shard evidence" });
    }
  }
  return declared.map((item, index) => {
    if (item && typeof item === "object" && !Array.isArray(item)) return normalizeShard(item, index);
    return normalizeShard({ id: item, status: "missing" }, index);
  });
}

function coverageFilesFromArtifact(artifact = {}) {
  return uniqueStrings([
    ...fileListFrom(artifact),
    ...compactStrings(artifact.changed_files || artifact.changedFiles),
    ...compactStrings(artifact.first_party_files || artifact.firstPartyFiles),
    ...compactStrings(artifact.denominator_files || artifact.denominatorFiles),
    ...compactStrings(artifact.scope?.files),
    ...compactStrings(artifact.scope?.paths),
    ...compactStrings(artifact.summary?.files),
    ...compactStrings(artifact.summary?.denominator_files || artifact.summary?.denominatorFiles)
  ]).map(pathValue);
}

function packageFilesFor(shard = {}, fallbackFiles = []) {
  const files = shard.first_party_files.length > 0 ? shard.first_party_files : firstPartyFiles(fallbackFiles);
  return uniqueStrings(files);
}

function workPackageForShard(shard = {}, index = 0, fallbackFiles = []) {
  const id = `code-review-coverage-${slug(shard.id || `shard-${index + 1}`)}`;
  const ownedFiles = packageFilesFor(shard, fallbackFiles);
  return {
    id,
    title: `补跑代码质量审查覆盖分片：${shard.title || shard.id || `shard ${index + 1}`}`,
    action: "run_code_quality_review_shard",
    governance_action: "supplement_code_review_coverage",
    dimension: "code_quality",
    shard_id: shard.id || `code-review-shard-${index + 1}`,
    owned_files: ownedFiles,
    acceptance_gates: ["npm run check:code-review-coverage", "npm run check:closeout"],
    reason: shard.reason || `code review coverage shard status is ${shard.status}`,
    code_review_coverage: {
      version: "code-review-coverage-dispatch.v1",
      source_artifact_id: normalizeString(shard.source_artifact_id),
      shard_id: shard.id || `code-review-shard-${index + 1}`,
      shard_status: shard.status,
      excluded_files: shard.excluded_files,
      first_party_files: ownedFiles
    }
  };
}

function hasCoverageIdentity(artifact = {}) {
  const version = normalizeToken(artifact.version || artifact.schema || artifact.type);
  return version === "code-review-coverage.v1" || version === "code_review_coverage" || version === "code-review-coverage";
}

export function evaluateCodeReviewCoverageDispatch(artifact = {}, options = {}) {
  if (!artifact || typeof artifact !== "object" || Array.isArray(artifact)) {
    return {
      version: "code-review-coverage-dispatch.v1",
      status: "fail",
      issues: [issue("invalid_code_review_coverage_artifact", "code review coverage artifact must be an object")],
      supplemental_work_packages: [],
      excluded_files: [],
      first_party_files: []
    };
  }

  const allFiles = coverageFilesFromArtifact(artifact);
  const firstParty = firstPartyFiles(allFiles);
  const shards = asArray(artifact.shards || artifact.coverage_shards || artifact.coverageShards)
    .map((shard, index) => normalizeShard(shard, index));
  const syntheticMissing = declaredMissingShards(artifact)
    .filter((missing) => !shards.some((shard) => shard.id === missing.id));
  const allShards = [...shards, ...syntheticMissing].map((shard) => ({
    ...shard,
    source_artifact_id: normalizeString(artifact.id || artifact.artifact_id || artifact.artifactId)
  }));
  const excluded = uniqueExcludedRecords([
    ...excludedPathRecords(allFiles),
    ...allShards.flatMap((shard) => shard.excluded_files)
  ]);
  const nonPassingShards = allShards.filter((shard) => !PASS_STATUSES.has(shard.status));
  const needsDispatchShards = nonPassingShards.filter((shard) => DISPATCH_STATUSES.has(shard.status) || !shard.status);
  const unknownStatusShards = nonPassingShards.filter((shard) => !DISPATCH_STATUSES.has(shard.status));
  const missingEvidence = allShards.filter((shard) => PASS_STATUSES.has(shard.status) && shard.evidence.length === 0);
  const issues = [
    ...unknownStatusShards.map((shard) => issue("unknown_code_review_shard_status", `code review shard ${shard.id} has unknown status ${shard.status}`, shard.id)),
    ...missingEvidence.map((shard) => issue("missing_code_review_shard_evidence", `code review shard ${shard.id} has pass status without evidence`, shard.id))
  ];
  const dispatchShards = needsDispatchShards.length > 0
    ? needsDispatchShards
    : (nonPassingShards.length > 0 ? nonPassingShards : []);
  const supplemental = dispatchShards.map((shard, index) => workPackageForShard(shard, index, firstParty));
  const artifactStatus = normalizeToken(artifact.status);
  const explicitlyFailing = ["fail", "failed", "error", "invalid"].includes(artifactStatus);
  const status = issues.length > 0
    ? "fail"
    : (supplemental.length > 0 ? "needs_dispatch" : (explicitlyFailing ? "fail" : "pass"));

  return {
    version: "code-review-coverage-dispatch.v1",
    status,
    coverage_artifact_id: normalizeString(artifact.id || artifact.artifact_id || artifact.artifactId) || null,
    coverage_artifact_version: normalizeString(artifact.version || artifact.schema || artifact.type) || null,
    first_party_file_count: firstParty.length,
    excluded_file_count: excluded.length,
    shard_count: allShards.length,
    dispatch_shard_count: dispatchShards.length,
    issues,
    first_party_files: firstParty,
    excluded_files: excluded,
    shards: allShards,
    supplemental_work_packages: supplemental,
    package_ids: supplemental.map((workPackage) => workPackage.id),
    scheduler_status: supplemental.length > 0 ? "dispatch_required" : "not_required",
    passthrough: options.include_artifact === true ? artifact : undefined
  };
}

export function latestCodeReviewCoverageArtifactFrom(input = {}) {
  const explicit = input.code_review_coverage || input.codeReviewCoverage || input.workflow_state?.code_review_coverage;
  if (explicit) return explicit;

  const events = asArray(input.workflow_state?.manifest?.events || input.manifest?.events)
    .filter((event) => normalizeToken(event?.type) === "code_review_coverage");
  const latest = events.at(-1);
  if (!latest) return null;
  return latest.payload || latest.metadata || null;
}

export function createCodeReviewCoverageDispatch(input = {}) {
  const artifact = latestCodeReviewCoverageArtifactFrom(input);
  if (!artifact) {
    return {
      version: "code-review-coverage-dispatch.v1",
      status: "not_configured",
      supplemental_work_packages: [],
      package_ids: [],
      issues: []
    };
  }
  const result = evaluateCodeReviewCoverageDispatch(artifact);
  return hasCoverageIdentity(artifact) || result.status !== "pass"
    ? result
    : {
        ...result,
        issues: [
          ...result.issues,
          issue("unknown_code_review_coverage_artifact_version", "code review coverage artifact must declare code-review-coverage.v1")
        ],
        status: "fail"
      };
}
