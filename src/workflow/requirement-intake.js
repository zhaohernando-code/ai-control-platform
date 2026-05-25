import { recordArtifact } from "./artifact-ledger.js";
import { appendRunEvent } from "./run-manifest.js";

export const WORKBENCH_REQUIREMENT_INTAKE_VERSION = "workbench-requirement-intake.v1";

const DEFAULT_PROJECT_ID = "ai-control-platform";
const DEFAULT_SURFACE_AREA = "workbench_frontend";
const MAX_STORED_REQUIREMENTS = 12;

const SURFACE_PROFILES = {
  workbench_frontend: {
    id: "workbench_frontend",
    label: "Workbench 前端",
    owned_files: [
      "apps/workbench",
      "src/workflow/workbench-projection.js",
      "src/workflow/frontend-acceptance.js",
      "tools/check-workbench-browser-events.mjs",
      "tools/check-workbench-frontend-acceptance.mjs",
      "test/workbench-shell.test.js",
      "test/workbench-server.test.js",
      "test/workbench-projection.test.js",
      "test/frontend-acceptance.test.js"
    ],
    acceptance_gates: [
      "npm run check:workbench:browser-events",
      "npm run check:closeout"
    ]
  },
  workflow_runtime: {
    id: "workflow_runtime",
    label: "流程引擎",
    owned_files: [
      "src/workflow",
      "tools/workbench-server.mjs",
      "test/workbench-server.test.js",
      "test/workbench-projection.test.js"
    ],
    acceptance_gates: [
      "node --test test/workbench-server.test.js test/workbench-projection.test.js",
      "npm run check:closeout"
    ]
  },
  reviewer_scheduler: {
    id: "reviewer_scheduler",
    label: "调度与审查",
    owned_files: [
      "src/workflow/autonomous-continuation.js",
      "src/workflow/autonomous-scheduler-loop.js",
      "src/workflow/reviewer-shard-runner.js",
      "src/workflow/reviewer-provider-health.js",
      "tools/workbench-server.mjs",
      "test/autonomous-scheduler-loop.test.js",
      "test/workbench-server.test.js"
    ],
    acceptance_gates: [
      "node --test test/autonomous-scheduler-loop.test.js test/workbench-server.test.js",
      "npm run check:closeout"
    ]
  },
  governance_process: {
    id: "governance_process",
    label: "治理与门禁",
    owned_files: [
      "PROJECT_STATUS.json",
      "PROCESS.md",
      "PROJECT_RULES.md",
      "docs/contracts",
      "src/workflow",
      "test"
    ],
    acceptance_gates: [
      "npm run check:process-hardening",
      "npm run check:closeout"
    ]
  }
};

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function uniqueStrings(value) {
  return [...new Set(compactStrings(value))];
}

function issue(code, message, path) {
  return { code, message, path };
}

function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

function requirementProfile(surfaceArea) {
  return SURFACE_PROFILES[normalizeString(surfaceArea)] || SURFACE_PROFILES[DEFAULT_SURFACE_AREA];
}

function requirementIdFrom(title, createdAt) {
  const stamp = normalizeString(createdAt).replace(/[^0-9]/g, "").slice(0, 14) || `${Date.now()}`;
  return `requirement-${safeIdPart(title).slice(0, 48)}-${stamp}`;
}

function requirementSummary(input = {}, profile = {}) {
  const title = normalizeString(input.title);
  const problemStatement = normalizeString(input.problem_statement || input.problemStatement);
  const acceptanceCriteria = normalizeString(input.acceptance_criteria || input.acceptanceCriteria);
  const constraints = normalizeString(input.constraints);
  const parts = [
    `需求：${title}`,
    problemStatement ? `现状与目标：${problemStatement}` : "",
    acceptanceCriteria ? `验收：${acceptanceCriteria}` : "",
    constraints ? `约束：${constraints}` : "",
    profile.label ? `范围：${profile.label}` : ""
  ].filter(Boolean);
  return parts.join("。");
}

function nextWorkPackage(requirement = {}, profile = {}) {
  return {
    id: `${requirement.id}-intake`,
    title: `处理需求：${requirement.title}`,
    action: "continue_requirement_intake",
    owned_files: profile.owned_files,
    acceptance_gates: profile.acceptance_gates,
    reason: requirement.summary,
    global_goal_id: requirement.id,
    source: {
      requirement_id: requirement.id,
      intake_channel: "workbench_frontend",
      surface_area: requirement.surface_area,
      acceptance_criteria: requirement.acceptance_criteria,
      constraints: requirement.constraints || ""
    }
  };
}

