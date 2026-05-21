import assert from "node:assert/strict";
import test from "node:test";

import { validateProjectOnboardingSync } from "../src/workflow/project-onboarding-sync.js";

const manifest = {
  project_id: "ai-control-platform",
  project_type: "platform-core",
  aliases: ["新中台", "中台", "AI中台"]
};

function workspaceProject(overrides = {}) {
  return {
    project_id: "ai-control-platform",
    display_name: "AI Control Platform",
    aliases: ["新中台", "中台"],
    project_type: "platform-core",
    canonical_docs: [
      "/repo/README.md",
      "/repo/PROJECT_RULES.md",
      "/repo/PROCESS.md",
      "/repo/PROJECT_STATUS.json",
      "/repo/DECISIONS.md",
      "/repo/PROJECT_PLAN.md"
    ],
    ...overrides
  };
}

test("project onboarding sync passes when manifest and workspace index agree", () => {
  const result = validateProjectOnboardingSync({
    manifest,
    workspaceIndex: { projects: [workspaceProject()] }
  });

  assert.equal(result.status, "pass");
  assert.deepEqual(result.issues, []);
});

test("project onboarding sync fails when workspace index misses the project", () => {
  const result = validateProjectOnboardingSync({
    manifest,
    workspaceIndex: { projects: [] }
  });

  assert.equal(result.status, "fail");
  assert.equal(result.issues[0].code, "workspace_index_missing_project");
});

test("project onboarding sync catches missing canonical docs and alias drift", () => {
  const result = validateProjectOnboardingSync({
    manifest,
    workspaceIndex: {
      projects: [
        workspaceProject({
          aliases: ["platform"],
          canonical_docs: ["/repo/README.md"]
        })
      ]
    }
  });

  assert.equal(result.status, "fail");
  assert.ok(result.issues.some((issue) => issue.code === "aliases_not_synced"));
  assert.ok(result.issues.some((issue) => issue.message.includes("PROJECT_RULES.md")));
});

