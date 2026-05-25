const COMPLETE_STATUSES = new Set(["complete", "completed", "done", "pass", "passed", "accepted", "closed", "shipped"]);
const BLOCKED_STATUSES = new Set(["blocked", "human_intervention", "stop_for_human"]);

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

function compactStrings(value) {
  return asArray(value).map(normalizeString).filter(Boolean);
}

function issue(code, message, path) {
  return { code, message, path };
}

function isObject(value) {
  return value && typeof value === "object" && !Array.isArray(value);
}

function statusOf(goal = {}) {
  if (goal.completed === true) return "completed";
  return normalizeToken(goal.status || goal.decision || goal.state || "pending");
}

function goalSources(input = {}) {
  return [
    input?.project_status?.global_goals,
    input?.projectStatus?.global_goals,
    input?.workflow_state?.project_status?.global_goals,
    input?.workflowState?.project_status?.global_goals,
    input?.global_goals,
    input?.globalGoals,
    input?.workflow_state?.global_goals,
    input?.workflowState?.global_goals
  ];
}

function normalizeGoal(goal, index) {
  if (!isObject(goal)) {
    return {
      goal: null,
      issue: issue("invalid_global_goal", "global goal must be an object", `global_goals.${index}`)
    };
  }

  const id = normalizeString(goal.id || goal.goal_id || goal.key) || `global-goal-${index + 1}`;
  const title = normalizeString(goal.title || goal.label || goal.name || goal.description || goal.next_step);
  const status = statusOf(goal);
  const blockers = asArray(goal.blockers).filter(Boolean);
  const blocked = BLOCKED_STATUSES.has(status) || blockers.some((blocker) => blocker?.requires_human || blocker?.requiresHuman);
  const completed = COMPLETE_STATUSES.has(status);

  return {
    goal: {
      id,
      title: title || id,
      status,
      completed,
      blocked,
      blockers,
      next_step: normalizeString(goal.next_step || goal.nextStep),
      action: normalizeString(goal.action),
      owned_files: compactStrings(goal.owned_files || goal.ownedFiles),
      acceptance_gates: compactStrings(goal.acceptance_gates || goal.acceptanceGates),
      rollback_conditions: compactStrings(goal.rollback_conditions || goal.rollbackConditions),
      depends_on: compactStrings(goal.depends_on || goal.dependencies),
      next_work_packages: asArray(goal.next_work_packages || goal.nextWorkPackages)
    },
    issue: title || goal.next_step ? null : issue("missing_global_goal_title", "global goal should have a title or next_step", `global_goals.${index}`)
  };
}

function globalGoalsFrom(input = {}) {
  const source = goalSources(input).find((value) => Array.isArray(value));
  if (!source) return { goals: [], issues: [] };

  const completedGoalIds = completedGlobalGoalIdsFromWorkflowState(input);
  const normalized = source.map((goal, index) => normalizeGoal(goal, index));
  return {
    goals: normalized.map((entry) => entry.goal).filter(Boolean).map((goal) => {
      if (!completedGoalIds.has(goal.id)) return goal;
      return {
        ...goal,
        status: "completed",
        completed: true,
        blocked: false
      };
    }),
    issues: normalized.map((entry) => entry.issue).filter(Boolean)
  };
}

function completedGlobalGoalIdsFromWorkflowState(input = {}) {
  const workflowState = input?.workflow_state || input?.workflowState || input;
  const packages = [
    ...asArray(workflowState?.manifest?.work_packages),
    ...asArray(workflowState?.task_dag || workflowState?.taskDag)
  ];
  return new Set(packages
    .filter((workPackage) => COMPLETE_STATUSES.has(statusOf(workPackage)))
    .map((workPackage) => normalizeString(workPackage.global_goal_id || workPackage.globalGoalId))
    .filter(Boolean));
}

function workPackagesForGoal(goal) {
  const packages = goal.next_work_packages.length > 0
    ? goal.next_work_packages
    : [
        {
          id: `global-goal-${goal.id}`,
          title: goal.next_step || goal.title,
          action: goal.action || "continue_global_goal",
          owned_files: goal.owned_files,
          acceptance_gates: goal.acceptance_gates,
          rollback_conditions: goal.rollback_conditions,
          depends_on: goal.depends_on
        }
      ];

  return packages.map((workPackage, index) => ({
    id: normalizeString(workPackage.id || workPackage.work_package_id) || `global-goal-${goal.id}-${index + 1}`,
    title: normalizeString(workPackage.title || workPackage.reason || workPackage.action) || goal.title,
    action: normalizeString(workPackage.action) || goal.action || "continue_global_goal",
    owned_files: compactStrings(workPackage.owned_files || workPackage.ownedFiles || goal.owned_files),
    acceptance_gates: compactStrings(workPackage.acceptance_gates || workPackage.acceptanceGates || goal.acceptance_gates),
    rollback_conditions: compactStrings(workPackage.rollback_conditions || workPackage.rollbackConditions || goal.rollback_conditions),
    depends_on: compactStrings(workPackage.depends_on || workPackage.dependencies || goal.depends_on),
    global_goal_id: goal.id,
    reason: normalizeString(workPackage.reason) || "global goal remains incomplete after the current requirement"
  }));
}

export function evaluateGlobalGoalCompletion(input = {}) {
  const { goals, issues } = globalGoalsFrom(input);

  if (goals.length === 0) {
    return {
      status: "not_configured",
      total: 0,
      completed: 0,
      pending: 0,
      blocked: 0,
      next_goal: null,
      pending_goals: [],
      blocked_goals: [],
      next_work_packages: [],
      issues
    };
  }

  const completedGoals = goals.filter((goal) => goal.completed);
  const blockedGoals = goals.filter((goal) => !goal.completed && goal.blocked);
  const pendingGoals = goals.filter((goal) => !goal.completed && !goal.blocked);
  const status = blockedGoals.length > 0
    ? "blocked"
    : (pendingGoals.length === 0 ? "complete" : "in_progress");

  return {
    status,
    total: goals.length,
    completed: completedGoals.length,
    pending: pendingGoals.length,
    blocked: blockedGoals.length,
    next_goal: pendingGoals[0] ? {
      id: pendingGoals[0].id,
      title: pendingGoals[0].title,
      next_step: pendingGoals[0].next_step || null
    } : null,
    pending_goals: pendingGoals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      status: goal.status,
      next_step: goal.next_step || null
    })),
    blocked_goals: blockedGoals.map((goal) => ({
      id: goal.id,
      title: goal.title,
      status: goal.status,
      blocker_count: goal.blockers.length
    })),
    next_work_packages: pendingGoals.flatMap(workPackagesForGoal),
    issues
  };
}
