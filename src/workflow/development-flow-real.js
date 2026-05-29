import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

import {
  applyGeneratedRequirementPlan,
  completeRequirementInProjectStatus,
  submitRequirementToProjectStatus,
  updateRequirementPlanReview
} from "./requirement-intake.js";
import {
  DEVELOPMENT_FLOW_EVALUATION_VERSION,
  evaluateDevelopmentFlowArtifact
} from "./development-flow-evaluation.js";
import { createAgentInvocationPlan } from "./agent-invocation.js";

export const DEVELOPMENT_FLOW_REAL_VERSION = "development-flow-real.v1";
const DEFAULT_TIMEOUT_MS = 240000;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["status", "changed_files", "test_results", "completion_evidence", "self_evaluation"],
  properties: {
    status: { enum: ["pass", "fail"] },
    changed_files: {
      type: "array",
      items: { type: "string" },
      minItems: 1
    },
    test_results: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["command", "status"],
        properties: {
          command: { type: "string" },
          status: { enum: ["pass", "fail"] }
        }
      }
    },
    completion_evidence: {
      type: "object",
      additionalProperties: false,
      required: ["summary"],
      properties: {
        summary: { type: "string" }
      }
    },
    self_evaluation: {
      type: "object",
      additionalProperties: false,
      required: ["aligned", "skipped_steps"],
      properties: {
        aligned: { type: "boolean" },
        skipped_steps: {
          type: "array",
          items: { type: "string" }
        }
      }
    }
  }
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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

function safeJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function issue(code, message, path = "") {
  return { code, message, path };
}

function statusPass(value) {
  return ["pass", "passed", "ok", "success"].includes(normalizeToken(value));
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

function createFixture(root, runId) {
  const fixtureDir = join(root, runId);
  mkdirSync(join(fixtureDir, "src"), { recursive: true });
  mkdirSync(join(fixtureDir, "test"), { recursive: true });
  writeFileSync(join(fixtureDir, "package.json"), `${JSON.stringify({
    type: "module",
    scripts: { test: "node --test test/math.test.js" }
  }, null, 2)}\n`);
  writeFileSync(join(fixtureDir, "src", "math.js"), [
    "export function sum(a, b) {",
    "  return a - b;",
    "}",
    ""
  ].join("\n"));
  writeFileSync(join(fixtureDir, "test", "math.test.js"), [
    "import assert from 'node:assert/strict';",
    "import test from 'node:test';",
    "import { sum } from '../src/math.js';",
    "",
    "test('sum adds two numbers', () => {",
    "  assert.equal(sum(2, 3), 5);",
    "});",
    ""
  ].join("\n"));
  writeFileSync(join(fixtureDir, ".gitignore"), "node_modules\n");
  spawnSync("git", ["init"], { cwd: fixtureDir, encoding: "utf8" });
  spawnSync("git", ["add", "."], { cwd: fixtureDir, encoding: "utf8" });
  spawnSync("git", ["commit", "-m", "fixture baseline"], {
    cwd: fixtureDir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Development Flow Fixture",
      GIT_AUTHOR_EMAIL: "dev-flow@example.invalid",
      GIT_COMMITTER_NAME: "Development Flow Fixture",
      GIT_COMMITTER_EMAIL: "dev-flow@example.invalid"
    }
  });
  return fixtureDir;
}

function runFixtureTests(fixtureDir) {
  const result = spawnSync(process.execPath, ["--test", "test/math.test.js"], {
    cwd: fixtureDir,
    encoding: "utf8",
    timeout: 30000
  });
  return {
    command: "node --test test/math.test.js",
    status: result.status === 0 ? "pass" : "fail",
    exit_code: result.status,
    stdout_excerpt: normalizeString(result.stdout).slice(-1200),
    stderr_excerpt: normalizeString(result.stderr).slice(-1200)
  };
}

function gitChangedFiles(fixtureDir) {
  const result = spawnSync("git", ["diff", "--name-only"], {
    cwd: fixtureDir,
    encoding: "utf8"
  });
  return normalizeString(result.stdout).split(/\r?\n/).map(normalizeString).filter(Boolean);
}

function gitHead(fixtureDir) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: fixtureDir,
    encoding: "utf8"
  });
  return normalizeString(result.stdout);
}

function gitChangedFilesSince(fixtureDir, baselineCommit = "") {
  const committed = baselineCommit
    ? spawnSync("git", ["diff", "--name-only", `${baselineCommit}..HEAD`], {
      cwd: fixtureDir,
      encoding: "utf8"
    })
    : { stdout: "" };
  return [
    ...new Set([
      ...normalizeString(committed.stdout).split(/\r?\n/),
      ...gitChangedFiles(fixtureDir)
    ].map(normalizeString).filter(Boolean))
  ];
}

function gitDiffStat(fixtureDir) {
  const result = spawnSync("git", ["diff", "--stat", "--", "."], {
    cwd: fixtureDir,
    encoding: "utf8"
  });
  return normalizeString(result.stdout);
}

