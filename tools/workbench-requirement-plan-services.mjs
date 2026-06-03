import { runAgentInvocation } from "../src/workflow/agent-invocation.js";
import {
  applyGeneratedRequirementPlan,
  createRequirementPlanPrompt,
  markRequirementPlanGenerationFailed,
  parseRequirementPlanGenerationOutput
} from "../src/workflow/requirement-intake.js";
import {
  normalizeString,
  readProjectStatus,
  workflowStateWithProjectStatus,
  writeProjectStatusState
} from "./workbench-requirement-service-utils.mjs";

function requirementPlanGenerationRequested(input = {}) {
  return input.generate_plan === true ||
    input.generatePlan === true ||
    input.plan_generation_mode === "model" ||
    input.planGenerationMode === "model" ||
    Boolean(input.generated_plan || input.generatedPlan);
}

export function requirementPlanGenerationRunsInBackground(input = {}) {
  if (!requirementPlanGenerationRequested(input)) return false;
  if (input.generated_plan || input.generatedPlan) return false;
  return input.wait_for_plan_generation !== true &&
    input.waitForPlanGeneration !== true &&
    input.plan_generation_mode !== "inline" &&
    input.planGenerationMode !== "inline";
}

function defaultRequirementPlanGenerator(input = {}, options = {}) {
  const cwd = options.root || process.cwd();
  const timeoutMs = Number(
    input.requirement_plan_timeout_ms ||
      input.requirementPlanTimeoutMs ||
      process.env.AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_TIMEOUT_MS ||
      300000
  );
  const maxAttempts = Number(input.requirement_plan_max_attempts || input.requirementPlanMaxAttempts || 4) || 4;

  return async ({ requirement }) => {
    const prompt = createRequirementPlanPrompt(requirement);
    const attempts = [];
    let finalAttempt = null;
    for (let candidateIndex = 0; candidateIndex < maxAttempts; candidateIndex += 1) {
      const invocationResult = runAgentInvocation({
        profile_id: "requirement_plan_generation",
        prompt,
        cwd,
        timeout_ms: Number.isFinite(timeoutMs) ? timeoutMs : 300000,
        invocation_id: `${normalizeString(requirement?.id) || "requirement-plan"}:${candidateIndex}`,
        candidate_index: candidateIndex,
        goal: requirement?.title || "requirement plan generation",
        risk: input.risk || "medium",
        budget_tier: input.budget_tier || input.budgetTier || "balanced"
      }, {
        stateStore: options.stateStore || options.state_store,
        channels_path: input.agent_channels_path || input.agentChannelsPath || process.env.AI_CONTROL_WORKBENCH_AGENT_CHANNELS_PATH,
        profiles_path: input.agent_profiles_path || input.agentProfilesPath || process.env.AI_CONTROL_WORKBENCH_AGENT_PROFILES_PATH,
        commandRunner: options.commandRunner,
        maxBuffer: options.maxBuffer
      });
      const generator = {
        kind: "agent_invocation_requirement_plan",
        invocation_version: invocationResult.invocation?.version || null,
        profile_id: invocationResult.invocation?.profile_id || "requirement_plan_generation",
        command: invocationResult.invocation?.command || null,
        agent_id: invocationResult.invocation?.agent_id || null,
        role: invocationResult.invocation?.role || "planner",
        model: invocationResult.invocation?.model || null,
        strength: invocationResult.invocation?.strength || null,
        hooks: invocationResult.invocation?.hooks || [],
        exit_code: invocationResult.result?.exit_code ?? null,
        timed_out: invocationResult.result?.timed_out === true,
        failure_classification: invocationResult.result?.failure_classification || invocationResult.issues?.[0]?.code || null,
        attempt: candidateIndex === 0 ? "primary" : "candidate_fallback",
        candidate_index: candidateIndex,
        timeout_ms: Number.isFinite(timeoutMs) ? timeoutMs : 300000
      };
      attempts.push(generator);
      finalAttempt = {
        status: invocationResult.status,
        stdout: invocationResult.stdout || "",
        stderr: invocationResult.stderr || "",
        generator
      };
      if (invocationResult.status === "pass" && normalizeString(invocationResult.stdout)) break;
      if (!invocationResult.invocation && invocationResult.status !== "pass" && candidateIndex < maxAttempts - 1) continue;
      if (!generator.timed_out && generator.failure_classification !== "model_unavailable" && generator.failure_classification !== "auth_failed") break;
    }
    return {
      status: finalAttempt.status,
      stdout: finalAttempt.stdout,
      stderr: finalAttempt.stderr,
      generator: {
        ...finalAttempt.generator,
        fallback_model: attempts.length > 1 ? finalAttempt.generator.model : null,
        fallback_from_model: attempts.length > 1 ? attempts[0]?.model || null : null,
        attempts
      }
    };
  };
}

