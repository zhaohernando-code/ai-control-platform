#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { validateAutonomousLoopRunArtifact } from "../src/workflow/autonomous-orchestrator.js";

function usage() {
  return "usage: check-autonomous-closeout-loop-run.mjs <autonomous-closeout-loop-run.v1.json>";
}

const inputPath = process.argv[2];
if (!inputPath || process.argv.includes("--help") || process.argv.includes("-h")) {
  console.error(usage());
  process.exit(inputPath ? 0 : 2);
}

let artifact;
try {
  artifact = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
} catch (error) {
  console.log(JSON.stringify({
    status: "fail",
    issues: [
      {
        code: "artifact_read_failed",
        message: error.message,
        path: inputPath
      }
    ]
  }, null, 2));
  process.exit(1);
}

const validation = validateAutonomousLoopRunArtifact(artifact);
console.log(JSON.stringify(validation, null, 2));

if (validation.status !== "pass") {
  process.exit(1);
}