function jsonCandidate(text = "") {
  const value = normalizeString(text);
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  const objectStart = value.indexOf("{");
  const objectEnd = value.lastIndexOf("}");
  if (objectStart !== -1 && objectEnd > objectStart) return value.slice(objectStart, objectEnd + 1);
  return "";
}

function normalizeParsedModelJson(parsed) {
  if (!isObject(parsed)) return null;
  if (isObject(parsed.structured_output || parsed.structuredOutput)) {
    return parsed.structured_output || parsed.structuredOutput;
  }
  if (typeof parsed.result === "string") return parseModelJson(parsed.result) || parsed;
  if (isObject(parsed.result)) return parsed.result;
  return parsed;
}

function parseModelJson(text = "") {
  const value = normalizeString(text);
  if (!value) return null;
  try {
    return normalizeParsedModelJson(JSON.parse(value));
  } catch {
    const candidate = jsonCandidate(value);
    if (!candidate || candidate === value) return null;
    try {
      return normalizeParsedModelJson(JSON.parse(candidate));
    } catch {
      return null;
    }
  }
}

function outputContract(parsed = {}) {
  const issues = [];
  if (!isObject(parsed)) {
    return {
      status: "fail",
      issues: [issue("model_output_not_json", "model output did not contain a JSON object")]
    };
  }
  if (!statusPass(parsed.status)) issues.push(issue("model_output_status_not_pass", "model output status must be pass", "status"));
  if (asArray(parsed.changed_files).length === 0) issues.push(issue("model_output_missing_changed_files", "changed_files is required", "changed_files"));
  if (!asArray(parsed.test_results).some((entry) => statusPass(entry?.status))) {
    issues.push(issue("model_output_missing_passing_test", "test_results must include a passing test", "test_results"));
  }
  if (!isObject(parsed.completion_evidence)) issues.push(issue("model_output_missing_completion_evidence", "completion_evidence is required", "completion_evidence"));
  if (!isObject(parsed.self_evaluation)) issues.push(issue("model_output_missing_self_evaluation", "self_evaluation is required", "self_evaluation"));
  return {
    status: issues.length === 0 ? "pass" : "fail",
    issues
  };
}

function promptFor(runId, fixtureDir) {
  return [
    "You are executing a tiny real development-flow acceptance fixture.",
    "Goal: fix the failing test by implementing sum(a, b) correctly.",
    `Workspace: ${fixtureDir}`,
    "Allowed changes: src/math.js only.",
    "Do not run git add, git commit, or create handoff/status/documentation files.",
    "Required commands:",
    "1. Inspect src/math.js and test/math.test.js if needed.",
    "2. Change sum(a, b) so it returns a + b.",
    "3. Run: node --test test/math.test.js",
    "4. After the test passes, emit the final JSON object as your last response.",
    "The run is not complete until that final JSON response is emitted.",
    "",
    "Return only one JSON object matching this shape:",
    JSON.stringify({
      status: "pass",
      changed_files: ["src/math.js"],
      test_results: [{ command: "node --test test/math.test.js", status: "pass" }],
      completion_evidence: { summary: "sum now adds and the fixture test passes" },
      self_evaluation: { aligned: true, skipped_steps: [] }
    }, null, 2),
    "",
    `Run id: ${runId}`
  ].join("\n");
}

function commandAudit(command = {}) {
  return {
    command: command.command,
    args: asArray(command.args).map((arg) => {
      const value = normalizeString(arg);
      if (value.length > 500) return `${value.slice(0, 500)}...<truncated>`;
      return value;
    }),
    timeout_ms: command.timeout_ms
  };
}

function classifyFailure(runId, result = {}, parsed = null, contract = {}) {
  const stderr = normalizeString(result.stderr);
  const stdout = normalizeString(result.stdout);
  const combined = `${stdout}\n${stderr}`;
  const prefix = runId === "codex_cli" ? "codex" : "claude";
  if (/invalid_json_schema|response_format|json schema/i.test(combined)) return `${prefix}_output_contract_failed`;
  if (/hook|guard|blocked|permission|trust|execpolicy/i.test(combined)) return `${prefix}_hook_guard_blocked`;
  if (/model.*not.*found|unknown model|invalid model|model_not_found|not available/i.test(combined)) return runId === "codex_cli" ? "codex_model_unavailable" : "deepseek_provider_unavailable";
  if (/command not found|no such file|not executable/i.test(combined)) return runId === "codex_cli" ? "codex_cli_unavailable" : "claude_cli_unavailable";
  if (!parsed || contract.status !== "pass") return `${prefix}_output_contract_failed`;
  return `${prefix}_cli_execution_failed`;
}

