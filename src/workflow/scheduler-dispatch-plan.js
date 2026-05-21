import { decideContinuation } from "./autonomous-continuation.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function issue(code, message, path) {
  return { code, message, path };
}

function safePathPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function reviewerShardWorkPackages(decision = {}) {
  return asArray(decision.next_work_packages)
    .filter((workPackage) => normalizeToken(workPackage.action) === "run_reviewer_scope_shard");
}

function pathOrDefault(options = {}, key, fallback) {
  return normalizeString(options[key]) || fallback;
}

function reviewerMockArgs(options = {}) {
  const args = [];
  const mockStatus = normalizeString(options.reviewer_mock_status || options.reviewerMockStatus);
  const mockFindingsJson = normalizeString(options.reviewer_mock_findings_json || options.reviewerMockFindingsJson);
  if (mockStatus) args.push("--mock-status", mockStatus);
  if (mockFindingsJson) args.push("--mock-findings-json", mockFindingsJson);
  return args;
}

export function createSchedulerDispatchPlan(input = {}, options = {}) {
  const decision = input?.next_work_packages ? input : decideContinuation(input);
  const shardPackages = reviewerShardWorkPackages(decision);
  const issues = [];
  const steps = [];

  if (shardPackages.length === 0) {
    return {
      status: "pass",
      phase: "no_dispatchable_scheduler_actions",
      issues: [],
      decision,
      steps
    };
  }

  const runId = safePathPart(input?.workflow_state?.manifest?.run_id || options.run_id || "reviewer-shard-loop");
  const inputPath = normalizeString(options.workflow_state_input_path || options.workflowStateInputPath);
  const outputPath = pathOrDefault(options, "workflow_state_output_path", `tmp/scheduler/${runId}/workflow-state-after-reviewer-shards.json`);
  const runArtifactPath = pathOrDefault(options, "reviewer_shard_loop_artifact_path", `tmp/scheduler/${runId}/reviewer-shard-loop-run.json`);
  const continuationInputPath = pathOrDefault(options, "continuation_input_path", `tmp/scheduler/${runId}/continuation-input.json`);
  const historyPath = pathOrDefault(options, "history_path", `tmp/scheduler/${runId}/projection-history.json`);
  const snapshotsRoot = pathOrDefault(options, "snapshots_root", `tmp/scheduler/${runId}/snapshots`);
  const closeoutArtifactPath = pathOrDefault(options, "closeout_loop_artifact_path", `tmp/scheduler/${runId}/autonomous-closeout-loop-run.json`);

  if (!inputPath) {
    issues.push(issue("missing_workflow_state_input_path", "scheduler dispatch plan requires workflow_state_input_path for reviewer shard execution", "workflow_state_input_path"));
  }

  steps.push({
    id: "run-reviewer-shard-loop",
    action: "run_reviewer_shard_loop",
    work_package_ids: shardPackages.map((workPackage) => workPackage.id).filter(Boolean),
    command: "npm",
    args: [
      "run",
      "run:reviewer-shard",
      "--",
      "--input",
      inputPath || "<workflow-state-input>",
      "--output",
      outputPath,
      "--all",
      "--record-provider-health",
      ...reviewerMockArgs(options),
      "--run-artifact-output",
      runArtifactPath
    ],
    outputs: {
      workflow_state: outputPath,
      reviewer_shard_loop_artifact: runArtifactPath
    }
  });

  steps.push({
    id: "prepare-reviewer-shard-loop-continuation",
    action: "prepare_reviewer_shard_loop_continuation",
    depends_on: ["run-reviewer-shard-loop"],
    command: "npm",
    args: [
      "run",
      "prepare:reviewer-shard-loop-continuation",
      "--",
      "--artifact",
      runArtifactPath,
      "--output",
      continuationInputPath,
      "--next-step",
      normalizeString(options.next_step || options.nextStep) || "Continue after reviewer shard loop scheduler dispatch."
    ],
    outputs: {
      continuation_input: continuationInputPath
    }
  });

  steps.push({
    id: "run-autonomous-closeout-loop",
    action: "run_autonomous_closeout_loop",
    depends_on: ["prepare-reviewer-shard-loop-continuation"],
    command: "npm",
    args: [
      "run",
      "run:autonomous-closeout-loop",
      "--",
      "--input",
      continuationInputPath,
      "--history-path",
      historyPath,
      "--snapshots-root",
      snapshotsRoot,
      "--output",
      closeoutArtifactPath
    ],
    outputs: {
      autonomous_closeout_loop_artifact: closeoutArtifactPath
    }
  });

  return {
    status: issues.length ? "fail" : "pass",
    phase: "scheduler_dispatch_plan",
    issues,
    decision,
    steps
  };
}
