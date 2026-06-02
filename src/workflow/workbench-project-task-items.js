import { userFacingProviderFailureReason } from "./provider-failure-reason.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

const KNOWN_PROJECT_DISPLAY_NAMES = {
  "ai-control-platform": "AI Control Platform",
  "stock_dashboard": "股票看板",
  "lobechat": "LobeChat"
};

function projectDisplayName(projectId = "") {
  return KNOWN_PROJECT_DISPLAY_NAMES[normalizeString(projectId)] || projectId || "AI Control Platform";
}
export function summarizePlanReview(projectStatus = {}, requirementIntake = {}) {
  const latest = requirementIntake?.latest || null;
  if (!latest) {
    return {
      status: "not_configured",
      status_label: "暂无需要评估的需求",
      summary: "提交需求后，平台会先让大模型生成评估方案和验收方案，再由你审核。",
      requirement_id: null,
      requirement_title: null,
      plan_id: null,
      phase: "idle",
      phase_label: "等待评估",
      next_action: "提交需求即可进入评估",
      assessment_summary: null,
      proposed_acceptance_plan: null,
      reviewable: false,
      action_status: "等待方案生成",
      origin: "workbench_requirement_intake"
    };
  }
  const requirementTitle = normalizeString(latest.title) || null;
  const planReviewRecord = (projectStatus?.plan_reviews && projectStatus.plan_reviews[latest.id]) || null;
  const phase = normalizeString(planReviewRecord?.phase) || "pending_plan_generation";
  const failureReason = normalizeString(planReviewRecord?.generation_error?.message || planReviewRecord?.failure_reason);
  const reviewable = phase === "ready_for_review";
  const phaseLabelMap = {
    pending_plan_generation: "等待大模型生成方案",
    plan_generation_failed: "方案生成失败",
    ready_for_review: "方案待你审核",
    in_development: "开发中",
    revising: "方案退回修订",
    idle: "等待评估"
  };
  const statusLabel = reviewable
    ? "方案待审核"
    : phase === "in_development"
      ? "开发中"
      : phase === "revising"
        ? "方案已退回"
        : phase === "plan_generation_failed"
          ? "方案生成失败"
          : "评估进行中";
  const storedNextAction = normalizeString(planReviewRecord?.next_action);
  const nextAction = phase === "in_development"
    ? "开发已开始"
    : storedNextAction || (reviewable
    ? "请审核大模型生成的评估方案与验收方案"
    : phase === "revising"
        ? "等待方案修订后重新审核"
        : phase === "plan_generation_failed"
          ? "方案生成失败，请重试生成或检查模型入口"
        : "等待大模型完成评估方案与验收方案");
  const storedActionStatus = normalizeString(planReviewRecord?.action_status);
  const actionStatus = phase === "in_development"
    ? "开发中"
    : storedActionStatus || (reviewable ? "等待你确认方案" : phase === "plan_generation_failed" ? "方案生成失败" : "等待方案生成");
  return {
    status: "available",
    status_label: statusLabel,
    summary: requirementTitle
      ? `当前评估：${requirementTitle}。大模型会基于现状与目标生成评估摘要与验收方案，再由你审核。`
      : "提交需求后，平台会让大模型生成评估方案与验收方案，再由你审核。",
    requirement_id: latest.id || null,
    requirement_title: requirementTitle,
    plan_id: normalizeString(planReviewRecord?.plan_id) || null,
    phase,
    phase_label: phaseLabelMap[phase] || phase,
    next_action: nextAction,
    assessment_summary: normalizeString(planReviewRecord?.assessment_summary) ||
      (phase === "plan_generation_failed" && failureReason ? `生成失败：${failureReason}` : null),
    proposed_acceptance_plan: normalizeString(planReviewRecord?.proposed_acceptance_plan) || null,
    reviewable,
    action_status: actionStatus,
    failure_reason: failureReason || null,
    generation_error: planReviewRecord?.generation_error || null,
    generation_issues: asArray(planReviewRecord?.generation_issues),
    origin: "workbench_requirement_intake"
  };
}

