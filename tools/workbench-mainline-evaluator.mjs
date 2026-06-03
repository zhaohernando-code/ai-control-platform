import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function step03FrontendRulesPackage(node = {}) {
  const source = node.source || {};
  const implementation = normalizeString(source.implementation_step || source.implementationStep || node.reason || node.title);
  return normalizeString(node.action) === "execute_requirement_plan_step" &&
    Number(source.plan_step_index || source.planStepIndex) === 3 &&
    /antd|Ant Design/i.test(implementation) &&
    /PROJECT_RULES|前端约束|基础\/布局组件|基础组件|布局组件/.test(implementation);
}

function runPreflightCommand(root, command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: Number(options.timeout_ms || options.timeoutMs || 60000)
  });
  return {
    command: [command, ...args].join(" "),
    status: result.status === 0 ? "pass" : "fail",
    exit_code: result.status,
    stdout: normalizeString(result.stdout).slice(0, 1200),
    stderr: normalizeString(result.stderr).slice(0, 1200)
  };
}

function frontendStep03MainlineEvidence(root) {
  const requiredFiles = [
    "PROJECT_RULES.md",
    "apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md",
    "test/workbench-shell.test.js"
  ];
  const missingFiles = requiredFiles.filter((file) => !existsSync(resolve(root, file)));
  if (missingFiles.length > 0) {
    return {
      status: "not_applicable",
      issues: missingFiles.map((file) => ({ code: "mainline_evidence_file_missing", message: `${file} is missing`, path: file }))
    };
  }

  const rules = readFileSync(resolve(root, "PROJECT_RULES.md"), "utf8");
  const constraints = readFileSync(resolve(root, "apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md"), "utf8");
  const contentIssues = [];
  if (!/FRONTEND_REFACTOR_CONSTRAINTS\.md/.test(rules)) {
    contentIssues.push({ code: "project_rules_missing_frontend_constraints_link", message: "PROJECT_RULES.md must link the frontend refactor constraints", path: "PROJECT_RULES.md" });
  }
  if (!/antd|Ant Design/i.test(rules) || !/单页 app|single-page/i.test(rules)) {
    contentIssues.push({ code: "project_rules_missing_frontend_refactor_invariants", message: "PROJECT_RULES.md must codify antd and single-page app constraints", path: "PROJECT_RULES.md" });
  }
  if (!/antd|Ant Design/i.test(constraints) || !/Next\.js|App Router/i.test(constraints) || !/原有 CSS|CSS/i.test(constraints)) {
    contentIssues.push({ code: "frontend_constraints_incomplete", message: "frontend constraints document must codify antd, Next.js App Router, and CSS migration rules", path: "apps/workbench/FRONTEND_REFACTOR_CONSTRAINTS.md" });
  }
  if (contentIssues.length > 0) return { status: "not_applicable", issues: contentIssues };

  const commit = runPreflightCommand(root, "git", ["log", "--grep=step 03/7", "--format=%H", "-n", "1"], { timeout_ms: 10000 });
  const testRun = runPreflightCommand(root, process.execPath, ["--test", "test/workbench-shell.test.js"], { timeout_ms: 60000 });
  if (commit.status !== "pass" || !normalizeString(commit.stdout)) {
    return { status: "not_applicable", issues: [{ code: "step03_mainline_commit_missing", message: "no mainline commit records frontend refactor step 03/7", path: "git.log" }], command_results: [commit] };
  }
  if (testRun.status !== "pass") {
    return { status: "blocked", issues: [{ code: "step03_preflight_test_failed", message: "focused frontend rules test failed", path: "test/workbench-shell.test.js" }], command_results: [commit, testRun] };
  }

  return {
    status: "pass",
    commit: normalizeString(commit.stdout).split(/\s+/)[0],
    files: requiredFiles,
    command_results: [commit, testRun]
  };
}

export function createMainlineAlreadySatisfiedEvaluator({ root }) {
  return ({ selected_work_packages: selectedWorkPackages = [], options = {} } = {}) => {
    const selected = asArray(selectedWorkPackages);
    if (selected.length === 0 || !selected.every(step03FrontendRulesPackage)) {
      return { status: "not_applicable", phase: "mainline_already_satisfied_preflight" };
    }

    const evidence = frontendStep03MainlineEvidence(root);
    if (evidence.status !== "pass") {
      return {
        status: evidence.status === "blocked" ? "blocked" : "not_applicable",
        phase: "mainline_already_satisfied_preflight",
        issues: evidence.issues || [],
        package_results: [],
        executor_provenance: null
      };
    }

    const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
    const completionAuthority = {
      allows_work_package_completion: true,
      authority: "mainline_already_satisfied_preflight",
      evidence_kind: "focused_tests_and_mainline_commit",
      reason: "current mainline already contains the reviewed frontend rules step and focused gates pass"
    };
    return {
      status: "pass",
      phase: "mainline_already_satisfied_preflight",
      allows_work_package_completion: true,
      completion_authority: completionAuthority,
      executor_provenance: {
        executor_kind: "mainline_already_satisfied_preflight",
        execution_mode: "provider_model_routed",
        execution_profile: "mainline_already_satisfied_preflight",
        external_calls: 0,
        deterministic: true,
        created_at: createdAt
      },
      package_results: selected.map((node) => ({
        work_package_id: node.id,
        status: "pass",
        result: "already_satisfied_by_mainline",
        completed_at: createdAt,
        allows_work_package_completion: true,
        completion_authority: completionAuthority,
        completion_evidence: {
          kind: "mainline_already_satisfied_preflight",
          commit: evidence.commit,
          files: evidence.files,
          command_results: evidence.command_results
        }
      })),
      issues: []
    };
  };
}
