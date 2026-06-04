import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import { completeRequirementInProjectStatus } from "./requirement-intake.js";
import {
  DEVELOPMENT_FLOW_EVALUATION_VERSION,
  evaluateDevelopmentFlowArtifact
} from "./development-flow-evaluation.js";
import {
  createFixture,
  gitChangedFilesSince,
  gitDiffStat,
  gitHead,
  runFixtureTests
} from "./development-flow-real-fixture.js";
import { OUTPUT_SCHEMA, outputContract, parseModelJson } from "./development-flow-real-model-output.js";
import {
  buildRequirementFlow,
  classifyFailure,
  commandAudit,
  createClaudeCommand,
  createCodexCommand,
  promptFor
} from "./development-flow-real-command.js";
import { runContextProviderC2CGovernance } from "./development-flow-real-provider-c2c.js";

export { runContextProviderC2CGovernance };
export const DEVELOPMENT_FLOW_REAL_VERSION = "development-flow-real.v1";

const DEFAULT_TIMEOUT_MS = 240000;

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function now() {
  return new Date().toISOString();
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function issue(code, message, path = "") {
  return { code, message, path };
}

function appendPhase(trace, phase, status = "pass", evidenceId = phase, metadata = {}) {
  trace.push({
    phase,
    status,
    evidence_id: evidenceId,
    recorded_at: now(),
    ...metadata
  });
}

function executeCommand(command, options = {}, context = {}) {
  const timeout = Number(options.timeout_ms || process.env.DEV_FLOW_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
  if (options.commandRunner) {
    return options.commandRunner({
      command: command.command,
      args: command.args,
      cwd: context.fixtureDir,
      timeout,
      run_id: context.runId,
      fixture_dir: context.fixtureDir,
      prompt: context.prompt,
      env: command.env
    });
  }
  return spawnSync(command.command, command.args, {
    cwd: context.fixtureDir,
    encoding: "utf8",
    timeout,
    env: command.env || process.env
  });
}

function reviewGuard({ changedFiles, fixtureDir, contract }) {
  const issues = [];
  if (!changedFiles.includes("src/math.js")) {
    issues.push(issue("fixture_expected_file_not_changed", "src/math.js must be changed", "diff_summary.changed_files"));
  }
  for (const file of changedFiles) {
    if (file !== "src/math.js") {
      issues.push(issue("fixture_unexpected_file_changed", `${file} is outside the allowed fixture edit set`, "diff_summary.changed_files"));
    }
  }
  if (safeRead(join(fixtureDir, "src", "math.js")).includes("a - b")) {
    issues.push(issue("fixture_bug_still_present", "src/math.js still contains the broken subtraction implementation", "src/math.js"));
  }
  if (contract.status !== "pass") {
    issues.push(...asArray(contract.issues));
  }
  return {
    status: issues.length === 0 ? "pass" : "fail",
    issues
  };
}

export function runDevelopmentFlowCliChain(runId, options = {}) {
  const root = options.root_dir || mkdtempSync(join(tmpdir(), "development-flow-real-"));
  const fixtureDir = createFixture(root, runId);
  const baselineCommit = gitHead(fixtureDir);
  const phaseTrace = [];
  const createdAt = now();
  const evidence = {};
  const issues = [];

  const requirementFlow = buildRequirementFlow(runId, createdAt);
  evidence.requirement = requirementFlow.requirement;
  appendPhase(phaseTrace, "requirement_submitted", "pass", `${runId}:requirement`);
  evidence.plan = requirementFlow.plan_review;
  appendPhase(phaseTrace, "plan_generated", "pass", `${runId}:plan`);
  appendPhase(phaseTrace, "plan_approved", "pass", `${runId}:plan_approval`);
  evidence.work_packages = requirementFlow.work_packages;
  appendPhase(phaseTrace, "work_packages_created", requirementFlow.work_packages.length > 0 ? "pass" : "fail", `${runId}:work_packages`, {
    work_package_count: requirementFlow.work_packages.length
  });

  const initialTest = runFixtureTests(fixtureDir);
  evidence.initial_test = initialTest;
  const prompt = promptFor(runId, fixtureDir);
  const schemaPath = join(fixtureDir, "development-flow-output.schema.json");
  const codexOutputPath = join(fixtureDir, "codex-last-message.json");
  writeJson(schemaPath, OUTPUT_SCHEMA);

  const command = runId === "codex_cli"
    ? createCodexCommand({ fixtureDir, prompt, schemaPath, outputPath: codexOutputPath, options })
    : createClaudeCommand({ fixtureDir, prompt, options });
  if (command.planning_status && command.planning_status !== "pass") {
    issues.push(issue("agent_invocation_plan_failed", "development flow could not create a governed agent invocation plan", "agent_invocation"));
  }
  const agentSelection = {
    agent_id: command.agent_id,
    runner: command.runner,
    provider: command.provider,
    model: command.model,
    role: "code_landing",
    profile_id: command.profile_id || null
  };
  appendPhase(phaseTrace, "agent_selected", "pass", `${runId}:agent_selection`, agentSelection);

  const startedAt = Date.now();
  const result = command.planning_status && command.planning_status !== "pass"
    ? { status: 1, stdout: "", stderr: JSON.stringify(command.planning_issues || []) }
    : executeCommand(command, options, { runId, fixtureDir, prompt });
  const latencyMs = Date.now() - startedAt;
  const stdout = normalizeString(result?.stdout);
  const stderr = normalizeString(result?.stderr);
  const outputText = runId === "codex_cli" && existsSync(codexOutputPath)
    ? safeRead(codexOutputPath)
    : stdout;
  const parsed = parseModelJson(outputText || stdout);
  const contract = outputContract(parsed);
  const commandPassed = Number(result?.status ?? result?.exitCode ?? (result?.error ? 1 : 0)) === 0 && !result?.error;
  const cliStatus = commandPassed && contract.status === "pass" ? "pass" : "fail";
  if (cliStatus !== "pass") {
    issues.push(issue(classifyFailure(runId, { stdout, stderr, status: result?.status, error: result?.error }, parsed, contract), "real CLI execution did not complete the fixture contract", "cli_child_worker"));
  }
  appendPhase(phaseTrace, "cli_child_worker_executed", cliStatus, `${runId}:cli_child_worker`, {
    exit_code: result?.status ?? result?.exitCode ?? null,
    latency_ms: latencyMs
  });

  const changedFiles = gitChangedFilesSince(fixtureDir, baselineCommit);
  const diffSummary = {
    has_diff: changedFiles.length > 0,
    changed_files: changedFiles,
    stat: gitDiffStat(fixtureDir)
  };
  appendPhase(phaseTrace, "code_landed", diffSummary.has_diff ? "pass" : "fail", `${runId}:diff`, {
    changed_files: changedFiles
  });

  const finalTest = runFixtureTests(fixtureDir);
  appendPhase(phaseTrace, "acceptance_checked", finalTest.status, `${runId}:acceptance`, {
    command: finalTest.command
  });

  const guard = reviewGuard({ changedFiles, fixtureDir, contract });
  appendPhase(phaseTrace, "review_guard_checked", guard.status, `${runId}:review_guard`);

  let finalProjectStatus = requirementFlow.project_status;
  if (finalTest.status === "pass" && guard.status === "pass") {
    const completion = completeRequirementInProjectStatus(finalProjectStatus, {
      requirement_id: requirementFlow.requirement.id
    }, { created_at: now() });
    if (completion.status === "pass") finalProjectStatus = completion.project_status;
  }
  const closeout = {
    status: finalTest.status === "pass" && guard.status === "pass" ? "pass" : "fail",
    requirement_id: requirementFlow.requirement.id,
    fixture_dir: fixtureDir
  };
  appendPhase(phaseTrace, "closeout_published", closeout.status, `${runId}:closeout`);
  const projection = {
    status: closeout.status,
    requirement_id: requirementFlow.requirement.id,
    plan_phase: finalProjectStatus.plan_reviews?.[requirementFlow.requirement.id]?.phase || null,
    fixture_changed_files: changedFiles
  };
  appendPhase(phaseTrace, "projection_verified", projection.status, `${runId}:projection`);

  const run = {
    id: runId,
    status: cliStatus === "pass" && finalTest.status === "pass" && guard.status === "pass" ? "pass" : "fail",
    fixture_dir: fixtureDir,
    phase_trace: phaseTrace,
    agent_selection: agentSelection,
    model_provenance: {
      runner: command.runner,
      provider: command.provider,
      model: command.model,
      real_model_call: true,
      external_calls: 1,
      deterministic: false,
      command_audit: commandAudit({ command: command.command, args: command.args, timeout_ms: Number(options.timeout_ms || DEFAULT_TIMEOUT_MS) }),
      latency_ms: latencyMs
    },
    output_contract: contract,
    model_output: parsed ? {
      status: parsed.status,
      changed_files: parsed.changed_files,
      test_results: parsed.test_results,
      completion_evidence: parsed.completion_evidence,
      self_evaluation: parsed.self_evaluation
    } : null,
    diff_summary: diffSummary,
    test_results: [finalTest],
    review_guard: guard,
    closeout,
    projection,
    evidence: {
      ...evidence,
      final_test: finalTest,
      stdout_excerpt: stdout.slice(-1600),
      stderr_excerpt: stderr.slice(-1600)
    },
    issues: [...issues, ...asArray(contract.issues), ...asArray(guard.issues)]
  };

  appendPhase(phaseTrace, "final_evaluated", run.status, `${runId}:final_evaluation`);
  return run;
}

export function runDevelopmentFlowRealAcceptance(options = {}) {
  const root = options.root_dir || mkdtempSync(join(tmpdir(), "development-flow-real-"));
  const runs = {
    codex_cli: runDevelopmentFlowCliChain("codex_cli", { ...options, root_dir: root }),
    claude_cli: runDevelopmentFlowCliChain("claude_cli", { ...options, root_dir: root })
  };
  const artifact = {
    version: DEVELOPMENT_FLOW_EVALUATION_VERSION,
    runner_version: DEVELOPMENT_FLOW_REAL_VERSION,
    status: "unknown",
    generated_at: now(),
    root_dir: root,
    runs,
    c2c_governance: runContextProviderC2CGovernance({ ...options, root_dir: root })
  };
  const evaluation = evaluateDevelopmentFlowArtifact(artifact);
  artifact.evaluation = evaluation;
  artifact.status = evaluation.status;
  return artifact;
}

export function writeDevelopmentFlowRealAcceptance(options = {}) {
  const outputPath = resolve(options.output_path || options.outputPath || "tmp/development-flow-real/latest.json");
  const artifact = runDevelopmentFlowRealAcceptance(options);
  writeJson(outputPath, artifact);
  return {
    status: artifact.status,
    output_path: outputPath,
    artifact
  };
}

export function writeDevelopmentFlowC2CGovernance(options = {}) {
  const outputPath = resolve(options.output_path || options.outputPath || "tmp/development-flow-real/provider-c2c.json");
  const artifact = runContextProviderC2CGovernance(options);
  writeJson(outputPath, artifact);
  return {
    status: artifact.status,
    output_path: outputPath,
    artifact
  };
}