function taskWorkPackagesForRequirement(projectStatus = {}, requirementId = "", manifestWorkPackages = []) {
  const id = normalizeString(requirementId);
  if (!id) return [];
  const directPackages = asArray(projectStatus.next_work_packages || projectStatus.nextWorkPackages);
  const goalPackages = asArray(projectStatus.global_goals || projectStatus.globalGoals)
    .flatMap((goal) => asArray(goal?.next_work_packages || goal?.nextWorkPackages));
  const manifestById = new Map(
    asArray(manifestWorkPackages).map((wp) => [normalizeString(wp?.id || wp?.work_package_id), wp])
  );
  const seen = new Set();
  return [...directPackages, ...goalPackages]
    .filter((workPackage) => {
      const sourceRequirementId = normalizeString(workPackage?.source?.requirement_id || workPackage?.source?.requirementId);
      const globalGoalId = normalizeString(workPackage?.global_goal_id || workPackage?.globalGoalId);
      return sourceRequirementId === id || globalGoalId === id;
    })
    .filter((workPackage) => {
      const packageId = normalizeString(workPackage?.id || workPackage?.work_package_id || workPackage?.workPackageId);
      if (!packageId || seen.has(packageId)) return false;
      seen.add(packageId);
      return true;
    })
    .map((workPackage) => {
      const packageId = normalizeString(workPackage.id || workPackage.work_package_id || workPackage.workPackageId);
      const manifestWp = manifestById.get(packageId) || {};
      const merged = { ...manifestWp, ...workPackage };
      const failureIssues = asArray(merged.failure_issues || merged.failureIssues);
      const dispatchExecutorProvenance = merged.dispatch_executor_provenance || merged.dispatchExecutorProvenance || {};
      const dispatchPackageResults = asArray(merged.dispatch_package_results || merged.dispatchPackageResults);
      const providerAttempts = asArray(dispatchExecutorProvenance.provider_attempts || dispatchExecutorProvenance.providerAttempts);
      const latestAttempt = providerAttempts.at(-1) || null;
      const dispatchArtifact = merged.dispatch_artifact || merged.dispatchArtifact || null;
      const rawFailureReason = normalizeString(
        merged.failure_reason || merged.failureReason ||
        merged.error?.message || merged.error_message ||
        failureIssues.map((fi) => fi.message).filter(Boolean).join("; ") ||
        merged.issues?.[0]?.message
      );
      const readableFailureReason = userFacingProviderFailureReason({
        failureIssues,
        dispatchPackageResults,
        providerAttempts,
        latestAttempt,
        explicitReason: rawFailureReason
      });
      const dispatchSummary = normalizeString(merged.dispatch_run_id || merged.dispatchRunId)
        ? {
          dispatch_run_id: normalizeString(merged.dispatch_run_id || merged.dispatchRunId),
          dispatch_started_at: normalizeString(merged.dispatch_started_at || merged.dispatchStartedAt) || null,
          dispatch_completed_at: normalizeString(merged.dispatch_completed_at || merged.dispatchCompletedAt || merged.completed_at || merged.completedAt) || null,
          dispatch_failed_at: normalizeString(merged.dispatch_failed_at || merged.dispatchFailedAt) || null,
          artifact_id: normalizeString(dispatchArtifact?.id || dispatchArtifact?.artifact_id || dispatchArtifact?.artifactId) || null,
          artifact_uri: normalizeString(dispatchArtifact?.uri) || null,
          artifact_path: normalizeString(dispatchArtifact?.path) || null,
          phase: normalizeString(dispatchArtifact?.phase || merged.phase) || null,
          issue_codes: failureIssues.map((fi) => normalizeString(fi.code)).filter(Boolean),
          attempt_count: providerAttempts.length,
          latest_attempt: latestAttempt
            ? {
              model: normalizeString(latestAttempt.model) || null,
              issue: normalizeString(latestAttempt.issue) || null,
              status: normalizeString(latestAttempt.status) || null,
              timed_out: latestAttempt.timed_out === true || latestAttempt.timedOut === true,
              exit_code: Number.isFinite(Number(latestAttempt.exit_code || latestAttempt.exitCode))
                ? Number(latestAttempt.exit_code || latestAttempt.exitCode)
                : null
            }
            : null,
          package_results: dispatchPackageResults.map((result) => ({
            work_package_id: normalizeString(result.work_package_id || result.workPackageId || result.id),
            status: normalizeString(result.status),
            result: normalizeString(result.result)
          })).filter((result) => result.work_package_id)
        }
        : null;
      return {
        id: packageId,
        title: normalizeString(merged.title),
        action: normalizeString(merged.action),
        status: normalizeString(merged.status) || "pending",
        result: normalizeString(merged.result) || null,
        depends_on: asArray(merged.depends_on || merged.dependsOn).map(normalizeString).filter(Boolean),
        acceptance_gates: asArray(merged.acceptance_gates || merged.acceptanceGates).map(normalizeString).filter(Boolean),
        source: merged.source || {},
        failure_reason: readableFailureReason || rawFailureReason || null,
        failure_issues: failureIssues,
        ...(dispatchSummary ? { dispatch_summary: dispatchSummary } : {})
      };
    });
}