function nextArtifactId(workflowState = {}, requirementId = "") {
  const prefix = `requirement-intake-${safeIdPart(workflowState?.manifest?.run_id)}-${safeIdPart(workflowState?.manifest?.cycle_id)}-${safeIdPart(requirementId)}`;
  const used = new Set([
    ...asArray(workflowState?.manifest?.events).map((event) => normalizeString(event?.artifact_id)).filter(Boolean),
    ...asArray(workflowState?.artifact_ledger?.artifacts || workflowState?.artifactLedger?.artifacts)
      .map((artifact) => normalizeString(artifact?.id))
      .filter(Boolean)
  ]);
  let index = 1;
  let id = `${prefix}-${String(index).padStart(3, "0")}`;
  while (used.has(id)) {
    index += 1;
    id = `${prefix}-${String(index).padStart(3, "0")}`;
  }
  return id;
}

function normalizeRequirementItems(value) {
  return asArray(value)
    .filter(isObject)
    .map((item) => ({
      ...item,
      id: normalizeString(item.id),
      title: normalizeString(item.title),
      status: normalizeString(item.status) || "submitted",
      summary: normalizeString(item.summary),
      submitted_at: normalizeString(item.submitted_at || item.created_at),
      surface_area: normalizeString(item.surface_area || item.surfaceArea),
      surface_label: normalizeString(item.surface_label || item.surfaceLabel),
      problem_statement: normalizeString(item.problem_statement || item.problemStatement),
      acceptance_criteria: normalizeString(item.acceptance_criteria || item.acceptanceCriteria),
      constraints: normalizeString(item.constraints),
      owned_files: compactStrings(item.owned_files || item.ownedFiles),
      acceptance_gates: compactStrings(item.acceptance_gates || item.acceptanceGates)
    }))
    .filter((item) => item.id && item.title);
}

export function validateRequirementSubmission(input = {}) {
  const issues = [];

  if (!isObject(input)) {
    return {
      status: "fail",
      issues: [issue("invalid_requirement_submission", "requirement submission must be an object", "")]
    };
  }

  if (!normalizeString(input.title)) {
    issues.push(issue("missing_requirement_title", "title is required", "title"));
  }
  if (!normalizeString(input.problem_statement || input.problemStatement)) {
    issues.push(issue("missing_problem_statement", "problem_statement is required", "problem_statement"));
  }
  if (!normalizeString(input.acceptance_criteria || input.acceptanceCriteria)) {
    issues.push(issue("missing_acceptance_criteria", "acceptance_criteria is required", "acceptance_criteria"));
  }
  if (!SURFACE_PROFILES[normalizeString(input.surface_area || input.surfaceArea) || DEFAULT_SURFACE_AREA]) {
    issues.push(issue("invalid_surface_area", `surface_area must be one of: ${Object.keys(SURFACE_PROFILES).join(", ")}`, "surface_area"));
  }

  return {
    status: issues.length ? "fail" : "pass",
    issues
  };
}

export function submitRequirementToProjectStatus(projectStatus = {}, input = {}, options = {}) {
  const validation = validateRequirementSubmission(input);
  if (validation.status !== "pass") {
    return {
      status: "fail",
      issues: validation.issues
    };
  }

  const createdAt = normalizeString(options.created_at || options.createdAt) || new Date().toISOString();
  const profile = requirementProfile(input.surface_area || input.surfaceArea);
  const title = normalizeString(input.title);
  const requirement = {
    id: normalizeString(options.requirement_id || options.requirementId) || requirementIdFrom(title, createdAt),
    title,
    status: "submitted",
    submitted_at: createdAt,
    surface_area: profile.id,
    surface_label: profile.label,
    problem_statement: normalizeString(input.problem_statement || input.problemStatement),
    acceptance_criteria: normalizeString(input.acceptance_criteria || input.acceptanceCriteria),
    constraints: normalizeString(input.constraints),
    owned_files: profile.owned_files.slice(),
    acceptance_gates: profile.acceptance_gates.slice()
  };
  requirement.summary = requirementSummary(requirement, profile);

  const existingItems = normalizeRequirementItems(projectStatus?.requirement_intake?.items);
  const queue = [
    requirement,
    ...existingItems.filter((item) => item.id !== requirement.id)
  ].slice(0, MAX_STORED_REQUIREMENTS);
  const currentGoal = {
    id: requirement.id,
    title: requirement.title,
    status: "in_progress",
    next_step: requirement.summary,
    owned_files: profile.owned_files.slice(),
    acceptance_gates: profile.acceptance_gates.slice(),
    source: "workbench_requirement_intake",
    submitted_at: createdAt
  };
  const nextPackage = nextWorkPackage(requirement, profile);

  return {
    status: "pass",
    requirement,
    project_status: {
      ...projectStatus,
      project: normalizeString(projectStatus.project) || DEFAULT_PROJECT_ID,
      status: normalizeString(projectStatus.status) || "in_progress",
      updated_at: createdAt,
      next_step: requirement.summary,
      next_work_packages: [nextPackage],
      global_goals: [
        currentGoal,
        ...asArray(projectStatus.global_goals).filter((goal) => normalizeString(goal?.id) !== requirement.id)
      ],
      requirement_intake: {
        version: WORKBENCH_REQUIREMENT_INTAKE_VERSION,
        active_requirement_id: requirement.id,
        latest_requirement_id: requirement.id,
        submitted_count: queue.length,
        open_count: queue.filter((item) => !["completed", "complete", "accepted", "closed"].includes(normalizeString(item.status).toLowerCase())).length,
        items: queue
      }
    }
  };
}

