import { summarizeRequirementIntake } from "./requirement-intake.js";
import {
  summarizePlanReview,
  taskItemsFromProjectStatus
} from "./workbench-project-task-items.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function taskFlowFromDag(dagSummary = {}) {
  const total = Number(dagSummary.total || 0);
  const done = Number(dagSummary.by_status?.done || dagSummary.by_status?.completed || 0);
  const dispatchable = asArray(dagSummary.dispatchable).length;
  const inProgress = Math.max(0, total - done - dispatchable);

  return [
    { id: "requirements", label: "需求", status: total > 0 ? "pass" : "pending", count: total },
    { id: "breakdown", label: "拆解", status: total > 0 ? "pass" : "pending", count: total },
    { id: "subtasks", label: "子任务", status: dispatchable > 0 || inProgress > 0 ? "active" : done > 0 ? "pass" : "pending", count: total },
    { id: "review", label: "Review", status: done > 0 ? "active" : "pending", count: done },
    { id: "release", label: "发布", status: "pending", count: 0 },
    { id: "live_validation", label: "Live 验证", status: "pending", count: 0 },
    { id: "acceptance", label: "验收", status: done === total && total > 0 ? "active" : "pending", count: done }
  ];
}

function projectStatusPhase(status = "", schedulerDispatch = {}, frontendAcceptance = {}) {
  const normalized = normalizeString(status);
  if (normalizeString(schedulerDispatch.status) === "fail") return "调度修复";
  if (normalizeString(frontendAcceptance.status) === "fail") return "界面验收修复";
  if (normalized === "in_progress") return "持续开发";
  if (normalized === "completed" || normalized === "complete") return "收口验证";
  return "状态确认";
}

function managedProjectRegistry(input = {}) {
  const projectStatus = input.project_status || input.projectStatus || {};
  const managed = asArray(projectStatus.managed_projects || projectStatus.managedProjects);
  const projectManifest = input.project_manifest || input.projectManifest || {};
  const manifestExamples = asArray(projectManifest.managed_project_examples || projectManifest.managedProjectExamples);
  if (managed.length > 0) return managed;
  if (manifestExamples.length > 0) {
    return manifestExamples.map((projectId) => {
      const id = normalizeString(projectId);
      if (!id) return null;
      return { project_id: id, display_name: id };
    }).filter(Boolean);
  }
  return [{ project_id: "stock_dashboard", display_name: "股票看板" }];
}

function managedProjectEntry(managedProject = {}, projectStatus = {}) {
  const projectId = normalizeString(managedProject.project_id || managedProject.projectId) || "stock_dashboard";
  const displayName = normalizeString(managedProject.display_name || managedProject.displayName) || projectId;
  const managedSpecificStatus = isObject(projectStatus.managed_project_status || projectStatus.managedProjectStatus)
    ? (projectStatus.managed_project_status || projectStatus.managedProjectStatus)[projectId] || {}
    : {};
  return {
    project_id: projectId,
    display_name: displayName,
    type: "managed",
    status: normalizeString(managedProject.status || managedSpecificStatus.status) || "in_progress",
    phase: normalizeString(managedProject.phase || managedSpecificStatus.phase) || "状态确认",
    current_task: normalizeString(managedProject.current_task || managedProject.currentTask || managedSpecificStatus.current_task || managedSpecificStatus.next_step) || "等待业务项目状态更新",
    owner_agent: normalizeString(managedProject.owner_agent || managedProject.ownerAgent) || "platform_orchestrator",
    progress: Number(managedProject.progress || managedSpecificStatus.progress || 0),
    last_updated: normalizeString(managedProject.updated_at || managedProject.updatedAt || managedSpecificStatus.updated_at || projectStatus.updated_at) || "等待更新时间",
    risks: asArray(managedProject.risks || managedSpecificStatus.risks).filter(Boolean),
    human_decisions: 0,
    latest_run_projection_id: null,
    task_flow: taskFlowFromDag(managedSpecificStatus.dag || managedProject.dag || {})
  };
}