function latestDispatchSummary(workPackages = []) {
  return asArray(workPackages)
    .map((workPackage) => workPackage.dispatch_summary)
    .filter(Boolean)
    .sort((left, right) => normalizeString(right.dispatch_failed_at || right.dispatch_completed_at || right.dispatch_started_at)
      .localeCompare(normalizeString(left.dispatch_failed_at || left.dispatch_completed_at || left.dispatch_started_at)))[0] || null;
}

function requirementGoalCompleted(projectStatus = {}, requirementId = "") {
  const id = normalizeString(requirementId);
  if (!id) return false;
  return asArray(projectStatus.global_goals || projectStatus.globalGoals)
    .some((goal) => {
      const goalId = normalizeString(goal?.id || goal?.goal_id || goal?.key);
      const status = normalizeString(goal?.status).toLowerCase();
      return goalId === id && ["completed", "complete", "accepted", "closed"].includes(status);
    });
}

function workPackageExecutionStatus(workPackages = []) {
  const statuses = asArray(workPackages)
    .map((workPackage) => normalizeString(workPackage?.status).toLowerCase())
    .filter(Boolean);
  if (statuses.some((status) => ["running", "active", "in_progress", "in-progress"].includes(status))) {
    return "running";
  }
  if (statuses.some((status) => ["failed", "fail", "blocked", "error"].includes(status))) {
    return "failed";
  }
  if (statuses.some((status) => ["pending", "queued", "ready", "rerun"].includes(status))) {
    return "pending_execution";
  }
  if (statuses.length > 0 && statuses.every((status) => ["completed", "complete", "pass", "passed", "done"].includes(status))) {
    return "completed";
  }
  return "";
}

function taskStatusForPlanPhase(phase = "", review = {}, requirement = {}, projectStatus = {}, workPackages = []) {
  const normalizedPhase = normalizeString(phase) || "pending_plan_generation";
  const requirementStatus = normalizeString(requirement.status).toLowerCase();
  const reviewStatus = normalizeString(review.status).toLowerCase();
  const failureText = normalizeString(
    review?.generation_error?.message ||
      review?.generation_error?.stderr ||
      review?.failure_reason
  );
  const timedOut = /timeout|timed\s*out|超时/i.test(failureText);
  if (["closed_failed", "canceled", "cancelled"].includes(requirementStatus) || ["closed_failed", "canceled", "cancelled"].includes(reviewStatus) || ["closed_failed", "canceled", "cancelled"].includes(normalizedPhase)) {
    return {
      status: "closed",
      status_label: "已关闭",
      phase: normalizedPhase,
      phase_label: "失败已关闭",
      location_label: "任务归档"
    };
  }
  if (
    ["completed", "complete", "accepted", "closed"].includes(requirementStatus) ||
    ["completed", "complete", "accepted", "closed"].includes(reviewStatus) ||
    normalizedPhase === "completed" ||
    requirementGoalCompleted(projectStatus, requirement.id)
  ) {
    return {
      status: "completed",
      status_label: "完成",
      phase: normalizedPhase,
      phase_label: "验收完成",
      location_label: "完成归档"
    };
  }
  if (normalizedPhase === "ready_for_review") {
    return {
      status: "pending_review",
      status_label: "待审视",
      phase: normalizedPhase,
      phase_label: "计划审视",
      location_label: "人工决策"
    };
  }
  if (normalizedPhase === "in_development") {
    const executionStatus = workPackageExecutionStatus(workPackages);
    if (executionStatus === "pending_execution") {
      return {
        status: "pending_execution",
        status_label: "待执行",
        phase: normalizedPhase,
        phase_label: "等待派发",
        location_label: "执行队列"
      };
    }
    if (executionStatus === "failed") {
      return {
        status: "failed",
        status_label: "失败",
        phase: normalizedPhase,
        phase_label: "执行失败",
        location_label: "执行队列"
      };
    }
    if (executionStatus === "completed") {
      return {
        status: "completed",
        status_label: "完成",
        phase: normalizedPhase,
        phase_label: "任务包完成",
        location_label: "完成归档"
      };
    }
    return {
      status: "running",
      status_label: "运行中",
      phase: normalizedPhase,
      phase_label: "开发执行",
      location_label: "执行队列"
    };
  }
  if (normalizedPhase === "revising") {
    return {
      status: "revising",
      status_label: "待修订",
      phase: normalizedPhase,
      phase_label: "方案修订",
      location_label: "方案回写"
    };
  }
  if (normalizedPhase === "plan_generation_failed") {
    return {
      status: timedOut ? "timeout" : "failed",
      status_label: timedOut ? "超时" : "失败",
      phase: normalizedPhase,
      phase_label: timedOut ? "计划生成超时" : "计划生成失败",
      location_label: "计划生成"
    };
  }
  return {
    status: "pending_plan_generation",
    status_label: "待生成",
    phase: normalizedPhase,
    phase_label: "等待方案生成",
    location_label: "计划生成"
  };
}

