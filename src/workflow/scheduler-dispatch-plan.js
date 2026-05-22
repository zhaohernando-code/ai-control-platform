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

function agentLifecycleCleanupWorkPackages(decision = {}) {
  return asArray(decision.next_work_packages)
    .filter((workPackage) => normalizeToken(workPackage.action) === "cleanup_agent_lifecycle_pool");
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

function writebackConfig(options = {}, issues = []) {
  const mode = normalizeToken(options.workbench_writeback_mode || options.workbenchWritebackMode || (options.workbench_base_url || options.workbenchBaseUrl ? "service" : "none"));
  const baseUrl = normalizeString(options.workbench_base_url || options.workbenchBaseUrl);
  const projectionId = normalizeString(options.projection_id || options.projectionId);

  if (!["none", "service"].includes(mode)) {
    issues.push(issue("unsupported_workbench_writeback_mode", "workbench writeback mode must be none or service", "workbench_writeback_mode"));
  }
  if (mode === "service" && !baseUrl) {
    issues.push(issue("missing_workbench_base_url", "service writeback requires workbench_base_url", "workbench_base_url"));
  }

  return mode === "service"
    ? {
      mode: "service",
      base_url: baseUrl,
      projection_id: projectionId || null
    }
    : { mode: "none" };
}

export function createSchedulerDispatchPlan(input = {}, options = {}) {
  const decision = input?.next_work_packages ? input : decideContinuation(input);
  const shardPackages = reviewerShardWorkPackages(decision);
  const cleanupPackages = agentLifecycleCleanupWorkPackages(decision);
  const issues = [];
  const steps = [];

  if (shardPackages.length === 0 && cleanupPackages.length === 0) {
    return {
      status: "pass",
      phase: "no_dispatchable_scheduler_actions",
      dispatch_kind: "none",
      issues: [],
      decision,
      steps
    };
  }

  if (shardPackages.length > 0 && cleanupPackages.length > 0) {
    return {
      status: "fail",
      phase: "scheduler_dispatch_plan",
      dispatch_kind: "mixed",
      issues: [
        issue(
          "mixed_scheduler_dispatch_actions",
          "reviewer shard dispatch and agent lifecycle cleanup must be planned in separate scheduler turns",
          "next_work_packages"
        )
      ],
      decision,
      steps
    };
  }

  const runId = safePathPart(input?.workflow_state?.manifest?.run_id || options.run_id || "reviewer-shard-loop");
  const inputPath = normalizeString(options.workflow_state_input_path || options.workflowStateInputPath);
  const outputPath = pathOrDefault(options, "workflow_state_output_path", `tmp/scheduler/${runId}/workflow-state-after-reviewer-shards.json`);
  const cleanupOutputPath = pathOrDefault(options, "agent_lifecycle_cleanup_output_path", `tmp/scheduler/${runId}/workflow-state-after-agent-lifecycle-cleanup.json`);
  const runArtifactPath = pathOrDefault(options, "reviewer_shard_loop_artifact_path", `tmp/scheduler/${runId}/reviewer-shard-loop-run.json`);
  const continuationInputPath = pathOrDefault(options, "continuation_input_path", `tmp/scheduler/${runId}/continuation-input.json`);
  const schedulerContinuationOutputPath = pathOrDefault(options, "scheduler_continuation_output_path", `tmp/scheduler/${runId}/scheduler-dispatch-continuation-input.json`);
  const historyPath = pathOrDefault(options, "history_path", `tmp/scheduler/${runId}/projection-history.json`);
  const snapshotsRoot = pathOrDefault(options, "snapshots_root", `tmp/scheduler/${runId}/snapshots`);
  const closeoutArtifactPath = pathOrDefault(options, "closeout_loop_artifact_path", `tmp/scheduler/${runId}/autonomous-closeout-loop-run.json`);
  const writeback = writebackConfig(options, issues);

  if (!inputPath) {
    issues.push(issue("missing_workflow_state_input_path", "scheduler dispatch plan requires workflow_state_input_path for executable scheduler actions", "workflow_state_input_path"));
  }

  if (shardPackages.length > 0) {
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
  }

  if (cleanupPackages.length > 0) {
    steps.push({
      id: "cleanup-agent-lifecycle-pool",
      action: "cleanup_agent_lifecycle_pool",
      work_package_ids: cleanupPackages.map((workPackage) => workPackage.id).filter(Boolean),
      command: "npm",
      args: [
        "run",
        "record:agent-lifecycle-pool",
        "--",
        "--input",
        inputPath || "<workflow-state-input>",
        "--output",
        cleanupOutputPath,
        "--cleanup-latest-pool"
      ],
      outputs: {
        workflow_state: cleanupOutputPath,
        agent_lifecycle_cleanup: cleanupOutputPath
      }
    });
  }

  return {
    status: issues.length ? "fail" : "pass",
    phase: "scheduler_dispatch_plan",
    dispatch_kind: cleanupPackages.length > 0 ? "agent_lifecycle_cleanup" : "reviewer_shard_loop",
    issues,
    decision,
    writeback,
    continuation_output: cleanupPackages.length > 0
      ? { mode: "none" }
      : {
        mode: "file",
        path: schedulerContinuationOutputPath
      },
    steps
  };
}
