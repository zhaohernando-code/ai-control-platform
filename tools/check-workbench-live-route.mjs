#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import { evaluateWorkbenchLiveRouteAcceptance } from "../src/workflow/live-route-acceptance.js";

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`failed to read ${label} JSON at ${path}: ${error.message}`);
  }
}

function parseArgs(argv) {
  const options = {
    projectStatusPath: "PROJECT_STATUS.json",
    evidencePath: "",
    evidenceSource: "",
    evidenceMetadata: {},
    now: "",
    maxEvidenceAgeMs: undefined
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-status") {
      options.projectStatusPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--evidence") {
      options.evidencePath = argv[index + 1] || "";
      options.evidenceSource = "argv";
      index += 1;
    } else if (arg === "--now") {
      options.now = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--max-evidence-age-ms") {
      options.maxEvidenceAgeMs = Number(argv[index + 1]);
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return options;
}

function usage() {
  return [
    "usage: check-workbench-live-route.mjs [--project-status PROJECT_STATUS.json] [--evidence evidence.json]",
    "                                      [--now ISO_TIMESTAMP] [--max-evidence-age-ms MS]",
    "",
    "The gate fails closed when PROJECT_STATUS has unresolved public/canonical workbench live-route blockers.",
    "Set --evidence or WORKBENCH_LIVE_ROUTE_EVIDENCE to a verified public-route evidence artifact to unblock it.",
    "When neither is provided, the gate can read PROJECT_STATUS.workbench_live_route_evidence.path.",
    "Evidence for unresolved blockers must be fresh and newer than the current PROJECT_STATUS route-blocker state."
  ].join("\n");
}

function durableEvidenceDescriptorFromProjectStatus(projectStatus = {}) {
  const candidates = [
    projectStatus.workbench_live_route_evidence,
    projectStatus.workbenchLiveRouteEvidence,
    projectStatus.live_route_evidence,
    projectStatus.liveRouteEvidence
  ];

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (typeof candidate === "string") {
      const path = candidate.trim();
      if (path) return { path, metadata: {} };
    }
    if (typeof candidate === "object" && !Array.isArray(candidate)) {
      const explicitPath = String(candidate.path || candidate.artifact_path || candidate.artifactPath || "").trim();
      if (explicitPath) return { path: explicitPath, metadata: candidate };
    }
  }

  return { path: "", metadata: {} };
}

function resolveEvidencePath(evidencePath, projectStatusPath) {
  if (!evidencePath) return "";
  return isAbsolute(evidencePath) ? evidencePath : resolve(dirname(resolve(projectStatusPath)), evidencePath);
}

let options;
try {
  options = parseArgs(process.argv.slice(2));
} catch (error) {
  console.error(error.message);
  console.error(usage());
  process.exit(2);
}

if (options.help) {
  console.log(usage());
  process.exit(0);
}

if (!options.projectStatusPath) {
  console.error("missing --project-status path");
  process.exit(2);
}

try {
  const projectStatus = readJson(options.projectStatusPath, "project status");
  if (!options.evidencePath && process.env.WORKBENCH_LIVE_ROUTE_EVIDENCE) {
    options.evidencePath = process.env.WORKBENCH_LIVE_ROUTE_EVIDENCE;
    options.evidenceSource = "env";
  }
  if (!options.evidencePath) {
    const durableEvidence = durableEvidenceDescriptorFromProjectStatus(projectStatus);
    options.evidencePath = durableEvidence.path;
    options.evidenceMetadata = durableEvidence.metadata;
    options.evidenceSource = options.evidencePath ? "project_status" : "";
  }

  const resolvedEvidencePath = resolveEvidencePath(options.evidencePath, options.projectStatusPath);
  if (resolvedEvidencePath && !existsSync(resolvedEvidencePath)) {
    throw new Error(`live route evidence from ${options.evidenceSource} does not exist at ${resolvedEvidencePath}`);
  }

  const evidenceArtifact = resolvedEvidencePath ? readJson(resolvedEvidencePath, "live route evidence") : null;
  const result = evaluateWorkbenchLiveRouteAcceptance({
    projectStatus,
    evidenceArtifact,
    evidenceMetadata: options.evidenceMetadata,
    now: options.now,
    maxEvidenceAgeMs: options.maxEvidenceAgeMs
  });
  if (resolvedEvidencePath) {
    result.evidence_path = options.evidencePath;
    result.evidence_resolved_path = resolvedEvidencePath;
    result.evidence_source = options.evidenceSource;
  }

  console.log(JSON.stringify(result, null, 2));

  if (result.status !== "pass") {
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
