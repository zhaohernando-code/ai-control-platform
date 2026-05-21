#!/usr/bin/env node
import { readFileSync } from "node:fs";

import { validateProjectOnboardingSync } from "../src/workflow/project-onboarding-sync.js";

const [, , manifestPath, workspaceIndexPath] = process.argv;

if (!manifestPath || !workspaceIndexPath) {
  console.error("usage: check-project-onboarding-sync.mjs <project-manifest.json> <WORKSPACE_INDEX.json>");
  process.exit(2);
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const workspaceIndex = JSON.parse(readFileSync(workspaceIndexPath, "utf8"));
const result = validateProjectOnboardingSync({ manifest, workspaceIndex });

console.log(JSON.stringify(result, null, 2));

if (result.status !== "pass") {
  process.exit(1);
}

