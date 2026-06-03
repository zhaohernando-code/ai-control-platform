import {
  cleanupAgentLifecyclePool,
  recordAgentLifecycleFact
} from "../src/workflow/agent-lifecycle-pool.js";
import { recordGovernanceAuditSkillTrialRunArtifact } from "../src/workflow/governance-audit-skill-trial.js";
import { recordWorkbenchBrowserEventsRunArtifact } from "../src/workflow/workbench-browser-events.js";

export async function handleWorkflowEvidenceRoutes(context) {
  const {
    url, req, res, jsonBodyLimitBytes, jsonResponse, readJsonBody,
    readServerHistory, readWorkflowState, writeWorkflowState, workbenchProjection
  } = context;

  if (url.pathname === "/api/workbench/agent-lifecycle-pool" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const result = (input.cleanup_latest_pool || input.cleanupLatestPool)
      ? cleanupAgentLifecyclePool(workflowState, {
        created_at: input.created_at || input.createdAt,
        failure: input.failure,
        blocked: input.blocked,
        message: input.message
      })
      : recordAgentLifecycleFact(workflowState, {
        event_type: input.event_type || input.eventType || input.type,
        pool_id: input.pool_id || input.poolId,
        worker_id: input.worker_id || input.workerId,
        status: input.status,
        message: input.message,
        created_at: input.created_at || input.createdAt
      });
    if (!["pass", "cleanup_required", "blocked"].includes(result.status)) {
      jsonResponse(res, 400, { error: "agent lifecycle pool record failed", issues: result.issues });
      return true;
    }

    writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
    jsonResponse(res, 201, {
      status: result.status === "blocked" ? "blocked" : "created",
      item,
      fact: result.fact || null,
      facts: result.facts || [],
      before: result.before || null,
      after: result.after || null,
      projection: workbenchProjection(result.workflow_state)
    });
    return true;
  }

  if (url.pathname === "/api/workbench/workbench-browser-events-run" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const result = recordWorkbenchBrowserEventsRunArtifact(
      workflowState,
      input.artifact || input.run_artifact || input.runArtifact || input,
      {
        artifact_id: input.artifact_id || input.artifactId,
        created_at: input.created_at || input.createdAt
      }
    );
    if (result.status !== "pass") {
      jsonResponse(res, 400, { error: "workbench browser events run record failed", issues: result.issues });
      return true;
    }

    writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
    jsonResponse(res, 201, {
      status: "created",
      item,
      artifact: result.artifact,
      projection: workbenchProjection(result.workflow_state)
    });
    return true;
  }

  if (url.pathname === "/api/workbench/governance-audit-skill-trial" && req.method === "POST") {
    const history = readServerHistory();
    const selectedId = url.searchParams.get("id") || history.latest;
    const item = history.items.find((entry) => entry.id === selectedId);
    if (!item?.input_path) {
      jsonResponse(res, 400, { error: `workflow state input not found: ${selectedId}` });
      return true;
    }

    const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
    const workflowState = readWorkflowState(item);
    const result = recordGovernanceAuditSkillTrialRunArtifact(
      workflowState,
      input.artifact || input.run_artifact || input.runArtifact || input,
      {
        artifact_id: input.artifact_id || input.artifactId,
        created_at: input.created_at || input.createdAt
      }
    );
    if (result.status !== "pass") {
      jsonResponse(res, 400, { error: "governance audit skill trial record failed", issues: result.issues });
      return true;
    }

    writeWorkflowState(item, { ...workflowState, ...result.workflow_state });
    jsonResponse(res, 201, {
      status: "created",
      item,
      artifact: result.artifact,
      summary: result.summary,
      projection: workbenchProjection(result.workflow_state)
    });
    return true;
  }

  return false;
}
