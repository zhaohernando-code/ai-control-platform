import { createProjectionSource } from "./projection-source.js";

const source = createProjectionSource();
let currentProjection = null;
let currentProjectionId = null;

function text(value, fallback = "--") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function qs(selector) {
  return document.querySelector(selector);
}

function qsa(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function setText(name, value) {
  qsa(`[data-bind="${name}"]`).forEach((node) => {
    node.textContent = text(value);
  });
}

function firstReason(projection) {
  return projection.reasons?.[0] || `${projection.decision} via validated projection`;
}

function renderNextActions(projection) {
  const actions = projection.one_screen?.next_actions || projection.next_actions || [];
  const lists = qsa('[data-list="next_actions"]');
  const rows = actions.length > 0 ? actions : [{ id: "none", action: "idle", title: "暂无可派发任务" }];

  for (const list of lists) {
    list.replaceChildren(
      ...rows.map((action, index) => {
        const item = document.createElement("article");
        item.className = list.classList.contains("mobile-list") ? "mobile-action" : "timeline-item";
        item.innerHTML = `<strong>${index + 1}. ${text(action.title || action.id)}</strong><span>${text(action.action)}</span>`;
        return item;
      })
    );
  }
}

function renderOperationsTimeline(projection) {
  const operations = projection.operations_timeline?.items || [];
  const lists = qsa('[data-list="operations_timeline"]');
  const rows = operations.length > 0
    ? operations.slice(-6).reverse()
    : [{ type: "not_configured", status: "idle", summary: "暂无运行事件" }];

  for (const list of lists) {
    list.replaceChildren(
      ...rows.map((item) => {
        const row = document.createElement("article");
        row.className = list.classList.contains("mobile-list") ? "mobile-action" : "timeline-item";
        row.innerHTML = `<strong>${text(item.group)} · ${text(item.next_action_role)}</strong><span>${text(item.type)} / ${text(item.summary)}</span>`;
        return row;
      })
    );
  }
}

function renderModelRoles(projection) {
  const list = qs('[data-list="model_roles"]');
  if (!list) return;

  const roles = projection.model_routing?.by_model
    ? Object.entries(projection.model_routing.by_model).map(([model, count]) => ({ model, count }))
    : [];
  const rows = roles.length > 0 ? roles : [{ model: projection.model_routing?.selected_model || "--", count: 1 }];

  list.replaceChildren(
    ...rows.map((role) => {
      const item = document.createElement("article");
      item.className = "role-item";
      item.innerHTML = `<strong>${text(role.model)}</strong><span>${role.count} role(s)</span>`;
      return item;
    })
  );
}

function renderProjection(projection) {
  const counters = projection.one_screen?.counters || projection.counters || {};
  const reviewer = projection.reviewer_gate || projection.reviewer || {};
  const model = projection.model_routing || projection.model || {};
  const closeout = projection.closeout || {};
  const browserEvents = projection.workbench_browser_events || {};
  const resumeHealth = projection.resume_health || {};
  const providerHealth = projection.reviewer_provider_health || projection.provider_health || {};
  const scopeSplit = projection.reviewer_scope_split || projection.scope_split || {};
  const shardReview = projection.reviewer_shard_review || projection.shard_review || {};
  const schedulerDispatch = projection.scheduler_dispatch || {};
  const schedulerContinuation = projection.scheduler_continuation || {};
  const schedulerLoop = projection.scheduler_loop || {};
  const lifecyclePool = projection.agent_lifecycle_pool || {};
  const globalGoals = projection.global_goal_completion || {};
  const nextActionReadout = projection.next_action_readout || {};
  const nextActionTerminal = projection.next_action_terminal || {};

  setText("run_id", projection.run_id);
  setText("cycle_id", projection.cycle_id);
  setText("status", projection.status);
  setText("status_short", String(projection.status || "--").slice(0, 8));
  setText("decision", projection.decision);
  setText("headline", projection.one_screen?.headline || projection.headline || projection.goal);
  setText("reason", firstReason(projection));
  setText("selected_model", model.selected_model);
  setText("model_summary", `${text(model.preferred_model)} -> ${text(model.selected_model)}`);
  setText("reviewer_status", reviewer.status);
  setText("reviewer_signal", reviewer.recommended_decision_signal);
  setText("reviewer_severity", reviewer.max_severity);
  setText("reviewer_failed", reviewer.counts?.failed ?? 0);
  setText("reviewer_rollback", reviewer.counts?.rollback ?? 0);
  setText("reviewer_human", reviewer.counts?.human ?? 0);
  setText("counter_work_packages", counters.work_packages ?? 0);
  setText("counter_artifacts", counters.artifacts ?? 0);
  setText("counter_reviewer_findings", counters.reviewer_findings ?? 0);
  setText("counter_dispatchable_tasks", counters.dispatchable_tasks ?? 0);
  setText("counter_scheduler_dispatch_steps", counters.scheduler_dispatch_steps ?? schedulerDispatch.step_count ?? 0);
  setText("counter_global_goals_pending", counters.global_goals_pending ?? globalGoals.pending ?? 0);
  setText("counter_global_goals_completed", counters.global_goals_completed ?? globalGoals.completed ?? 0);
  setText("counter_operation_events", counters.operation_events ?? projection.operations_timeline?.count ?? 0);
  setText("closeout_status", closeout.status);
  setText("closeout_publish_status", closeout.publish_status);
  setText("closeout_snapshot", closeout.snapshot_id);
  setText("closeout_artifact", closeout.artifact_id || closeout.path || closeout.uri);
  setText("ui_verification_status", browserEvents.status);
  setText("ui_verification_scenarios", browserEvents.scenario_count ?? 0);
  setText("ui_verification_partial", browserEvents.partial_shard_ready === true ? "ready" : "not ready");
  setText("ui_verification_artifact", browserEvents.artifact_id);
  setText("resume_health_status", resumeHealth.status);
  setText("resume_replay_status", resumeHealth.replay_status);
  setText("resume_issue_count", resumeHealth.issue_count ?? 0);
  setText("resume_latest_issue", resumeHealth.latest_issue);
  setText("resume_artifact", resumeHealth.artifact_id);
  setText("provider_health_status", providerHealth.status);
  setText("provider_health_value", providerHealth.provider_health);
  setText("provider_next_action", providerHealth.next_action);
  setText("provider_retry_strategy", providerHealth.retry_strategy);
  setText("scope_split_status", scopeSplit.status);
  setText("scope_split_shards", scopeSplit.shard_count ?? 0);
  setText("scope_split_pending", scopeSplit.pending_shards ?? 0);
  setText("scope_split_next", scopeSplit.next_shard);
  setText("shard_review_status", shardReview.status);
  setText("shard_review_completed", shardReview.completed_shards ?? 0);
  setText("shard_review_failed", shardReview.failed_finding_count ?? 0);
  setText("shard_review_next", shardReview.next_shard);
  setText("shard_review_executor", shardReview.latest_executor_kind);
  setText("shard_review_profile", shardReview.latest_execution_profile);
  setText("shard_review_budget", shardReview.latest_external_call_budget_used ?? 0);
  setText("scheduler_dispatch_status", schedulerDispatch.status);
  setText("scheduler_dispatch_phase", schedulerDispatch.phase);
  setText("scheduler_dispatch_steps", schedulerDispatch.step_count ?? 0);
  setText("scheduler_dispatch_failed", schedulerDispatch.failed_step_count ?? 0);
  setText("scheduler_dispatch_dry_run", schedulerDispatch.dry_run === true ? "yes" : "no");
  setText("scheduler_dispatch_artifact", schedulerDispatch.artifact_id);
  setText("scheduler_policy_status", schedulerDispatch.policy_status);
  setText("scheduler_policy_mode", schedulerDispatch.policy_execution_mode);
  setText("scheduler_policy_issues", schedulerDispatch.policy_issue_count ?? 0);
  setText("scheduler_policy_reason", schedulerDispatch.policy_latest_issue);
  setText("scheduler_next_status", schedulerDispatch.next_continuation_status);
  setText("scheduler_next_packages", schedulerDispatch.next_work_package_count ?? 0);
  setText("scheduler_next_action", schedulerDispatch.next_continuation_action);
  setText("scheduler_continuation_status", schedulerContinuation.continuation_status || schedulerContinuation.status);
  setText("scheduler_continuation_ready", schedulerContinuation.ready === true ? "ready" : "not ready");
  setText("scheduler_continuation_enqueue", schedulerContinuation.enqueue_status);
  setText("scheduler_continuation_path", schedulerContinuation.continuation_input_path);
  setText("scheduler_loop_status", schedulerLoop.status);
  setText("scheduler_loop_phase", schedulerLoop.phase);
  setText("scheduler_loop_iterations", schedulerLoop.iteration_count ?? 0);
  setText("scheduler_loop_latest", schedulerLoop.latest_projection_id);
  setText("scheduler_loop_recovery", schedulerLoop.recovery_status);
  setText("scheduler_loop_action", schedulerLoop.terminal_action || schedulerLoop.recovery_action);
  setText("scheduler_loop_strategy", schedulerLoop.execution_strategy || schedulerLoop.execution_profile);
  setText("scheduler_loop_resume_status", schedulerLoop.latest_resume_status);
  setText("agent_lifecycle_pool_status", lifecyclePool.status);
  setText("agent_lifecycle_pool_open", lifecyclePool.open ?? 0);
  setText("agent_lifecycle_pool_unevaluated", lifecyclePool.unevaluated ?? 0);
  setText("agent_lifecycle_pool_unclosed", lifecyclePool.unclosed ?? 0);
  setText("agent_lifecycle_pool_timed_out", lifecyclePool.timed_out ?? 0);
  setText("agent_lifecycle_pool_heartbeats", lifecyclePool.heartbeat_count ?? 0);
  setText("agent_lifecycle_pool_latest_heartbeat", lifecyclePool.latest_heartbeat_at);
  setText("agent_lifecycle_pool_latest_timeout", lifecyclePool.latest_timeout_at);
  setText("agent_lifecycle_pool_next_action", lifecyclePool.next_action);
  setText("global_goals_status", globalGoals.status);
  setText("global_goals_total", globalGoals.total ?? 0);
  setText("global_goals_pending", globalGoals.pending ?? 0);
  setText("global_goals_completed", globalGoals.completed ?? 0);
  setText("global_goals_blocked", globalGoals.blocked ?? 0);
  setText("global_goals_next", globalGoals.next_goal?.title || globalGoals.next_goal?.id);
  setText("next_action_readout_status", nextActionReadout.status);
  setText("next_action_readout_action", nextActionReadout.action || projection.one_screen?.recommended_action);
  setText("next_action_readout_source", nextActionReadout.source_type);
  setText("next_action_terminal_status", nextActionTerminal.status);
  setText("next_action_terminal_action", nextActionTerminal.terminal_action);
  setText("next_action_terminal_reason", nextActionTerminal.terminal_reason);

  renderNextActions(projection);
  renderOperationsTimeline(projection);
  renderModelRoles(projection);
}

function projectionUrlForHistoryItem(item) {
  if (!item?.id) return source.url;
  if (source.url.includes("/api/workbench/projection")) {
    const separator = source.url.includes("?") ? "&" : "?";
    return `${source.url}${separator}id=${encodeURIComponent(item.id)}`;
  }
  return item.projection_path ? `../../${item.projection_path}` : source.url;
}

async function renderHistorySelect() {
  const selects = qsa("[data-history-select]");
  if (selects.length === 0) return;

  try {
    const history = await source.loadHistory();
    currentProjectionId = currentProjectionId || history.latest || null;
    for (const select of selects) {
      select.replaceChildren(
        ...history.items.map((item) => {
          const option = document.createElement("option");
          option.value = projectionUrlForHistoryItem(item);
          option.dataset.projectionId = item.id || "";
          option.textContent = `${item.label} · ${item.status}`;
          option.selected = item.id === history.latest;
          return option;
        })
      );
      select.addEventListener("change", async () => {
        currentProjectionId = select.selectedOptions[0]?.dataset.projectionId || null;
        await main(select.value, currentProjectionId);
      });
    }
  } catch {
    for (const select of selects) {
      select.replaceChildren(new Option("Projection history unavailable", source.url));
    }
  }
}

async function main(url = null, projectionId = null) {
  try {
    const projection = url ? await createProjectionSource({ url }).load() : await source.load();
    currentProjection = projection;
    if (projectionId) currentProjectionId = projectionId;
    renderProjection(projection);
  } catch (error) {
    renderProjection({
      status: "human_intervention",
      decision: "projection_load_failed",
      goal: "Projection 加载失败",
      reasons: [error.message],
      one_screen: {
        counters: {}
      },
      reviewer_gate: {},
      model_routing: {}
    });
  }
}

qsa("[data-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    const action = button.dataset.action;
    const runId = currentProjection?.run_id;
    const cycleId = currentProjection?.cycle_id;

    if (!action || !runId || !cycleId) {
      button.dataset.eventState = "failed";
      button.textContent = "事件未写入";
      return;
    }

    try {
      await source.recordEvent({
        action,
        run_id: runId,
        cycle_id: cycleId,
        metadata: {
          status: currentProjection?.status || null,
          decision: currentProjection?.decision || null
        }
      });
      button.dataset.eventState = "recorded";
    } catch {
      button.dataset.eventState = "failed";
      button.textContent = "事件写入失败";
      return;
    }

    if (button.dataset.action === "validate") {
      button.textContent = "Projection 已校验";
      main();
      return;
    }

    button.textContent = "已生成下一轮";
  });
});

