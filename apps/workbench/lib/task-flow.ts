import type { ProjectionResponse } from "@/lib/api/projection";

export interface PlanReview {
  requirement_id?: string;
  requirement_title?: string;
  phase?: string;
  phase_label?: string;
  status?: string;
  status_label?: string;
  action_status?: string;
  assessment_summary?: string;
  proposed_acceptance_plan?: string;
  implementation_outline?: string[];
  acceptance_gates?: string[];
  risks?: string[];
  reviewable?: boolean;
  generation_error?: Record<string, unknown>;
  failure_reason?: string | null;
  feedback_categories?: string[];
  review_feedback?: {
    categories?: string[];
    note?: string;
    submitted_at?: string;
  } | null;
  [key: string]: unknown;
}

export interface TaskWorkPackage {
  id?: string;
  title?: string;
  action?: string;
  status?: string;
  depends_on?: string[];
  acceptance_gates?: string[];
  source?: Record<string, unknown>;
}

export interface TaskFlowItem {
  task_id: string;
  title: string;
  project_id?: string;
  project_name?: string;
  status?: string;
  status_label?: string;
  phase?: string;
  phase_label?: string;
  location_label?: string;
  submitted_at?: string;
  updated_at?: string;
  summary?: string;
  problem_statement?: string;
  constraints?: string;
  reviewable?: boolean;
  failure_reason?: string | null;
  plan_review?: PlanReview;
  work_packages?: TaskWorkPackage[];
}

export const FEEDBACK_CATEGORY_OPTIONS = [
  { label: "目标不清", value: "goal_unclear" },
  { label: "范围过大", value: "scope_too_large" },
  { label: "验收不完整", value: "acceptance_incomplete" },
  { label: "风险未覆盖", value: "risk_not_covered" },
  { label: "实施顺序需调整", value: "implementation_order" }
] as const;

export const TASK_STATUS_COLOR: Record<string, string> = {
  running: "blue",
  pending_review: "gold",
  completed: "green",
  failed: "red",
  timeout: "volcano",
  closed: "default",
  revising: "purple"
};

export function isRecoverableFailedTask(task: TaskFlowItem): boolean {
  return task.status === "failed" || task.status === "timeout";
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

export function safeText(value: unknown, fallback = "--"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

export function formatBeijingDateTime(value: unknown, fallback = "--"): string {
  const raw = safeText(value, "");
  if (!raw) return fallback;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return raw;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date).replace(/\//g, "-");
}

export function taskItemsFromProjection(projection: ProjectionResponse | null): TaskFlowItem[] {
  const projectManagement = asRecord(asRecord(projection).project_management);
  return asArray<TaskFlowItem>(projectManagement.task_items);
}

export function projectsFromProjection(projection: ProjectionResponse | null) {
  const projectManagement = asRecord(asRecord(projection).project_management);
  const projects = asArray<Record<string, unknown>>(projectManagement.projects);
  if (projects.length > 0) {
    return projects.map((project) => ({
      label: safeText(project.display_name ?? project.project_id),
      value: safeText(project.project_id, "ai-control-platform")
    }));
  }
  return [{ label: "AI Control Platform", value: "ai-control-platform" }];
}

export function findTaskById(
  projection: ProjectionResponse | null,
  taskId: string
): TaskFlowItem | null {
  return taskItemsFromProjection(projection).find((task) => task.task_id === taskId) || null;
}

export function taskDetailHref(taskId: string): string {
  return `/flow/${encodeURIComponent(taskId)}`;
}
