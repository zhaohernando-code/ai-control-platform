import { createRequirementPlanWorkPackages } from "./requirement-plan-granularity.js";
import { evaluateGeneratedRequirementPlan } from "./requirement-plan-generation.js";
import {
  MAX_STORED_REQUIREMENTS,
  asArray,
  generationIssueSummary,
  isClosedRequirementStatus,
  isObject,
  issue,
  normalizeRequirementItems,
  normalizeString,
  pendingPlanReview,
  safeIdPart,
  uniqueStrings,
  withoutRequirementWorkPackages
} from "./requirement-intake-core.js";

export function markRequirementPlanGenerationFailed(projectStatus = {}, input = {}, options = {}) {
  const requirementId = normalizeString(input.requirement_id || input.requirementId);
  const existingReviews = isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {};
  const review = requirementId ? existingReviews[requirementId] : null;
  if (!review) {
    return {
      status: "fail",
      issues: [issue("plan_review_not_found", "plan review not found for requirement", "requirement_id")]
    };
  }

  const failedAt = normalizeString(options.created_at || options.createdAt || input.created_at || input.createdAt) ||
    new Date().toISOString();
  const issues = asArray(input.issues);
  const stderr = normalizeString(input.stderr).slice(0, 2000);
  const message = normalizeString(input.message) ||
    stderr ||
    generationIssueSummary(issues) ||
    "model plan generation failed";
  const nextReview = {
    ...review,
    status: "plan_generation_failed",
    phase: "plan_generation_failed",
    generator: input.generator || input.provenance || review.generator || null,
    generation_error: {
      message,
      stderr: stderr || null,
      issues,
      failed_at: failedAt
    },
    generation_issues: issues,
    failed_at: failedAt,
    next_action: "方案生成失败，请重试生成或检查模型入口",
    action_status: "方案生成失败"
  };

  return {
    status: "pass",
    plan_review: nextReview,
    project_status: {
      ...projectStatus,
      updated_at: failedAt,
      plan_reviews: {
        ...existingReviews,
        [requirementId]: nextReview
      }
    }
  };
}

export function applyGeneratedRequirementPlan(projectStatus = {}, input = {}, options = {}) {
  const requirementId = normalizeString(input.requirement_id || input.requirementId);
  const existingReviews = isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {};
  const review = requirementId ? existingReviews[requirementId] : null;
  const requirement = asArray(projectStatus?.requirement_intake?.items).find((item) => normalizeString(item?.id) === requirementId) || {};
  if (!review) {
    return {
      status: "fail",
      issues: [issue("plan_review_not_found", "plan review not found for requirement", "requirement_id")]
    };
  }

  const generatedPlan = input.generated_plan || input.generatedPlan || input.plan || input;
  const validation = evaluateGeneratedRequirementPlan(requirement, generatedPlan);
  if (validation.status !== "pass") {
    return {
      status: "fail",
      issues: validation.issues
    };
  }

  const generatedAt = normalizeString(options.created_at || options.createdAt || input.created_at || input.createdAt) ||
    new Date().toISOString();
  const nextReview = {
    ...review,
    status: "ready_for_review",
    phase: "ready_for_review",
    plan_id: normalizeString(review.plan_id) || `plan-${safeIdPart(requirementId)}`,
    assessment_summary: validation.assessment_summary,
    proposed_acceptance_plan: validation.proposed_acceptance_plan,
    implementation_outline: validation.implementation_outline,
    acceptance_gates: validation.acceptance_gates,
    risks: validation.risks,
    generator: input.generator || input.provenance || options.generator || null,
    generated_at: generatedAt,
    next_action: "等待用户审核方案",
    action_status: "等待你确认方案"
  };
  const nextProjectStatus = {
    ...projectStatus,
    updated_at: generatedAt,
    plan_reviews: {
      ...existingReviews,
      [requirementId]: nextReview
    }
  };

  return {
    status: "pass",
    plan_review: nextReview,
    project_status: nextProjectStatus
  };
}