function taskCanRecover(status = {}, review = {}) {
  const normalizedStatus = normalizeString(status.status);
  const normalizedPhase = normalizeString(status.phase || review.phase);
  return ["pending_plan_generation", "pending_execution", "failed", "timeout"].includes(normalizedStatus) ||
    ["pending_plan_generation", "plan_generation_failed"].includes(normalizedPhase);
}

export function taskItemsFromProjectStatus(projectStatus = {}, requirementIntake = {}, manifestWorkPackages = []) {
  const planReviews = projectStatus?.plan_reviews && typeof projectStatus.plan_reviews === "object"
    ? projectStatus.plan_reviews
    : {};
  return asArray(requirementIntake.items).map((requirement) => {
    const requirementId = normalizeString(requirement.id);
    const review = planReviews[requirementId] || {};
    const workPackages = taskWorkPackagesForRequirement(projectStatus, requirementId, manifestWorkPackages);
    const latestDispatch = latestDispatchSummary(workPackages);
    const status = taskStatusForPlanPhase(review.phase, review, requirement, projectStatus, workPackages);
    const latestUpdate = normalizeString(
      latestDispatch?.dispatch_failed_at ||
      latestDispatch?.dispatch_completed_at ||
      latestDispatch?.dispatch_started_at ||
      review.reviewed_at ||
      review.generated_at ||
      review.created_at ||
      requirement.submitted_at
    );
    return {
      task_id: requirementId,
      title: normalizeString(requirement.title) || requirementId,
      project_id: normalizeString(requirement.project_id || requirement.projectId) || "ai-control-platform",
      project_name: normalizeString(requirement.project_name || requirement.projectName) ||
        projectDisplayName(normalizeString(requirement.project_id || requirement.projectId)) || "AI Control Platform",
      status: status.status,
      status_label: status.status_label,
      phase: status.phase,
      phase_label: status.phase_label,
      location_label: status.location_label,
      submitted_at: normalizeString(requirement.submitted_at || requirement.created_at),
      updated_at: latestUpdate,
      summary: normalizeString(requirement.summary),
      problem_statement: normalizeString(requirement.problem_statement || requirement.problemStatement),
      constraints: normalizeString(requirement.constraints),
      reviewable: status.phase === "ready_for_review",
      recoverable: taskCanRecover(status, review),
      failure_reason: normalizeString(review?.generation_error?.message || review?.failure_reason) ||
        workPackages.filter((wp) => ["failed", "fail", "error", "timeout"].includes(normalizeString(wp.status).toLowerCase()))
          .map((wp) => wp.failure_reason || `${wp.title || wp.id} 执行失败`)
          .join("; ") || null,
      ...(latestDispatch ? { latest_dispatch: latestDispatch } : {}),
      plan_review: {
        ...(review || {}),
        requirement_id: requirementId,
        requirement_title: normalizeString(requirement.title) || normalizeString(review.requirement_title),
        reviewable: status.phase === "ready_for_review"
      },
      work_packages: workPackages
    };
  });
}
