import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { prepareAutonomousContinuationFromLoopArtifact } from "./autonomous-orchestrator.js";
import { SCHEDULER_DISPATCH_RUN_VERSION } from "./scheduler-dispatch-runner.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function issue(code, message, path) {
  return { code, message, path };
}

function closeoutLoopOutput(runArtifact = {}) {
  return asArray(runArtifact?.result?.steps)
    .find((step) => step?.id === "run-autonomous-closeout-loop")
    ?.outputs?.autonomous_closeout_loop_artifact || null;
}

function blocked(issues, runArtifact = {}) {
  return {
    status: "blocked",
    phase: "scheduler_dispatch_continuation",
    should_continue: false,
    issues,
    blockers: [
      {
        id: "scheduler_dispatch_continuation",
        category: "scheduler_dispatch_replay_invalid",
        status: "blocked",
        message: "scheduler dispatch run artifact cannot produce next continuation",
        issues
      }
    ],
    scheduler_dispatch: {
      run_id: runArtifact?.run_id || null,
      cycle_id: runArtifact?.cycle_id || null,
      status: runArtifact?.status || null,
      phase: runArtifact?.phase || null
    },
    continuation_input: null,
    context_pack_seed: null,
    snapshot_publish_plan: null,
    next_decision: null
  };
}

export function prepareSchedulerDispatchContinuationFromRunArtifact(runArtifact = {}) {
  if (!runArtifact || typeof runArtifact !== "object" || Array.isArray(runArtifact)) {
    return blocked([issue("invalid_scheduler_dispatch_run_artifact", "scheduler dispatch run artifact must be an object", "run_artifact")]);
  }
  if (runArtifact.version !== SCHEDULER_DISPATCH_RUN_VERSION) {
    return blocked([issue("invalid_scheduler_dispatch_run_version", "run artifact version must be scheduler-dispatch-run.v1", "version")], runArtifact);
  }
  if (runArtifact.status !== "pass") {
    return blocked([issue("non_reusable_scheduler_dispatch_status", "only pass scheduler dispatch artifacts can produce next continuation", "status")], runArtifact);
  }

  const output = closeoutLoopOutput(runArtifact);
  if (!output?.path) {
    return blocked([issue("missing_closeout_loop_output_path", "scheduler dispatch run must include run-autonomous-closeout-loop output path", "result.steps")], runArtifact);
  }
  if (output.status && output.status !== "available") {
    return blocked([issue("unavailable_closeout_loop_output", "run-autonomous-closeout-loop output must be available", "result.steps.outputs.autonomous_closeout_loop_artifact")], runArtifact);
  }

  let closeoutArtifact;
  try {
    closeoutArtifact = JSON.parse(readFileSync(resolve(output.path), "utf8"));
  } catch (error) {
    return blocked([issue("closeout_loop_artifact_read_failed", error.message, "result.steps.outputs.autonomous_closeout_loop_artifact.path")], runArtifact);
  }

  const prepared = prepareAutonomousContinuationFromLoopArtifact(closeoutArtifact);
  if (prepared.status !== "ready") {
    return blocked(prepared.issues || [issue("closeout_loop_artifact_not_reusable", "closeout loop artifact cannot resume scheduler continuation", "closeout_loop_artifact")], runArtifact);
  }

  return {
    ...prepared,
    phase: "scheduler_dispatch_continuation",
    scheduler_dispatch: {
      run_id: runArtifact.run_id || null,
      cycle_id: runArtifact.cycle_id || null,
      status: runArtifact.status,
      phase: runArtifact.phase,
      closeout_loop_artifact_path: output.path,
      next_work_package_count: asArray(prepared.next_decision?.next_work_packages).length
    }
  };
}

export { closeoutLoopOutput };