async function generateRequirementPlanOnly(submitted = {}, input = {}, options = {}) {
  const generator = options.requirementPlanGenerator || defaultRequirementPlanGenerator(input, options);
  if (typeof generator !== "function") {
    const issues = [{ code: "requirement_plan_generator_unavailable", message: "model plan generator is not configured", path: "requirement_plan_generator" }];
    return { status: "fail", issues };
  }

  let generation;
  try {
    generation = await generator({
      requirement: submitted.requirement,
      prompt: createRequirementPlanPrompt(submitted.requirement)
    });
  } catch (error) {
    return {
      status: "fail",
      issues: [{
        code: "requirement_plan_generation_failed",
        message: error?.message || "model plan generation failed",
        path: "plan_generation"
      }],
      stderr: error?.stack || error?.message || ""
    };
  }
  if (generation?.status !== "pass") {
    return {
      status: "fail",
      issues: [{
        code: "requirement_plan_generation_failed",
        message: "model plan generation failed",
        path: "plan_generation",
        stderr: normalizeString(generation?.stderr)
      }],
      stderr: normalizeString(generation?.stderr),
      generator: generation?.generator || generation?.provenance || null
    };
  }

  const parsed = generation.generated_plan || generation.generatedPlan
    ? parseRequirementPlanGenerationOutput(submitted.requirement, generation.generated_plan || generation.generatedPlan)
    : parseRequirementPlanGenerationOutput(submitted.requirement, generation.stdout);
  if (parsed.status !== "pass") {
    return {
      status: "fail",
      issues: parsed.issues,
      stderr: normalizeString(generation?.stderr),
      generator: generation?.generator || generation?.provenance || null
    };
  }

  return {
    status: "pass",
    generated_plan: parsed,
    generator: generation.generator || generation.provenance || { kind: "model_plan_generator" },
    issues: []
  };
}

export async function generateRequirementPlanIfRequested(submitted = {}, input = {}, options = {}) {
  const createdAt = input.created_at || input.createdAt;
  const failedSubmission = (issues = [], extra = {}) => {
    const marked = markRequirementPlanGenerationFailed(submitted.project_status, {
      requirement_id: submitted.requirement.id,
      issues,
      ...extra
    }, {
      created_at: createdAt
    });
    return marked.status === "pass"
      ? { ...submitted, plan_review: marked.plan_review, project_status: marked.project_status }
      : submitted;
  };

  if (!requirementPlanGenerationRequested(input)) {
    return {
      status: "not_requested",
      submission: submitted,
      issues: []
    };
  }

  const directPlan = input.generated_plan || input.generatedPlan;
  if (directPlan) {
    const applied = applyGeneratedRequirementPlan(submitted.project_status, {
      requirement_id: submitted.requirement.id,
      generated_plan: directPlan,
      generator: input.generator || { kind: "provided_generated_plan" }
    }, {
      created_at: input.created_at || input.createdAt
    });
    return {
      status: applied.status === "pass" ? "pass" : "fail",
      submission: applied.status === "pass"
        ? { ...submitted, plan_review: applied.plan_review, project_status: applied.project_status }
        : submitted,
      issues: applied.issues || []
    };
  }

  const generated = await generateRequirementPlanOnly(submitted, input, options);
  if (generated.status !== "pass") {
    return {
      status: "fail",
      submission: failedSubmission(generated.issues, {
        stderr: normalizeString(generated.stderr),
        generator: generated.generator || null
      }),
      issues: generated.issues || []
    };
  }

  const applied = applyGeneratedRequirementPlan(submitted.project_status, {
    requirement_id: submitted.requirement.id,
    generated_plan: generated.generated_plan,
    generator: generated.generator
  }, {
    created_at: input.created_at || input.createdAt
  });
  return {
    status: applied.status === "pass" ? "pass" : "fail",
    submission: applied.status === "pass"
      ? { ...submitted, plan_review: applied.plan_review, project_status: applied.project_status }
      : submitted,
    issues: applied.issues || []
  };
}

export function startRequirementPlanGenerationInBackground({
  submitted,
  input,
  item,
  readWorkflowState,
  writeWorkflowState,
  projectStatusPath,
  stateStore,
  root,
  requirementPlanGenerator
}) {
  setTimeout(async () => {
    try {
      const generated = await generateRequirementPlanOnly(submitted, input, { requirementPlanGenerator, stateStore, root });
      const currentProjectStatus = readProjectStatus(projectStatusPath, stateStore) || submitted.project_status;
      const next = generated.status === "pass"
        ? applyGeneratedRequirementPlan(currentProjectStatus || {}, {
          requirement_id: submitted.requirement.id,
          generated_plan: generated.generated_plan,
          generator: generated.generator
        }, {
          created_at: input.created_at || input.createdAt
        })
        : markRequirementPlanGenerationFailed(currentProjectStatus || {}, {
          requirement_id: submitted.requirement.id,
          issues: generated.issues || [],
          stderr: normalizeString(generated.stderr),
          generator: generated.generator || null
        }, {
          created_at: input.created_at || input.createdAt
        });
      if (next.status !== "pass") {
        console.error("[workbench-server] requirement plan background write failed", next.issues || []);
        return;
      }
      const latestWorkflowState = readWorkflowState(item);
      const nextWorkflowState = workflowStateWithProjectStatus(latestWorkflowState, next.project_status);
      writeProjectStatusState(projectStatusPath, next.project_status, stateStore);
      writeWorkflowState(item, nextWorkflowState);
    } catch (error) {
      console.error("[workbench-server] requirement plan background generation failed", error);
    }
  }, 0);
}
