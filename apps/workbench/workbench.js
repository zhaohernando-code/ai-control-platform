const PROJECTION_URL = "../../docs/examples/current-session-workbench-projection.json";

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

  renderNextActions(projection);
  renderModelRoles(projection);
}

async function loadProjection() {
  const response = await fetch(PROJECTION_URL);
  if (!response.ok) {
    throw new Error(`Projection fetch failed: ${response.status}`);
  }
  return response.json();
}

async function main() {
  try {
    const projection = await loadProjection();
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
  button.addEventListener("click", () => {
    button.textContent = button.dataset.action === "validate" ? "Projection 已校验" : "已生成下一轮";
  });
});

main();