export function summarizeRequirementIntake(projectStatus = {}) {
  const requirementIntake = isObject(projectStatus.requirement_intake) ? projectStatus.requirement_intake : {};
  const items = normalizeRequirementItems(requirementIntake.items);
  const latest = items[0] || null;

  return {
    status: items.length > 0 ? "available" : "not_configured",
    submitted_count: Number(requirementIntake.submitted_count || items.length || 0),
    open_count: Number(requirementIntake.open_count || items.filter((item) => !["completed", "complete", "accepted", "closed"].includes(normalizeString(item.status).toLowerCase())).length),
    active_requirement_id: normalizeString(requirementIntake.active_requirement_id || requirementIntake.activeRequirementId) || latest?.id || null,
    latest,
    items
  };
}

export function recordRequirementIntakeSubmitted(workflowState = {}, submission = {}, options = {}) {
  if (!isObject(workflowState)) {
    return {
      status: "fail",
      issues: [issue("invalid_workflow_state", "workflow state must be an object", "workflow_state")]
    };
  }
  if (!isObject(submission?.project_status) || !isObject(submission?.requirement)) {
    return {
      status: "fail",
      issues: [issue("invalid_requirement_submission_result", "submission must include project_status and requirement", "submission")]
    };
  }

  const runId = normalizeString(workflowState?.manifest?.run_id);
  const cycleId = normalizeString(workflowState?.manifest?.cycle_id);
  if (!runId || !cycleId) {
    return {
      status: "fail",
      issues: [issue("missing_workflow_identity", "workflow state manifest run_id and cycle_id are required", "workflow_state.manifest")]
    };
  }

  const requirement = submission.requirement;
  const createdAt = normalizeString(options.created_at || options.createdAt || requirement.submitted_at) || new Date().toISOString();
  const artifactId = nextArtifactId(workflowState, requirement.id);
  const nextWorkPackages = asArray(submission.project_status.next_work_packages);
  const artifact = {
    id: artifactId,
    type: "evaluation",
    status: "pass",
    producer: "workbench-requirement-intake",
    uri: `requirement-intake://${encodeURIComponent(runId)}/${encodeURIComponent(cycleId)}/${encodeURIComponent(requirement.id)}`,
    created_at: createdAt,
    metadata: {
      version: WORKBENCH_REQUIREMENT_INTAKE_VERSION,
      type: "requirement_intake_submitted",
      status: "ready",
      run_id: runId,
      cycle_id: cycleId,
      requirement,
      next_step: submission.project_status.next_step || null,
      global_goal_id: requirement.id,
      next_work_package_count: nextWorkPackages.length,
      next_work_packages: nextWorkPackages.map((workPackage) => ({
        id: workPackage.id || null,
        title: workPackage.title || null,
        action: workPackage.action || null,
        global_goal_id: workPackage.global_goal_id || null,
        owned_files: uniqueStrings(workPackage.owned_files || workPackage.ownedFiles),
        acceptance_gates: uniqueStrings(workPackage.acceptance_gates || workPackage.acceptanceGates)
      }))
    }
  };
  const manifest = appendRunEvent(workflowState.manifest, {
    id: `event-${artifactId}`,
    type: "requirement_intake_submitted",
    status: "ready",
    artifact_id: artifactId,
    message: `workbench requirement submitted: ${requirement.title}`,
    created_at: createdAt,
    metadata: artifact.metadata
  });
  const baseLedger = workflowState.artifact_ledger || workflowState.artifactLedger || {};
  const artifactLedger = recordArtifact({
    ...baseLedger,
    artifacts: Array.isArray(baseLedger.artifacts) ? baseLedger.artifacts : []
  }, artifact);

  return {
    status: "pass",
    artifact,
    fact: artifact.metadata,
    workflow_state: {
      ...workflowState,
      project_status: submission.project_status,
      global_goals: asArray(submission.project_status.global_goals),
      manifest: {
        ...manifest,
        artifacts: [...asArray(manifest.artifacts), artifact]
      },
      artifact_ledger: artifactLedger
    }
  };
}
