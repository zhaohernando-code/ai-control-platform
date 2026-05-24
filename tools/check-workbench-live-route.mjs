#!/usr/bin/env node
import { readFileSync } from "node:fs";

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
    evidencePath: process.env.WORKBENCH_LIVE_ROUTE_EVIDENCE || ""
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-status") {
      options.projectStatusPath = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--evidence") {
      options.evidencePath = argv[index + 1] || "";
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
    "",
    "The gate fails closed when PROJECT_STATUS has unresolved public/canonical workbench live-route blockers.",
    "Set --evidence or WORKBENCH_LIVE_ROUTE_EVIDENCE to a verified public-route evidence artifact to unblock it."
  ].join("\n");
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
  const evidenceArtifact = options.evidencePath ? readJson(options.evidencePath, "live route evidence") : null;
  const result = evaluateWorkbenchLiveRouteAcceptance({
    projectStatus,
    evidenceArtifact
  });

  console.log(JSON.stringify(result, null, 2));

  if (result.status !== "pass") {
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
