import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTINUE,
  decideContinuation,
  REVIEWER_SMOKE_STALL_THRESHOLD,
  reviewerProviderSmokeStall,
  STOP_FOR_HUMAN
} from "../src/workflow/autonomous-continuation.js";

function projectStatus(overrides = {}) {
  return {
    project: "ai-control-platform",
    blockers: [],
    next_step: "Start the PC/mobile workbench frontend shell against validated projection JSON.",
    ...overrides
  };
}

test("provider health fallback schedules model fallback work package", () => {
  const decision = decideContinuation({
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass" },
    reviewer_provider_health: {
      recovery_status: "blocked",
      provider_health: "unhealthy",
      scheduled_actions: ["fallback_model_or_defer_external_review"],
      retry_strategy: "fallback_model_or_defer_external_review"
    }
  });

  assert.equal(decision.action, CONTINUE);
  assert.equal(decision.next_work_packages[0].id, "reviewer-provider-fallback-model-or-defer-external-review");
  assert.deepEqual(decision.next_work_packages[0].owned_files, ["src/workflow/model-router.js", "src/workflow/reviewer-provider-health.js"]);
});

function smokeNeedsEvent(index) {
  return {
    type: "reviewer_provider_health",
    metadata: {
      recovery_status: "needs_smoke_check",
      scheduled_actions: ["provider_smoke_check"],
      provider_health: "unknown",
      retry_strategy: "run_provider_smoke_check",
      sequence: index
    }
  };
}

test("provider health needs_smoke_check below threshold still schedules smoke", () => {
  const input = {
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass" },
    workflow_state: {
      manifest: {
        events: [smokeNeedsEvent(1)]
      }
    },
    reviewer_provider_health: {
      recovery_status: "needs_smoke_check",
      provider_health: "unknown",
      scheduled_actions: ["provider_smoke_check"],
      retry_strategy: "run_provider_smoke_check"
    }
  };
  const stall = reviewerProviderSmokeStall(input);
  assert.equal(stall.stalled, false);
  assert.equal(stall.smoke_check_count, 1);

  const decision = decideContinuation(input);
  assert.equal(decision.next_work_packages[0].id, "reviewer-provider-provider-smoke-check");
  assert.equal(decision.action, CONTINUE);
});

test("provider health stops for human after consecutive smoke requests reach threshold", () => {
  const events = [];
  for (let i = 0; i < REVIEWER_SMOKE_STALL_THRESHOLD; i += 1) {
    events.push(smokeNeedsEvent(i + 1));
  }

  const input = {
    project_status: projectStatus({ next_step: "" }),
    run_evaluation: { status: "pass" },
    workflow_state: { manifest: { events } },
    reviewer_provider_health: {
      recovery_status: "needs_smoke_check",
      provider_health: "unknown",
      scheduled_actions: ["provider_smoke_check"],
      retry_strategy: "run_provider_smoke_check"
    }
  };

  const stall = reviewerProviderSmokeStall(input);
  assert.equal(stall.stalled, true);
  assert.equal(stall.smoke_check_count, REVIEWER_SMOKE_STALL_THRESHOLD);
  assert.ok(stall.reason);

  const decision = decideContinuation(input);
  assert.equal(decision.action, STOP_FOR_HUMAN);
  assert.equal(decision.should_continue, false);
  const stallBlocker = decision.blockers.find((blocker) => blocker.id === "reviewer_provider_smoke_stalled");
  assert.ok(stallBlocker);
  assert.equal(stallBlocker.category, "recovery_exhausted");
  assert.equal(stallBlocker.requires_human, true);
  assert.equal(stallBlocker.smoke_check_count, REVIEWER_SMOKE_STALL_THRESHOLD);
  assert.equal(decision.next_work_packages.find((pkg) => pkg.id === "reviewer-provider-provider-smoke-check"), undefined);
});

test("smoke stall counter resets when a non-smoke health event interrupts the streak", () => {
  const input = {
    workflow_state: {
      manifest: {
        events: [
          smokeNeedsEvent(1),
          {
            type: "reviewer_provider_health",
            metadata: {
              recovery_status: "blocked",
              scheduled_actions: ["fallback_model_or_defer_external_review"],
              provider_health: "unhealthy"
            }
          },
          smokeNeedsEvent(2)
        ]
      }
    }
  };
  const stall = reviewerProviderSmokeStall(input);
  assert.equal(stall.stalled, false);
  assert.equal(stall.smoke_check_count, 1);
});
