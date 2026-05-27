import { fetchWorkbenchJson } from "./index";
import type { ProjectionResponse } from "./projection";

export interface RequirementSubmissionInput {
  title: string;
  project_id: string;
  surface_area?: string;
  problem_statement: string;
  constraints?: string;
  plan_review_requested: true;
  generate_plan: true;
  plan_generation_mode: "model";
  created_at?: string;
}

export interface RequirementSubmissionResponse {
  status: "created" | string;
  requirement?: {
    id?: string;
    title?: string;
    [key: string]: unknown;
  };
  plan_review?: Record<string, unknown>;
  projection?: ProjectionResponse;
  submitted_projection?: ProjectionResponse;
  auto_advance?: Record<string, unknown>;
  plan_generation?: {
    status?: string;
    issues?: Array<Record<string, unknown>>;
  };
  [key: string]: unknown;
}

export interface PlanReviewUpdateInput {
  requirement_id: string;
  action: "approve" | "revise";
  note?: string;
  feedback_categories?: string[];
  auto_advance_after_plan_review?: boolean;
  auto_advance_max_iterations?: number;
  created_at?: string;
}

export interface PlanReviewUpdateResponse {
  status: "updated" | string;
  plan_review?: Record<string, unknown>;
  projection?: ProjectionResponse;
  submitted_projection?: ProjectionResponse;
  auto_advance?: Record<string, unknown>;
  [key: string]: unknown;
}

export function submitRequirement(
  input: RequirementSubmissionInput
): Promise<RequirementSubmissionResponse> {
  return fetchWorkbenchJson<RequirementSubmissionResponse>("/api/workbench/requirements", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}

export function updatePlanReview(
  input: PlanReviewUpdateInput
): Promise<PlanReviewUpdateResponse> {
  return fetchWorkbenchJson<PlanReviewUpdateResponse>("/api/workbench/plan-reviews", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input)
  });
}