export function updateRequirementPlanReview(projectStatus = {}, input = {}, options = {}) {
  const requirementId = normalizeString(input.requirement_id || input.requirementId);
  const action = normalizeString(input.action).toLowerCase();
  const existingReviews = isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {};
  const review = requirementId ? existingReviews[requirementId] : null;
  if (!review) {
    return {
      status: "fail",
      issues: [issue("plan_review_not_found", "plan review not found for requirement", "requirement_id")]
    };
  }
  if (!["approve", "revise"].includes(action)) {
    return {
      status: "fail",
      issues: [issue("invalid_plan_review_action", "action must be approve or revise", "action")]
    };
  }
  if (action === "approve" && normalizeString(review.phase) !== "ready_for_review") {
    return {
      status: "fail",
      issues: [issue("plan_review_not_ready", "plan review must be generated before approval", "plan_reviews")]
    };
  }

  const reviewedAt = normalizeString(options.created_at || options.createdAt || input.created_at || input.createdAt) ||
    new Date().toISOString();
  const approved = action === "approve";
  const feedbackCategories = uniqueStrings(input.feedback_categories || input.feedbackCategories);
  const reviewNote = normalizeString(input.note);
  const nextReview = {
    ...review,
    status: approved ? "in_development" : "revising",
    phase: approved ? "in_development" : "revising",
    reviewed_at: reviewedAt,
    review_decision: action,
    review_note: reviewNote,
    feedback_categories: feedbackCategories,
    review_feedback: approved ? null : {
      categories: feedbackCategories,
      note: reviewNote,
      submitted_at: reviewedAt
    },
    next_action: approved ? "开发已开始" : "方案已退回，等待修订后重新审核",
    action_status: approved ? "开发中" : "已退回修订"
  };
  const nextProjectStatusBase = {
    ...projectStatus,
    updated_at: reviewedAt,
    plan_reviews: {
      ...existingReviews,
      [requirementId]: nextReview
    }
  };
  const nextPlanWorkPackages = approved
    ? createRequirementPlanWorkPackages(nextProjectStatusBase, requirementId)
    : asArray(projectStatus.next_work_packages || projectStatus.nextWorkPackages);
  const nextGlobalGoals = approved && nextPlanWorkPackages.length > 0
    ? asArray(projectStatus.global_goals || projectStatus.globalGoals).map((goal) => {
      const goalId = normalizeString(goal?.id || goal?.goal_id || goal?.key);
      if (goalId !== requirementId) return goal;
      return {
        ...goal,
        status: "in_progress",
        next_work_packages: nextPlanWorkPackages
      };
    })
    : asArray(projectStatus.global_goals || projectStatus.globalGoals);

  return {
    status: "pass",
    plan_review: nextReview,
    project_status: {
      ...nextProjectStatusBase,
      ...(approved && nextPlanWorkPackages.length > 0 ? { next_work_packages: nextPlanWorkPackages } : {}),
      ...(approved && nextGlobalGoals.length > 0 ? { global_goals: nextGlobalGoals } : {})
    }
  };
}

export function resetRequirementPlanGeneration(projectStatus = {}, input = {}, options = {}) {
  const requirementId = normalizeString(input.requirement_id || input.requirementId || input);
  if (!requirementId) {
    return {
      status: "fail",
      issues: [issue("missing_requirement_id", "requirement_id is required", "requirement_id")]
    };
  }

  const requestedAt = normalizeString(options.created_at || options.createdAt || input.created_at || input.createdAt) ||
    new Date().toISOString();
  const requirementIntake = isObject(projectStatus.requirement_intake) ? projectStatus.requirement_intake : {};
  const items = normalizeRequirementItems(requirementIntake.items);
  const requirement = items.find((item) => normalizeString(item.id) === requirementId) || null;
  if (!requirement) {
    return {
      status: "fail",
      issues: [issue("requirement_not_found", "requirement not found in requirement_intake.items", "requirement_intake.items")]
    };
  }

  const existingReviews = isObject(projectStatus.plan_reviews) ? projectStatus.plan_reviews : {};
  const existingReview = existingReviews[requirementId] || pendingPlanReview(requirement, requestedAt);
  const nextReview = {
    ...existingReview,
    status: "pending_plan_generation",
    phase: "pending_plan_generation",
    plan_id: null,
    assessment_summary: null,
    proposed_acceptance_plan: null,
    implementation_outline: [],
    acceptance_gates: [],
    risks: [],
    generation_error: null,
    generation_issues: [],
    failed_at: null,
    requested_at: requestedAt,
    generated_at: null,
    reviewed_at: null,
    review_decision: null,
    next_action: "等待大模型重新生成方案",
    action_status: "等待方案生成"
  };
  const nextItems = [
    {
      ...requirement,
      status: "submitted",
      updated_at: requestedAt
    },
    ...items.filter((item) => normalizeString(item.id) !== requirementId)
  ].slice(0, MAX_STORED_REQUIREMENTS);
  const nextGlobalGoals = asArray(projectStatus.global_goals || projectStatus.globalGoals)
    .map((goal) => {
      const goalId = normalizeString(goal?.id || goal?.goal_id || goal?.key);
      if (goalId !== requirementId) return goal;
      return {
        ...goal,
        status: "in_progress",
        completed: false,
        updated_at: requestedAt,
        next_work_packages: []
      };
    });

  return {
    status: "pass",
    requirement: nextItems[0],
    plan_review: nextReview,
    project_status: {
      ...projectStatus,
      updated_at: requestedAt,
      requirement_intake: {
        ...requirementIntake,
        items: nextItems,
        submitted_count: Number(requirementIntake.submitted_count || nextItems.length || 0),
        open_count: nextItems.filter((item) => !isClosedRequirementStatus(item.status)).length,
        active_requirement_id: requirementId,
        latest_requirement_id: requirementId
      },
      plan_reviews: {
        ...existingReviews,
        [requirementId]: nextReview
      },
      next_work_packages: withoutRequirementWorkPackages(projectStatus.next_work_packages || projectStatus.nextWorkPackages, requirementId),
      ...(nextGlobalGoals.length > 0 ? { global_goals: nextGlobalGoals } : {})
    }
  };
}