qsa("[data-provider-health]").forEach((button) => {
  button.addEventListener("click", async () => {
    const smokeStatus = button.dataset.providerHealth;
    if (!smokeStatus) return;

    try {
      const result = await source.recordProviderHealth({
        smoke_status: smokeStatus,
        tools: ["Read", "Grep"],
        created_at: new Date().toISOString()
      });
      button.dataset.eventState = "recorded";
      button.textContent = "Smoke 已记录";
      if (result.projection) {
        currentProjection = result.projection;
        renderProjection(result.projection);
      }
    } catch {
      button.dataset.eventState = "failed";
      button.textContent = "Smoke 写入失败";
    }
  });
});

qsa("[data-scheduler-dispatch]").forEach((button) => {
  button.addEventListener("click", async () => {
    const dispatchMode = button.dataset.schedulerDispatch;
    button.dataset.eventState = "pending";
    button.textContent = "调度中";

    try {
      const result = await source.runSchedulerDispatch(dispatchMode === "approved-mock"
        ? {
          execution_profile: "approved_mock_non_dry_run",
          created_at: new Date().toISOString()
        }
        : {
          dry_run: true,
          created_at: new Date().toISOString()
        });
      button.dataset.eventState = "recorded";
      button.textContent = "调度已记录";
      if (result.projection) {
        currentProjection = result.projection;
        renderProjection(result.projection);
      }
    } catch (error) {
      if (error.projection) {
        currentProjection = error.projection;
        renderProjection(error.projection);
        button.textContent = "调度已拦截";
        return;
      }
      button.dataset.eventState = "failed";
      button.textContent = "调度失败";
    }
  });
});

