import { createAgentReviewerShardExecutor } from "../src/workflow/agent-reviewer-shard-executor.js";
import {
  evaluateReviewerExecutionPolicy,
  evaluateReviewerProviderHealthPreflight
} from "../src/workflow/reviewer-execution-policy.js";
import { recordReviewerProviderHealthFact } from "../src/workflow/reviewer-provider-health.js";
import {
  recordReviewerShardAggregate,
  recordReviewerShardResult
} from "../src/workflow/reviewer-shard-results.js";
import { runReviewerShard } from "../src/workflow/reviewer-shard-runner.js";

function normalizeString(value) {
  return String(value || "").trim();
}

function reviewerShardExecutorFromInput(input = {}, options = {}) {
  const policy = evaluateReviewerExecutionPolicy(input);
  if (policy.status !== "pass") {
    const error = new Error("reviewer execution policy rejected");
    error.code = "reviewer_execution_policy_rejected";
    error.issues = policy.issues;
    error.policy = policy;
    throw error;
  }
  const preflight = evaluateReviewerProviderHealthPreflight(options.workflowState, policy);
  if (preflight.status !== "pass") {
    const error = new Error("reviewer provider health preflight rejected");
    error.code = "reviewer_provider_health_preflight_rejected";
    error.issues = preflight.issues;
    error.policy = policy;
    throw error;
  }

  const mockFindingsJson = normalizeString(input.reviewer_mock_findings_json || input.reviewerMockFindingsJson);
  const mockStatus = normalizeString(input.reviewer_mock_status || input.reviewerMockStatus);
  if (policy.controls.executor_mode === "mock") {
    return {
      policy,
      executor: async () => ({
        status: mockStatus || "pass",
        findings: mockFindingsJson ? JSON.parse(mockFindingsJson) : [],
        provenance: {
          executor_kind: "mock",
          provider: "mock",
          model: "mock",
          timeout_seconds: null,
          tools: "",
          external_call_budget_used: 0,
          execution_profile: policy.profile
        }
      })
    };
  }

  const timeoutSeconds = policy.controls.timeout_seconds;
  const baseExecutor = options.realReviewerExecutor || createAgentReviewerShardExecutor({
    cwd: options.root,
    timeout_seconds: timeoutSeconds,
    stateStore: options.stateStore || options.state_store
  });
  return {
    policy,
    executor: async (request) => {
      const result = await baseExecutor(request);
      return {
        ...result,
        provenance: {
          ...(result?.provenance || {}),
          execution_profile: policy.profile,
          policy_execution_mode: policy.execution_mode,
          model_routing_selected_model: policy.controls.model_routing?.selected_model || null
        }
      };
    }
  };
}

export async function handleReviewerRoutes(context) {
  const {
    url, req, res, root, stateStore, jsonBodyLimitBytes, jsonResponse, readJsonBody,
    readServerHistory, readWorkflowState, writeWorkflowState, workbenchProjection,
    realReviewerExecutor
  } = context;

  if (url.pathname === "/api/workbench/reviewer-provider-health" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const result = recordReviewerProviderHealthFact(workflowState, {
      request: workflowState.reviewer_gate?.request || workflowState.reviewerGate?.request || workflowState.reviewer_gate || workflowState.reviewerGate,
      smoke_status: input.smoke_status || input.smokeStatus || input.provider_smoke_status,
      tools: input.tools || input.allowed_tools || input.allowedTools,
      created_at: input.created_at
    });
    if (result.status !== "pass") {
      jsonResponse(res, 400, { error: "reviewer provider health record failed", issues: result.issues });
      return true;
    }

    writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
    jsonResponse(res, 201, {
      status: "created",
      item,
      fact: result.fact,
      projection: workbenchProjection(result.workflow_state)
    });
    return true;
  }

  if (url.pathname === "/api/workbench/reviewer-shard-result" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const result = recordReviewerShardResult(workflowState, {
      shard_id: input.shard_id || input.shardId,
      status: input.status,
      findings: input.findings || input.review_findings || [],
      created_at: input.created_at
    });
    if (result.status !== "pass") {
      jsonResponse(res, 400, { error: "reviewer shard result record failed", issues: result.issues });
      return true;
    }

    let nextState = result.workflow_state;
    let aggregate = null;
    if (input.aggregate === true) {
      aggregate = recordReviewerShardAggregate(nextState, {
        created_at: input.aggregate_created_at || input.created_at
      });
      if (aggregate.status !== "pass") {
        jsonResponse(res, 400, { error: "reviewer shard aggregate record failed", issues: aggregate.issues });
        return true;
      }
      nextState = aggregate.workflow_state;
    }

    writeWorkflowState(item, { ...workflowState, ...nextState });
    jsonResponse(res, 201, {
      status: "created",
      item,
      fact: result.fact,
      aggregate: aggregate?.fact || null,
      projection: workbenchProjection(nextState)
    });
    return true;
  }

  if (url.pathname === "/api/workbench/reviewer-shard-run" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    let executorSetup;
    try {
      executorSetup = reviewerShardExecutorFromInput(input, { realReviewerExecutor, workflowState, stateStore, root });
    } catch (error) {
      jsonResponse(res, 400, {
        error: error.code === "reviewer_execution_policy_rejected" || error.code === "reviewer_provider_health_preflight_rejected"
          ? "reviewer execution policy rejected"
          : "reviewer shard executor setup failed",
        issues: error.issues || [{ code: "reviewer_shard_executor_setup_failed", message: error.message, path: "reviewer_mock_findings_json" }],
        policy: error.policy || null,
        projection: workbenchProjection(workflowState)
      });
      return true;
    }

    const result = await runReviewerShard(workflowState, {
      shard_id: input.shard_id || input.shardId,
      created_at: input.created_at || input.createdAt,
      aggregate_created_at: input.aggregate_created_at || input.aggregateCreatedAt,
      record_provider_health_on_timeout: input.record_provider_health_on_timeout ?? input.recordProviderHealthOnTimeout ?? true,
      provider_smoke_status: input.provider_smoke_status || input.providerSmokeStatus,
      executor: executorSetup.executor
    });
    if (result.status !== "pass") {
      jsonResponse(res, 400, { error: "reviewer shard run failed", issues: result.issues || [], projection: workbenchProjection(workflowState) });
      return true;
    }

    writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
    jsonResponse(res, 201, {
      status: "created",
      item,
      phase: result.phase,
      shard_id: result.result?.shard_id || result.shard?.id || null,
      shard_status: result.result?.status || null,
      result: result.result,
      reviewer_execution_policy: executorSetup.policy,
      provider_health: result.provider_health || null,
      aggregate: result.aggregate || null,
      pending_shards: result.pending_shards ?? result.aggregate?.pending_shards ?? null,
      projection: workbenchProjection(result.workflow_state)
    });
    return true;
  }

  return false;
}
