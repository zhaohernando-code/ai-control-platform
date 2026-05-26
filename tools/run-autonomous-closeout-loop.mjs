#!/usr/bin/env node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import {
  createAutonomousLoopRunArtifact,
  prepareAutonomousContinuationFromLoopArtifact,
  runAutonomousCloseoutLoop,
  runAutonomousContinuationCycle
} from "../src/workflow/autonomous-orchestrator.js";
import { publishWorkbenchSnapshot } from "../src/workflow/workbench-snapshots.js";
import { localOutputPathIssues, platformRootIssues } from "../src/workflow/closeout-runner.js";

function valueAfter(flag, args) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : "";
}

function usage() {
  return [
    "Usage: node tools/run-autonomous-closeout-loop.mjs --input <loop-input.json>",
    "       node tools/run-autonomous-closeout-loop.mjs --resume-from <autonomous-closeout-loop-run.v1.json>",
    "",
    "Options:",
    "  --history-path <path>",
    "  --snapshots-root <path>",
    "  --output <path>       Write replayable input/output envelope JSON",
    "  --resume-from <path>  Validate replay artifact and emit scheduler continuation input",
    "  --cycle               Chain iterations automatically when next_decision.should_continue is true",
    "  --max-iterations <n>  Maximum iterations when --cycle is used (default 5, hard cap 25)"
  ].join("\n");
}

function blockedResumeResult(code, message, path = "resume_from") {
  return {
    status: "blocked",
    phase: "replay_validation",
    should_continue: false,
    issues: [{ code, message, path }],
    blockers: [
      {
        id: "autonomous_loop_artifact_replay",
        category: "replay_artifact_invalid",
        status: "blocked",
        message: "autonomous closeout loop artifact failed replay validation",
        issues: [{ code, message, path }]
      }
    ],
    continuation_input: null,
    context_pack_seed: null,
    snapshot_publish_plan: null,
    next_decision: null
  };
}

function defaultHistoryPath(root) {
  return resolve(root, "docs/examples/projection-history.json");
}

function defaultSnapshotsRoot(root) {
  return resolve(root, "docs/examples/snapshots");
}

function publishResumeWorkflowState(result, args) {
  if (!result.workflow_state) return result;

  const root = resolve(process.cwd());
  const historyPath = resolve(valueAfter("--history-path", args) || defaultHistoryPath(root));
  const snapshotsRoot = resolve(valueAfter("--snapshots-root", args) || defaultSnapshotsRoot(root));
  const boundaryIssues = [
    ...platformRootIssues(root),
    ...localOutputPathIssues(root, historyPath, snapshotsRoot)
  ];

  if (boundaryIssues.length > 0) {
    return {
      ...result,
      snapshot_publish: {
        status: "fail",
        issues: boundaryIssues
      }
    };
  }

  const snapshotId = result.workflow_state.manifest?.run_id || "autonomous-loop-replay-blocked";
  const publish = publishWorkbenchSnapshot({
    id: snapshotId,
    label: "Autonomous loop replay validation blocked",
    input: result.workflow_state
  }, {
    root,
    historyPath,
    snapshotsRoot
  });

  return {
    ...result,
    snapshot_publish: publish
  };
}

function printResult(result) {
  console.log(JSON.stringify(result, null, 2));
  if (!["pass", "ready"].includes(result.status)) {
    process.exitCode = 1;
  }
}

const args = process.argv.slice(2);
const inputPath = valueAfter("--input", args);
const resumePath = valueAfter("--resume-from", args);
if ((!inputPath && !resumePath) || args.includes("--help") || args.includes("-h")) {
  console.error(usage());
  process.exit(inputPath || resumePath ? 0 : 1);
}
if (inputPath && resumePath) {
  printResult(blockedResumeResult("ambiguous_autonomous_loop_mode", "--input and --resume-from cannot be used together", "mode"));
} else if (resumePath) {
  let resume;
  try {
    const artifact = JSON.parse(readFileSync(resolve(resumePath), "utf8"));
    resume = prepareAutonomousContinuationFromLoopArtifact(artifact);
  } catch (error) {
    resume = blockedResumeResult("replay_artifact_read_failed", error.message, "resume_from");
  }
  printResult(publishResumeWorkflowState(resume, args));
} else {
  const input = JSON.parse(readFileSync(resolve(inputPath), "utf8"));
  const cycleMode = args.includes("--cycle");
  const orchestratorOptions = {
    root: process.cwd(),
    historyPath: valueAfter("--history-path", args) || undefined,
    snapshotsRoot: valueAfter("--snapshots-root", args) || undefined
  };

  if (cycleMode) {
    const maxIterationsArg = valueAfter("--max-iterations", args);
    const cycle = await runAutonomousContinuationCycle(input, {
      ...orchestratorOptions,
      max_iterations: maxIterationsArg ? Number.parseInt(maxIterationsArg, 10) : undefined
    });
    const summary = {
      status: cycle.status,
      stop_reason: cycle.stop_reason,
      total_iterations: cycle.total_iterations,
      max_iterations: cycle.max_iterations,
      iterations: cycle.iterations,
      last_phase: cycle.last_result?.phase || null,
      last_next_should_continue: cycle.last_result?.next_decision?.should_continue ?? null
    };
    const outputPath = valueAfter("--output", args);
    if (outputPath && cycle.last_result) {
      const artifact = createAutonomousLoopRunArtifact(input, cycle.last_result);
      const resolvedOutputPath = resolve(outputPath);
      mkdirSync(dirname(resolvedOutputPath), { recursive: true });
      writeFileSync(resolvedOutputPath, `${JSON.stringify(artifact, null, 2)}\n`);
      summary.output = outputPath;
    }
    console.log(JSON.stringify(summary, null, 2));
    if (cycle.status !== "pass") {
      process.exitCode = 1;
    }
  } else {
    const result = await runAutonomousCloseoutLoop(input, orchestratorOptions);
    const artifact = createAutonomousLoopRunArtifact(input, result);
    const outputPath = valueAfter("--output", args);

    if (outputPath) {
      const resolvedOutputPath = resolve(outputPath);
      mkdirSync(dirname(resolvedOutputPath), { recursive: true });
      writeFileSync(resolvedOutputPath, `${JSON.stringify(artifact, null, 2)}\n`);
    }

    console.log(JSON.stringify(outputPath ? {
      status: artifact.status,
      phase: artifact.phase,
      output: outputPath
    } : result, null, 2));
    if (result.status !== "pass") {
      process.exitCode = 1;
    }
  }
}
