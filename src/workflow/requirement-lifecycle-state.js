import {
  asArray,
  isClosedRequirementStatus,
  isObject,
  issue,
  normalizeRequirementItems,
  normalizeString,
  withoutRequirementWorkPackages
} from "./requirement-intake-core.js";

export function completeRequirementInProjectStatus(projectStatus = {}, input = {}, options = {}) {
  const requirementId = normalizeString(input.requirement_id || input.requirementId || input);
  if (!requirementId) {
    return {
      status: "fail",
      issues: [issue("missing_requirement_id", "requirement_id is required", "requirement_id")]
    };
  }

  const completedAt = normalizeString(options.completed_at || options.completedAt || options.created_at || options.createdAt) ||
    new Date().toISOString();
  const requirementIntake = isObject(projectStatus.requirement_intake) ? projectStatus.requirement_intake : {};
  const items = normalizeRequirementItems(requirementIntake.items);
  let requirementFound = false;
  const nextItems = items.map((item) => {
    if (normalizeString(item.id) !== requirementId) return item;
    requirementFound = true;
    return {
      ...item,
      status: "completed",
      completed_at: completedAt,
      updated_at: completedAt
    };
  });
  if (!requirementFound) {
    return {
      status: "fail",
      issues: [issue("requirement_not_found", "requirement not found in requirement_intake.items", "requirement_intake.items")]
    };
  }

  const openItems = nextItems.filter((item) => !isClosedRequirementStatus(item.status));
  const existingReviews = isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {};
  const existingReview = existingReviews[requirementId] || {};
  const nextReview = {
    ...existingReview,
    status: "completed",
    phase: "completed",
    completed_at: completedAt,
    updated_at: completedAt,
    next_action: "已完成",
    action_status: "完成"
  };
  const nextGlobalGoals = asArray(projectStatus.global_goals || projectStatus.globalGoals)
    .map((goal) => {
      const goalId = normalizeString(goal?.id || goal?.goal_id || goal?.key);
      if (goalId !== requirementId) return goal;
      return {
        ...goal,
        status: "completed",
        completed: true,
        completed_at: normalizeString(goal.completed_at || goal.completedAt) || completedAt,
        updated_at: completedAt,
        next_work_packages: []
      };
    });
  const nextWorkPackages = withoutRequirementWorkPackages(projectStatus.next_work_packages || projectStatus.nextWorkPackages, requirementId);
  const currentNextStep = normalizeString(projectStatus.next_step || projectStatus.nextStep);
  const currentRequirement = nextItems.find((item) => normalizeString(item.id) === requirementId) || {};
  const shouldClearNextStep = currentNextStep && (
    currentNextStep === normalizeString(currentRequirement.summary) ||
    currentNextStep.includes(normalizeString(currentRequirement.title))
  );

  return {
    status: "pass",
    requirement: nextItems.find((item) => normalizeString(item.id) === requirementId) || null,
    plan_review: nextReview,
    project_status: {
      ...projectStatus,
      updated_at: completedAt,
      ...(shouldClearNextStep ? { next_step: "" } : {}),
      next_work_packages: nextWorkPackages,
      requirement_intake: {
        ...requirementIntake,
        items: nextItems,
        submitted_count: Number(requirementIntake.submitted_count || nextItems.length || 0),
        open_count: openItems.length,
        active_requirement_id: openItems[0]?.id || null,
        latest_requirement_id: normalizeString(requirementIntake.latest_requirement_id || requirementIntake.latestRequirementId) || nextItems[0]?.id || requirementId
      },
      plan_reviews: {
        ...existingReviews,
        [requirementId]: nextReview
      },
      ...(nextGlobalGoals.length > 0 ? { global_goals: nextGlobalGoals } : {})
    }
  };
}

export function closeRequirementInProjectStatus(projectStatus = {}, input = {}, options = {}) {
  const requirementId = normalizeString(input.requirement_id || input.requirementId || input);
  if (!requirementId) {
    return {
      status: "fail",
      issues: [issue("missing_requirement_id", "requirement_id is required", "requirement_id")]
    };
  }

  const closedAt = normalizeString(options.closed_at || options.closedAt || options.created_at || options.createdAt || input.created_at || input.createdAt) ||
    new Date().toISOString();
  const closeReason = normalizeString(input.note || input.reason || input.close_reason || input.closeReason) || "operator closed failed requirement";
  const requirementIntake = isObject(projectStatus.requirement_intake) ? projectStatus.requirement_intake : {};
  const items = normalizeRequirementItems(requirementIntake.items);
  let requirementFound = false;
  const nextItems = items.map((item) => {
    if (normalizeString(item.id) !== requirementId) return item;
    requirementFound = true;
    return {
      ...item,
      status: "closed_failed",
      closed_at: closedAt,
      updated_at: closedAt,
      close_reason: closeReason
    };
  });
  if (!requirementFound) {
    return {
      status: "fail",
      issues: [issue("requirement_not_found", "requirement not found in requirement_intake.items", "requirement_intake.items")]
    };
  }

  const openItems = nextItems.filter((item) => !isClosedRequirementStatus(item.status));
  const existingReviews = isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {};
  const existingReview = existingReviews[requirementId] || {};
  const nextReview = {
    ...existingReview,
    status: "closed_failed",
    phase: "closed_failed",
    closed_at: closedAt,
    updated_at: closedAt,
    close_reason: closeReason,
    next_action: "已关闭，不再阻塞流程",
    action_status: "已关闭"
  };
  const nextGlobalGoals = asArray(projectStatus.global_goals || projectStatus.globalGoals)
    .map((goal) => {
      const goalId = normalizeString(goal?.id || goal?.goal_id || goal?.key);
      if (goalId !== requirementId) return goal;
      return {
        ...goal,
        status: "closed",
        completed: true,
        closed_at: closedAt,
        updated_at: closedAt,
        close_reason: closeReason,
        next_work_packages: []
      };
    });
  const nextWorkPackages = withoutRequirementWorkPackages(projectStatus.next_work_packages || projectStatus.nextWorkPackages, requirementId);
  const currentNextStep = normalizeString(projectStatus.next_step || projectStatus.nextStep);
  const currentRequirement = nextItems.find((item) => normalizeString(item.id) === requirementId) || {};
  const shouldClearNextStep = currentNextStep && (
    currentNextStep === normalizeString(currentRequirement.summary) ||
    currentNextStep.includes(normalizeString(currentRequirement.title))
  );

  return {
    status: "pass",
    requirement: nextItems.find((item) => normalizeString(item.id) === requirementId) || null,
    plan_review: nextReview,
    project_status: {
      ...projectStatus,
      updated_at: closedAt,
      ...(shouldClearNextStep ? { next_step: "" } : {}),
      next_work_packages: nextWorkPackages,
      requirement_intake: {
        ...requirementIntake,
        items: nextItems,
        submitted_count: Number(requirementIntake.submitted_count || nextItems.length || 0),
        open_count: openItems.length,
        active_requirement_id: openItems[0]?.id || null,
        latest_requirement_id: openItems[0]?.id || normalizeString(requirementIntake.latest_requirement_id || requirementIntake.latestRequirementId) || null
      },
      plan_reviews: {
        ...existingReviews,
        [requirementId]: nextReview
      },
      ...(nextGlobalGoals.length > 0 ? { global_goals: nextGlobalGoals } : {})
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
    open_count: Number(requirementIntake.open_count ?? items.filter((item) => !isClosedRequirementStatus(item.status)).length),
    active_requirement_id: normalizeString(requirementIntake.active_requirement_id || requirementIntake.activeRequirementId) || latest?.id || null,
    latest,
    items
  };
}