function buildRequirementFlow(runId, createdAt) {
  let projectStatus = { project: "ai-control-platform", status: "in_progress", global_goals: [] };
  const submission = submitRequirementToProjectStatus(projectStatus, {
    title: `${runId} fixture sum fix`,
    project_id: "ai-control-platform",
    surface_area: "workflow_runtime",
    problem_statement: "Run a tiny real CLI development-flow fixture and fix a failing sum implementation.",
    acceptance_criteria: "The fixture test node --test test/math.test.js passes.",
    constraints: "Only edit the isolated fixture repository."
  }, {
    requirement_id: `requirement-${runId}-fixture`,
    created_at: createdAt
  });
  if (submission.status !== "pass") throw new Error(`requirement submission failed: ${JSON.stringify(submission.issues)}`);
  projectStatus = submission.project_status;
  const generated = applyGeneratedRequirementPlan(projectStatus, {
    requirement_id: submission.requirement.id,
    generated_plan: {
      assessment_summary: "Use a minimal isolated fixture to prove the real CLI can land code and pass acceptance.",
      proposed_acceptance_plan: [
        "Run the fixture test before execution and observe failure.",
        "Run the selected real CLI child worker.",
        "Run the fixture test after execution and observe pass."
      ],
      implementation_outline: [
        "Fix the isolated fixture sum implementation with the selected CLI."
      ],
      acceptance_gates: ["node --test test/math.test.js"],
      risks: ["CLI hooks, guards, provider config, or model output contract may block execution."]
    },
    generator: { kind: "development_flow_fixture", model: "local_deterministic_plan" }
  }, { created_at: createdAt });
  if (generated.status !== "pass") throw new Error(`generated plan failed: ${JSON.stringify(generated.issues)}`);
  projectStatus = generated.project_status;
  const approval = updateRequirementPlanReview(projectStatus, {
    requirement_id: submission.requirement.id,
    action: "approve",
    note: "Approved by development-flow acceptance harness."
  }, { created_at: createdAt });
  if (approval.status !== "pass") throw new Error(`plan approval failed: ${JSON.stringify(approval.issues)}`);
  projectStatus = approval.project_status;
  return {
    requirement: submission.requirement,
    plan_review: approval.plan_review,
    project_status: projectStatus,
    work_packages: asArray(projectStatus.next_work_packages)
  };
}

function createCodexCommand({ fixtureDir, prompt, schemaPath, outputPath, options }) {
  const planned = createAgentInvocationPlan({
    profile_id: "development_flow_codex",
    prompt,
    cwd: fixtureDir,
    output_schema: schemaPath,
    output_path: outputPath,
    model: normalizeString(options.codex_model || process.env.DEV_FLOW_CODEX_MODEL),
    invocation_id: "development-flow:codex"
  }, {
    stateStore: options.stateStore || options.state_store,
    channels_path: options.agent_channels_path || options.agentChannelsPath,
    profiles_path: options.agent_profiles_path || options.agentProfilesPath
  });
  if (planned.status !== "pass") {
    return {
      command: "",
      args: [],
      env: process.env,
      model: null,
      runner: "codex",
      provider: "agent_invocation",
      agent_id: "codex-account",
      planning_status: planned.status,
      planning_issues: planned.issues || []
    };
  }
  const invocation = planned.invocation;
  return {
    command: invocation.command,
    args: invocation.args,
    env: invocation.env,
    model: invocation.model,
    runner: invocation.runner,
    provider: invocation.provider,
    agent_id: invocation.agent_id,
    profile_id: invocation.profile_id
  };
}

function createClaudeCommand({ fixtureDir, prompt, options }) {
  const model = normalizeString(options.claude_model || process.env.DEV_FLOW_CLAUDE_MODEL);
  const maxBudgetUsd = normalizeString(options.claude_max_budget_usd || process.env.DEV_FLOW_CLAUDE_MAX_BUDGET_USD) || "0.50";
  const planned = createAgentInvocationPlan({
    profile_id: "development_flow_claude",
    prompt,
    cwd: fixtureDir,
    model,
    max_budget_usd: maxBudgetUsd,
    allowed_tools: "Read,Edit,Bash(node --test *)",
    add_dir: fixtureDir,
    json_schema: OUTPUT_SCHEMA,
    invocation_id: "development-flow:claude"
  }, {
    stateStore: options.stateStore || options.state_store,
    channels_path: options.agent_channels_path || options.agentChannelsPath,
    profiles_path: options.agent_profiles_path || options.agentProfilesPath
  });
  if (planned.status !== "pass") {
    return {
      command: "",
      args: [],
      env: process.env,
      model: null,
      runner: "claude",
      provider: "agent_invocation",
      agent_id: "developer",
      planning_status: planned.status,
      planning_issues: planned.issues || []
    };
  }
  const invocation = planned.invocation;
  return {
    command: invocation.command,
    args: invocation.args,
    env: invocation.env,
    model: invocation.model,
    runner: invocation.runner,
    provider: invocation.provider,
    agent_id: invocation.agent_id,
    profile_id: invocation.profile_id
  };
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
  appendPhase(phaseTrace, diffSummary.has_diff ? "code_landed" : "code_landed", diffSummary.has_diff ? "pass" : "fail", `${runId}:diff`, {
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
    runs
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