export function summarizeProjectManagement(input = {}, summaries = {}) {
  const projectStatus = input.project_status || input.projectStatus || {};
  const dagSummary = summaries.dagSummary || {};
  const manifestSummary = summaries.manifestSummary || {};
  const globalGoalCompletion = summaries.globalGoalCompletion || {};
  const schedulerDispatch = summaries.schedulerDispatch || {};
  const frontendAcceptance = summaries.frontendAcceptance || {};
  const nextActionReadout = summaries.nextActionReadout || {};
  const requirementIntake = summarizeRequirementIntake(projectStatus);
  const planReview = summarizePlanReview(projectStatus, requirementIntake);
  const manifestWorkPackages = asArray(input.manifest?.work_packages);
  const taskItems = taskItemsFromProjectStatus(projectStatus, requirementIntake, manifestWorkPackages);
  const taskFlow = taskFlowFromDag(dagSummary);
  const hasTaskItems = taskItems.length > 0;
  const activeTaskItems = taskItems
    .filter((item) => !["completed", "failed", "timeout", "closed"].includes(normalizeString(item.status)));
  const latestRequirement = requirementIntake.latest || null;
  const currentTask = normalizeString(
    latestRequirement?.summary ||
    nextActionReadout.reason ||
      nextActionReadout.action ||
      projectStatus.next_step ||
      projectStatus.latest_update ||
      manifestSummary.goal
  ) || "等待下一步任务";
  const fallbackActiveTasks = Math.max(
    Number(dagSummary.total || 0) - Number(dagSummary.by_status?.done || dagSummary.by_status?.completed || 0),
    asArray(dagSummary.dispatchable).length
  );
  const tasksTotal = hasTaskItems
    ? taskItems.length
    : Math.max(Number(dagSummary.total || manifestSummary.work_package_count || 0), 0);
  const activeTasks = hasTaskItems ? activeTaskItems.length : fallbackActiveTasks;
  const humanDecisions = taskItems.filter((item) => item.reviewable).length;
  const progress = Number(globalGoalCompletion.total || 0) > 0
    ? Math.round((Number(globalGoalCompletion.completed || 0) / Number(globalGoalCompletion.total || 1)) * 100)
    : 0;
  const platformProject = {
    project_id: normalizeString(projectStatus.project) || "ai-control-platform",
    display_name: "AI Control Platform",
    type: "platform",
    status: normalizeString(projectStatus.status) || "in_progress",
    phase: projectStatusPhase(projectStatus.status || "in_progress", schedulerDispatch, frontendAcceptance),
    current_task: currentTask,
    owner_agent: "main_orchestrator",
    progress,
    last_updated: normalizeString(projectStatus.updated_at) || normalizeString(input.generated_at) || "等待更新时间",
    risks: [
      normalizeString(schedulerDispatch.status) === "fail" ? "调度派发未通过" : null,
      Number(globalGoalCompletion.blocked || 0) > 0 ? "总目标存在阻塞" : null
    ].filter(Boolean),
    human_decisions: humanDecisions,
    latest_run_projection_id: input.projection_id || input.projectionId || null,
    task_flow: taskFlow
  };
  const managedProjects = managedProjectRegistry(input).map((managedProject) =>
    managedProjectEntry(managedProject, projectStatus)
  );
  const allProjects = [platformProject, ...managedProjects];
  const activeProjectCount = allProjects.filter((project) => project.status !== "completed" && project.status !== "closed").length;

  return {
    status: "available",
    source: "project_status_and_workflow_projection",
    projects_total: allProjects.length,
    active_projects: activeProjectCount,
    tasks_total: tasksTotal,
    active_tasks: activeTasks,
    released_services: 0,
    human_decisions: humanDecisions,
    projects: allProjects,
    active_work: allProjects.filter((project) => project.status !== "completed" && project.status !== "closed"),
    task_items: taskItems,
    task_flow: taskFlow,
    requirement_intake: requirementIntake,
    plan_review: planReview,
    design_alignment: {
      status: "partial",
      homepage_primary_surface: "project_management",
      diagnostics_surface: "run_diagnostics",
      required_project_id: "ai-control-platform"
    }
  };
}
