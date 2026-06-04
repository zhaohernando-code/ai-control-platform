import {
  applyGeneratedRequirementPlan,
  submitRequirementToProjectStatus,
  updateRequirementPlanReview
} from "./requirement-intake.js";
import { createAgentInvocationPlan } from "./agent-invocation.js";
import { OUTPUT_SCHEMA } from "./development-flow-real-model-output.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

export function promptFor(runId, fixtureDir) {
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

export function commandAudit(command = {}) {
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

export function classifyFailure(runId, result = {}, parsed = null, contract = {}) {
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

export function buildRequirementFlow(runId, createdAt) {
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

export function createCodexCommand({ fixtureDir, prompt, schemaPath, outputPath, options }) {
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

export function createClaudeCommand({ fixtureDir, prompt, options }) {
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