qsa("[data-autonomous-scheduler-loop]").forEach((button) => {
  button.addEventListener("click", async () => {
    const loopMode = button.dataset.autonomousSchedulerLoop;
    const projectedMock = loopMode === "projected-mock";
    const projectedReal = loopMode === "projected-real";
    button.dataset.eventState = "pending";
    button.textContent = projectedMock || projectedReal ? "Projected Loop 运行中" : "Loop 运行中";

    try {
      const result = await source.runAutonomousSchedulerLoop({
        projection_id: currentProjectionId,
        max_iterations: projectedMock ? 2 : 1,
        execution_profile: projectedReal ? "approved_bounded_real_reviewer" : "approved_mock_non_dry_run",
        execution_strategy: projectedMock || projectedReal ? "projected_next_action" : "scheduler_dispatch_chain",
        reviewer_mock_status: projectedMock ? "pass" : undefined,
        max_external_reviewer_calls: projectedReal ? 1 : undefined,
        provider_cost_mode: projectedReal ? "bounded" : undefined,
        timeout_seconds: projectedReal ? 90 : undefined,
        budget_tier: projectedReal ? "medium" : undefined,
        snapshot_prefix: projectedMock ? "workbench-projected-loop" : "workbench-loop",
        created_at: new Date().toISOString()
      });
      button.dataset.eventState = "recorded";
      button.textContent = projectedMock || projectedReal ? "Projected Loop 已记录" : "Loop 已记录";
      currentProjectionId = result.item?.id || currentProjectionId;
      if (result.projection) {
        currentProjection = result.projection;
        renderProjection(result.projection);
      }
    } catch (error) {
      if (error.projection) {
        currentProjection = error.projection;
        renderProjection(error.projection);
      }
      button.dataset.eventState = "failed";
      button.textContent = projectedReal ? "Real Loop 被拦截" : "Loop 失败";
    }
  });
});

