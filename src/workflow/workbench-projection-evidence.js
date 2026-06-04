function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeString(value) {
  return String(value || "").trim();
}

export function normalizeAgentKeyHealth(input = {}) {
  const source = input.agent_key_health || input.agentKeyHealth || {};
  if (!source || typeof source !== "object" || Array.isArray(source)) {
    return {
      status: "not_configured",
      agent_count: 0,
      key_count: 0,
      available_key_count: 0,
      last_refresh_at: null,
      agents: []
    };
  }
  const agents = asArray(source.agents).map((agent) => ({
    id: normalizeString(agent.id),
    label: normalizeString(agent.label || agent.id),
    status: normalizeString(agent.status) || "unknown",
    available_keys: Number(agent.available_keys || agent.availableKeys || 0),
    total_keys: Number(agent.total_keys || agent.totalKeys || 0),
    roles: agent.roles && typeof agent.roles === "object" && !Array.isArray(agent.roles) ? agent.roles : {}
  }));
  const keyCount = Number(source.key_count || source.keyCount || agents.reduce((sum, agent) => sum + agent.total_keys, 0));
  const availableKeyCount = Number(source.available_key_count || source.availableKeyCount || agents.reduce((sum, agent) => sum + agent.available_keys, 0));
  return {
    status: normalizeString(source.status) || (keyCount === 0 ? "unknown" : availableKeyCount === keyCount ? "success" : availableKeyCount > 0 ? "warning" : "error"),
    agent_count: Number(source.agent_count || source.agentCount || agents.length),
    key_count: keyCount,
    available_key_count: availableKeyCount,
    last_refresh_at: normalizeString(source.last_refresh_at || source.lastRefreshAt) || null,
    agents
  };
}

export function summarizeCloseoutEvidence(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "closeout_snapshot_publish");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      publish_status: null,
      event_id: null,
      artifact_id: null,
      snapshot_id: null,
      path: null,
      uri: null,
      created_at: null,
      issues: []
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;

  return {
    status: artifact?.status || "unknown",
    publish_status: latestEvent.status || artifact?.metadata?.closeout_status || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    snapshot_id: latestEvent.snapshot_id || artifact?.metadata?.snapshot_id || null,
    path: artifact?.path || null,
    uri: artifact?.uri || null,
    created_at: latestEvent.created_at || artifact?.created_at || null,
    issues: artifact?.metadata?.issues || latestEvent.metadata?.issues || []
  };
}

export function summarizeWorkbenchBrowserEvents(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "workbench_browser_events_run");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      artifact_id: null,
      scenario_count: 0,
      partial_shard_ready: false,
      latest_scenario: null,
      overflow_count: 0,
      created_at: null
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const metadata = artifact?.metadata || latestEvent.metadata || {};
  const scenarios = asArray(metadata.scenarios);
  const partialReadout = scenarios.find((scenario) => scenario?.scenario === "projected_real_partial_shard_readout") || {};
  const overflowCount = scenarios.filter((scenario) => {
    const dimensions = scenario?.dimensions || {};
    return Number(dimensions.scrollWidth || 0) > Number(dimensions.width || 0);
  }).length;

  return {
    status: artifact?.status || latestEvent.status || metadata.status || "unknown",
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    scenario_count: Number(metadata.scenario_count || scenarios.length || 0),
    partial_shard_ready: partialReadout.shard_review_next === "reviewer-scope-shard-002" &&
      partialReadout.next_action_readout === "run_reviewer_scope_shard",
    latest_scenario: scenarios.at(-1)?.scenario || null,
    overflow_count: overflowCount,
    created_at: latestEvent.created_at || artifact?.created_at || metadata.created_at || null
  };
}

export function summarizeResumeHealth(manifest = {}, artifactLedger = {}) {
  const events = asArray(manifest?.events).filter((event) => event?.type === "autonomous_loop_replay_validation");
  const latestEvent = events.at(-1) || null;
  if (!latestEvent) {
    return {
      status: "not_configured",
      replay_status: null,
      event_id: null,
      artifact_id: null,
      issue_count: 0,
      latest_issue: null,
      created_at: null,
      issues: []
    };
  }

  const artifacts = [
    ...asArray(artifactLedger?.artifacts),
    ...asArray(manifest?.artifacts)
  ];
  const artifact = artifacts.find((entry) => entry.id === latestEvent.artifact_id) || null;
  const issues = asArray(artifact?.metadata?.issues || latestEvent.metadata?.issues);
  const status = latestEvent.status === "blocked" || artifact?.status === "fail"
    ? "blocked"
    : artifact?.status || latestEvent.status || "unknown";

  return {
    status,
    replay_status: artifact?.metadata?.replay_status || latestEvent.metadata?.replay_status || null,
    event_id: latestEvent.id || null,
    artifact_id: latestEvent.artifact_id || artifact?.id || null,
    issue_count: issues.length,
    latest_issue: issues[0]?.message || issues[0]?.code || null,
    created_at: latestEvent.created_at || artifact?.created_at || null,
    issues
  };
}
