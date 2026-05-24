import { createProjectionSource } from "./projection-source.js";

const source = createProjectionSource();
let currentProjection = null;
let currentProjectionId = null;
const RAW_TOKEN_COPY = new Map([
  ["Headless live context cycle after scheduler package", "最近自动运行"],
  ["Headless live context cycle after workbench package", "工作台修复后自动运行"],
  ["Headless live context cycle after platform boundary package", "边界修复后自动运行"],
  ["Headless live context cycle", "自动运行周期"],
  ["Context pack cycle next step", "任务上下文续跑"],
  ["Context pack cycle from", "来自当前会话的上下文周期"],
  ["Current autonomous platform self-trial", "当前平台自运行试验"],
  ["Platform repository bootstrap", "平台仓库初始化"],
  ["Current session fixture", "当前会话样本"],
  ["Current session", "当前会话"],
  ["Rerun failed checks with recovery context", "带恢复上下文重跑检查"],
  ["rerun", "需重跑"],
  ["Rerun", "需重跑"],
  ["pass", "通过"],
  ["fail", "未通过"],
  ["failed", "失败"],
  ["ready", "就绪"],
  ["not ready", "未就绪"],
  ["available", "可用"],
  ["complete", "已完成"],
  ["completed", "已完成"],
  ["blocked", "受阻"],
  ["idle", "空闲"],
  ["validation", "校验"],
  ["dry_run", "预检"],
  ["unknown", "未知"],
  ["human_intervention", "需要人工介入"],
  ["projection_load_failed", "状态加载失败"],
  ["not_configured", "未配置"],
  ["no_next_action", "暂无下一步"],
  ["inspect_context_work_packages", "检查任务包"],
  ["prepare_project_status_continuation", "准备续跑状态"],
  ["run_context_work_packages", "运行任务包"],
  ["projected_next_action", "按推荐动作推进"],
  ["approved_mock_non_dry_run", "已批准模拟执行"],
  ["approved_bounded_real_reviewer", "受控真实审查"],
  ["scheduler_dispatch", "调度执行"],
  ["frontend_acceptance", "前端验收"],
  ["frontend_acceptance_run", "前端验收"],
  ["headless_projected_action_progress", "后台推进进度"],
  ["operator_observable", "操作员可见"],
  ["automation_driver", "自动化执行"],
  ["scheduler", "调度"],
  ["reviewer", "审查"],
  ["scheduler_dispatch_policy", "调度策略"],
  ["scheduler_dispatch_run", "调度执行"],
  ["context_pack_cycle_materialized", "任务上下文已生成"],
  ["project_status_continuation", "项目状态续跑"],
  ["reviewer_shard_aggregate", "审查分片汇总"],
  ["scheduler_dispatch_chain", "调度链路"],
  ["current-session", "当前会话"],
  ["current_session", "当前会话"],
  ["blocker(s)", "阻塞项"],
  ["step(s)", "步"]
]);
const LONG_RAW_IDENTIFIER_PATTERN = /\b[a-z0-9]+(?:-[a-z0-9]+){3,}\b/gi;

function text(value, fallback = "--") {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function redactRawIdentifiers(value) {
  return String(value || "").replace(LONG_RAW_IDENTIFIER_PATTERN, (match) => {
    return match.length >= 28 ? "证据已记录" : match;
  });
}

function replaceTokenCopy(value, token, label) {
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^[a-z0-9_-]+$/i.test(token)) {
    return value.replace(new RegExp(`(^|[^a-zA-Z0-9_-])${escaped}(?=$|[^a-zA-Z0-9_-])`, "g"), `$1${label}`);
  }
  return value.replaceAll(token, label);
}

