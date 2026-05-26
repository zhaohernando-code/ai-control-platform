import assert from "node:assert/strict";
import test from "node:test";

import { evaluateGlobalGoalCompletion } from "../src/workflow/global-goal-completion.js";

test("open requirement goals are not completed by a finished intake work package alone", () => {
  const result = evaluateGlobalGoalCompletion({
    project_status: {
      requirement_intake: {
        items: [
          {
            id: "requirement-frontend-refactor",
            title: "前端重构",
            status: "submitted"
          }
        ]
      },
      plan_reviews: {
        "requirement-frontend-refactor": {
          phase: "in_development"
        }
      },
      global_goals: [
        {
          id: "requirement-frontend-refactor",
          title: "前端重构",
          status: "in_progress",
          owned_files: ["."],
          next_work_packages: [
            {
              id: "requirement-frontend-refactor-intake",
              action: "continue_requirement_intake",
              owned_files: ["."]
            }
          ]
        }
      ]
    },
    workflow_state: {
      manifest: {
        work_packages: [
          {
            id: "requirement-frontend-refactor-intake",
            global_goal_id: "requirement-frontend-refactor",
            status: "completed"
          }
        ]
      }
    }
  });

  assert.equal(result.status, "in_progress");
  assert.equal(result.completed, 0);
  assert.equal(result.pending, 1);
  assert.equal(result.next_goal.id, "requirement-frontend-refactor");
  assert.equal(result.next_work_packages[0].global_goal_id, "requirement-frontend-refactor");
});

test("completed non-requirement goals still close from completed work packages", () => {
  const result = evaluateGlobalGoalCompletion({
    project_status: {
      global_goals: [
        {
          id: "platform-foundation",
          title: "Platform foundation",
          status: "in_progress"
        }
      ]
    },
    workflow_state: {
      manifest: {
        work_packages: [
          {
            id: "foundation-runtime",
            global_goal_id: "platform-foundation",
            status: "completed"
          }
        ]
      }
    }
  });

  assert.equal(result.status, "complete");
  assert.equal(result.completed, 1);
  assert.equal(result.pending, 0);
});
