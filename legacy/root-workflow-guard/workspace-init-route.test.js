"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

const {
  maybeResolveTaskWorkspaceRoute,
  resolveWorkspaceRoute,
} = require("./workspace-init-route");

function writeWorkspaceIndex(rootDir) {
  const index = {
    workspace_root: rootDir,
    projects: [
      {
        project_id: "ai-control-platform",
        display_name: "AI Control Platform",
        aliases: ["新中台", "中台", "自动化平台"],
        keywords: ["platform core", "任务编排", "recovery engine", "llm reviewer"],
        repo_path: path.join(rootDir, "projects", "ai-control-platform"),
        runtime_path: null,
        entry_routes: {},
        project_type: "platform-core",
        canonical_docs: [
          path.join(rootDir, "projects", "ai-control-platform", "PROJECT_STATUS.json"),
          path.join(rootDir, "projects", "ai-control-platform", "README.md"),
        ],
      },
      {
        project_id: "stock_dashboard",
        display_name: "Ashare Dashboard",
        aliases: ["股票看板", "a股看板", "ashare dashboard"],
        keywords: ["股票", "专业性", "评估", "行情"],
        repo_path: path.join(rootDir, "projects", "stock_dashboard"),
        runtime_path: path.join(rootDir, "runtime", "projects", "ashare-dashboard"),
        entry_routes: {
          user: "https://hernando-zhao.cn/stocks",
          canonical: "https://hernando-zhao.cn/projects/ashare-dashboard/",
        },
        project_type: "business-dashboard",
        canonical_docs: [
          path.join(rootDir, "projects", "stock_dashboard", "PROJECT_STATUS.json"),
          path.join(rootDir, "projects", "stock_dashboard", "README.md"),
        ],
      },
    ],
  };
  fs.writeFileSync(path.join(rootDir, "WORKSPACE_INDEX.json"), `${JSON.stringify(index, null, 2)}\n`);
}

test("resolveWorkspaceRoute identifies stock_dashboard from a fuzzy stock-quality query", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-route-"));
  try {
    writeWorkspaceIndex(rootDir);
    const route = resolveWorkspaceRoute("继续评估股票专业性", rootDir);
    assert.ok(route);
    assert.equal(route.best.project.project_id, "stock_dashboard");
    assert.match(route.best.reasons.join("\n"), /股票|专业性|评估/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("resolveWorkspaceRoute routes new middle-platform work to ai-control-platform", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-route-"));
  try {
    writeWorkspaceIndex(rootDir);
    const route = resolveWorkspaceRoute("建立一个全新的中台仓库，防止跑偏，并实现任务编排门禁", rootDir);
    assert.ok(route);
    assert.equal(route.best.project.project_id, "ai-control-platform");
    assert.match(route.best.reasons.join("\n"), /中台|任务编排/);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("maybeResolveTaskWorkspaceRoute maps workspace project paths back to state projects", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-route-"));
  try {
    writeWorkspaceIndex(rootDir);
    const route = maybeResolveTaskWorkspaceRoute(
      {
        title: "继续评估股票专业性",
        description: "关注股票看板的专业性表达和可信度。",
      },
      {
        projects: [
          {
            id: "ashare-dashboard",
            path: path.join(rootDir, "projects", "stock_dashboard"),
          },
        ],
      },
      rootDir,
    );
    assert.ok(route);
    assert.equal(route.workspaceProjectId, "stock_dashboard");
    assert.equal(route.resolvedProjectId, "ashare-dashboard");
    assert.equal(route.canonicalDocs.length, 2);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test("maybeResolveTaskWorkspaceRoute keeps stock routing stable when the task wrapper includes generic English instructions", () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-workspace-route-"));
  try {
    writeWorkspaceIndex(rootDir);
    const route = maybeResolveTaskWorkspaceRoute(
      {
        title: "Smoke check after main merge: 继续评估股票专业性",
        description: "Routing verification after merging to main. Keep blocked for approval only and cancel after route validation.",
      },
      {
        projects: [
          {
            id: "ashare-dashboard",
            path: path.join(rootDir, "projects", "stock_dashboard"),
          },
          {
            id: "lobechat",
            path: path.join(rootDir, "projects", "lobechat"),
          },
        ],
      },
      rootDir,
    );
    assert.ok(route);
    assert.equal(route.workspaceProjectId, "stock_dashboard");
    assert.equal(route.resolvedProjectId, "ashare-dashboard");
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