function humanizeToken(token) {
  const value = text(token);
  return RAW_TOKEN_COPY.get(value) || redactRawIdentifiers(value)
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function displayText(value, fallback = "--") {
  const raw = text(value, fallback);
  if (raw === fallback) return fallback;
  let result = redactRawIdentifiers(raw);
  const pairs = [...RAW_TOKEN_COPY.entries()].sort((a, b) => b[0].length - a[0].length);
  for (const [token, label] of pairs) {
    result = replaceTokenCopy(result, token, label);
  }
  return result;
}

function statusText(value) {
  const raw = text(value);
  return RAW_TOKEN_COPY.get(raw) || displayText(raw);
}

function compactCopy(value, limit = 140, fallback = "--") {
  const normalized = displayText(value, fallback)
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized === fallback) return fallback;
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, Math.max(0, limit - 1)).trim()}…`;
}

function actionLabel(projection) {
  return projection.next_action_readout?.action
    || projection.one_screen?.recommended_action
    || projection.decision
    || projection.status;
}

function headlineText(projection) {
  const headline = projection.one_screen?.headline || projection.headline;
  if (headline && headline.length <= 80) return compactCopy(headline, 80);

  const status = statusText(projection.status);
  const decision = statusText(projection.decision);
  const action = statusText(actionLabel(projection));
  if (status !== "--" && action !== "--") return compactCopy(`${status} · ${action}`, 80);
  if (decision !== "--") return compactCopy(decision, 80);
  return compactCopy(headline || projection.goal, 80, "等待状态投影");
}

function qs(selector) {
  return document.querySelector(selector);
}

function qsa(selector) {
  return Array.from(document.querySelectorAll(selector));
}

function bindCommandActivation(node, handler) {
  node.addEventListener("click", handler);
  if (node.tagName === "BUTTON") return;
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    handler();
  });
}

function setText(name, value) {
  qsa(`[data-bind="${name}"]`).forEach((node) => {
    node.textContent = displayText(value);
  });
}

function workflowIdentityLabel(value, fallback) {
  const raw = text(value, "");
  if (!raw) return fallback;
  if (/^(run|cycle)-/i.test(raw) || raw.length > 24) return fallback;
  return displayText(raw);
}

function setProjectionMode(projectionId = currentProjectionId) {
  document.body.dataset.projectionMode = projectionId === "current-session"
    ? "interactive-fixture"
    : "release-readout";
}

function firstReason(projection) {
  const nextAction = statusText(actionLabel(projection));
  const decision = statusText(projection.decision);
  const reason = projection.one_screen?.summary || projection.summary || projection.reasons?.[0];
  if (reason) return compactCopy(reason, 150);
  if (nextAction !== "--") return `下一步：${compactCopy(nextAction, 90)}。`;
  return `${decision}，来自已校验投影`;
}

function bindTabs() {
  const tabs = qsa("[data-workbench-tab]");
  const grid = qs(".content-grid");
  if (tabs.length === 0 || !grid) return;

  const showSection = (section) => {
    grid.scrollTop = 0;
    grid.dataset.activeSection = section;
    for (const tab of tabs) {
      const active = tab.dataset.workbenchTab === section;
      tab.classList.toggle("active", active);
      if (active) {
        tab.setAttribute("aria-current", "page");
      } else {
        tab.removeAttribute("aria-current");
      }
    }
    qsa("[data-section]").forEach((panel) => {
      const sections = text(panel.dataset.section, "").split(/\s+/).filter(Boolean);
      panel.classList.toggle("section-visible", sections.includes(section));
    });
    qsa(`[data-section~="${section}"]`)[0]?.focus?.({ preventScroll: true });
  };

  for (const tab of tabs) {
    tab.addEventListener("click", (event) => {
      event.preventDefault();
      showSection(tab.dataset.workbenchTab || "overview");
    });
  }
  showSection("overview");
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
        item.innerHTML = `<strong>${index + 1}. ${displayText(action.title || action.id)}</strong><span>${statusText(action.action)}</span>`;
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
        row.innerHTML = `<strong>${displayText(item.group)} · ${displayText(item.next_action_role)}</strong><span>${displayText(item.type)} / ${displayText(item.summary)}</span>`;
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
      item.innerHTML = `<strong>${displayText(role.model)}</strong><span>${role.count} 个职责</span>`;
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
  const selfGovernance = projection.self_governance || {};
  const globalGoals = projection.global_goal_completion || {};
  const nextActionReadout = projection.next_action_readout || {};
  const nextActionTerminal = projection.next_action_terminal || {};

  setText("run_id", workflowIdentityLabel(projection.run_id, "当前运行"));
  setText("cycle_id", workflowIdentityLabel(projection.cycle_id, "当前周期"));
  setText("status", statusText(projection.status));
  setText("status_short", statusText(projection.status));
  setText("decision", statusText(projection.decision));
  setText("headline", headlineText(projection));
  setText("reason", firstReason(projection));
  setText("selected_model", model.selected_model);
  setText("model_summary", `${displayText(model.preferred_model)} -> ${displayText(model.selected_model)}`);
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
  setText("counter_global_goals_total", counters.global_goals_total ?? globalGoals.total ?? 0);
  setText("counter_global_goals_blocked", counters.global_goals_blocked ?? globalGoals.blocked ?? 0);
  setText("counter_operation_events", counters.operation_events ?? projection.operations_timeline?.count ?? 0);
  setText("counter_self_governance_findings", counters.self_governance_findings ?? selfGovernance.finding_count ?? 0);
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
  setText("scheduler_dispatch_dry_run", schedulerDispatch.dry_run === true ? "是" : "否");
  setText("scheduler_dispatch_artifact", schedulerDispatch.artifact_id);
  setText("scheduler_policy_status", schedulerDispatch.policy_status);
  setText("scheduler_policy_mode", schedulerDispatch.policy_execution_mode);
  setText("scheduler_policy_issues", schedulerDispatch.policy_issue_count ?? 0);
  setText("scheduler_policy_reason", schedulerDispatch.policy_latest_issue);
  setText("scheduler_next_status", schedulerDispatch.next_continuation_status);
  setText("scheduler_next_packages", schedulerDispatch.next_work_package_count ?? 0);
  setText("scheduler_next_action", schedulerDispatch.next_continuation_action);
  setText("scheduler_continuation_status", schedulerContinuation.continuation_status || schedulerContinuation.status);
  setText("scheduler_continuation_ready", schedulerContinuation.ready === true ? "就绪" : "未就绪");
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
  setText("agent_lifecycle_pool_completed", lifecyclePool.completed ?? 0);
  setText("agent_lifecycle_pool_evaluated", lifecyclePool.evaluated ?? 0);
  setText("agent_lifecycle_pool_closed", lifecyclePool.closed ?? 0);
  setText("agent_lifecycle_pool_unevaluated", lifecyclePool.unevaluated ?? 0);
  setText("agent_lifecycle_pool_unclosed", lifecyclePool.unclosed ?? 0);
  setText("agent_lifecycle_pool_timed_out", lifecyclePool.timed_out ?? 0);
  setText("agent_lifecycle_pool_heartbeats", lifecyclePool.heartbeat_count ?? 0);
  setText("agent_lifecycle_pool_latest_heartbeat", lifecyclePool.latest_heartbeat_at);
  setText("agent_lifecycle_pool_latest_timeout", lifecyclePool.latest_timeout_at);
  setText("agent_lifecycle_pool_next_action", lifecyclePool.next_action);
  setText("self_governance_status", selfGovernance.status);
  setText("self_governance_findings", selfGovernance.finding_count ?? 0);
  setText("self_governance_auto_repairs", selfGovernance.auto_repair_count ?? 0);
  setText("self_governance_evidence_tasks", selfGovernance.evidence_building_count ?? 0);
  setText("self_governance_user_decisions", selfGovernance.user_decision_count ?? 0);
  setText("self_governance_cadence", selfGovernance.cadence);
  setText("self_governance_roles", selfGovernance.role_count ?? 0);
  setText("self_governance_next_trigger", selfGovernance.next_trigger);
  setText("self_governance_latest_repair", selfGovernance.latest_auto_repair_title);
  setText("self_governance_latest_evidence", selfGovernance.latest_evidence_title);
  setText("self_governance_latest_decision", selfGovernance.latest_decision_title);
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
    setProjectionMode();
    for (const select of selects) {
      select.replaceChildren(
        ...history.items.map((item) => {
          const option = document.createElement("option");
          option.value = projectionUrlForHistoryItem(item);
          option.dataset.projectionId = item.id || "";
          option.textContent = `${displayText(item.label)} · ${statusText(item.status)}`;
          option.selected = item.id === history.latest;
          return option;
        })
      );
      select.addEventListener("change", async () => {
        currentProjectionId = select.selectedOptions[0]?.dataset.projectionId || null;
        setProjectionMode();
        await main(select.value, currentProjectionId);
      });
    }
  } catch {
    for (const select of selects) {
      select.replaceChildren(new Option("状态历史不可用", source.url));
    }
  }
}

async function main(url = null, projectionId = null) {
  try {
    const projection = url ? await createProjectionSource({ url }).load() : await source.load();
    currentProjection = projection;
    if (projectionId) currentProjectionId = projectionId;
    setProjectionMode();
    renderProjection(projection);
  } catch (error) {
    setProjectionMode();
    renderProjection({
      status: "human_intervention",
      decision: "projection_load_failed",
      goal: "状态投影加载失败",
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
      button.textContent = "当前状态已校验";
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
      button.textContent = "连通已记录";
      if (result.projection) {
        currentProjection = result.projection;
        renderProjection(result.projection);
      }
    } catch {
      button.dataset.eventState = "failed";
      button.textContent = "连通写入失败";
    }
  });
});

qsa("[data-scheduler-dispatch]").forEach((button) => {
  bindCommandActivation(button, async () => {
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
  bindCommandActivation(button, async () => {
    const loopMode = button.dataset.autonomousSchedulerLoop;
    const projectedMock = loopMode === "projected-mock";
    const projectedReal = loopMode === "projected-real";
    button.dataset.eventState = "pending";
    button.textContent = projectedMock || projectedReal ? "按投影推进中" : "调度轮次运行中";

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
      button.textContent = projectedMock || projectedReal ? "投影推进已记录" : "调度轮次已记录";
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
      button.textContent = projectedReal ? "受控审查被拦截" : "调度轮次失败";
    }
  });
});

qsa("[data-workbench-next-action]").forEach((button) => {
  bindCommandActivation(button, async () => {
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
  bindCommandActivation(button, async () => {
    button.dataset.eventState = "pending";
    button.textContent = "续跑调度中";

    try {
      const result = await source.resumeAutonomousSchedulerLoop({
        projection_id: currentProjectionId,
        max_iterations: 1,
        execution_profile: "approved_mock_non_dry_run",
        snapshot_prefix: "workbench-resume",
        created_at: new Date().toISOString()
      });
      button.dataset.eventState = "recorded";
      button.textContent = "续跑已记录";
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
      button.textContent = "续跑失败";
    }
  });
});

bindTabs();
renderHistorySelect().then(() => main());
