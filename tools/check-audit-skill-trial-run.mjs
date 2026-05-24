#!/usr/bin/env node
import { readFileSync } from "node:fs";

import {
  DEFAULT_AUDIT_PROJECT_ROOT,
  evaluateAuditSkillTrialRun
} from "../src/workflow/audit-skill-trial-run.js";

function usage() {
  return [
    "usage: check-audit-skill-trial-run.mjs <artifact.json> [--project-root <path>]",
    "",
    "Validates audit-skill-trial-run.v1 evidence before closeout."
  ].join("\n");
}

function parseArgs(argv) {
  const options = { projectRoot: DEFAULT_AUDIT_PROJECT_ROOT };
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project-root") {
      options.projectRoot = argv[index + 1] || "";
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown argument: ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  options.artifactPath = positional[0] || "";
  return options;
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

if (!options.artifactPath) {
  console.error("missing artifact path");
  console.error(usage());
  process.exit(2);
}

try {
  const artifact = JSON.parse(readFileSync(options.artifactPath, "utf8"));
  const result = evaluateAuditSkillTrialRun(artifact, {
    expectedProjectRoot: options.projectRoot
  });
  console.log(JSON.stringify(result, null, 2));
  if (result.status !== "pass") {
    process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