qsa("[data-workbench-next-action]").forEach((button) => {
  button.addEventListener("click", async () => {
    const action = currentProjection?.next_action_readout?.action || currentProjection?.one_screen?.recommended_action;
    button.dataset.eventState = "pending";
    button.textContent = "推荐动作执行中";

    try {
      const result = await source.runNextAction({
        projection_id: currentProjectionId,
        expected_action: action,
        max_iterations: 1,
        execution_profile: "approved_mock_non_dry_run",
        snapshot_id: `workbench-next-${Date.now()}`,
        snapshot_prefix: "workbench-next-loop",
        created_at: new Date().toISOString()
      });
      button.dataset.eventState = "recorded";
      button.textContent = "推荐动作已记录";
      currentProjectionId = result.result?.next_item?.id || result.result?.item?.id || result.item?.id || currentProjectionId;
      if (result.projection) {
        currentProjection = result.projection;
        renderProjection(result.projection);
      }
    } catch (error) {
      if (error.projection) {
        currentProjection = error.projection;
        renderProjection(error.projection);
      }
      button.dataset.eventState = "failed";
      button.textContent = "推荐动作被拦截";
    }
  });
});

qsa("[data-autonomous-scheduler-loop-resume]").forEach((button) => {
  button.addEventListener("click", async () => {
    button.dataset.eventState = "pending";
    button.textContent = "Resume 运行中";

    try {
      const result = await source.resumeAutonomousSchedulerLoop({
        projection_id: currentProjectionId,
        max_iterations: 1,
        execution_profile: "approved_mock_non_dry_run",
        snapshot_prefix: "workbench-resume",
        created_at: new Date().toISOString()
      });
      button.dataset.eventState = "recorded";
      button.textContent = "Resume 已记录";
      currentProjectionId = result.item?.id || currentProjectionId;
      if (result.projection) {
        currentProjection = result.projection;
        renderProjection(result.projection);
      }
    } catch (error) {
      if (error.projection) {
        currentProjection = error.projection;
        renderProjection(error.projection);
      }
      button.dataset.eventState = "failed";
      button.textContent = "Resume 失败";
    }
  });
});

renderHistorySelect();
main();
