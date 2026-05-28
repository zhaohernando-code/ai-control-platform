import { fetchWorkbenchJson } from "./index";

export type AgentHealthStatus = "success" | "warning" | "error" | "unknown" | "testing";

export interface AgentRoleDefinition {
  id: string;
  label: string;
}

export interface AgentKeyHealth {
  status: AgentHealthStatus;
  latency_ms: number | null;
  checked_at: string | null;
  error_code: string | null;
  error_summary: string | null;
}

export interface AgentApiKey {
  id: string;
  agent_id: string;
  alias: string;
  masked_secret: string;
  competitive: boolean;
  provider: string;
  base_url: string;
  auth_type: string;
  default_model: string;
  health: AgentKeyHealth;
  lock: {
    lock_owner: string;
    locked_at: string;
    expires_at: string;
  } | null;
}

export interface AgentChannel {
  id: string;
  label: string;
  runner: string;
  base_url: string;
  auth_type: string;
  default_model: string;
  account_login: boolean;
  account_health: AgentKeyHealth | null;
  roles: Record<string, boolean>;
  keys: AgentApiKey[];
  key_counts: {
    available: number;
    total: number;
  };
  status: AgentHealthStatus;
}

export interface AgentsResponse {
  version: string;
  role_definitions: AgentRoleDefinition[];
  last_refresh_at: string | null;
  agents: AgentChannel[];
}

export interface HealthCheckResponse {
  status: string;
  checked_at: string;
  checked: Array<{
    kind?: "key" | "account";
    key_id: string | null;
    agent_id: string;
    status: AgentHealthStatus;
    latency_ms: number | null;
    error_code: string;
    error_summary: string;
  }>;
  registry: AgentsResponse | null;
}

export function fetchAgents(): Promise<AgentsResponse> {
  return fetchWorkbenchJson<AgentsResponse>("/api/workbench/agents");
}

export function runFullAgentHealthCheck(): Promise<HealthCheckResponse> {
  return fetchWorkbenchJson<HealthCheckResponse>("/api/workbench/agents/health-check", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ include_fresh: true, created_at: new Date().toISOString() })
  });
}

export function runAgentHealthCheck(agentId: string): Promise<HealthCheckResponse> {
  return fetchWorkbenchJson<HealthCheckResponse>(`/api/workbench/agents/${encodeURIComponent(agentId)}/health-check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ include_fresh: true, created_at: new Date().toISOString() })
  });
}

export function runAgentKeyHealthCheck(keyId: string): Promise<HealthCheckResponse> {
  return fetchWorkbenchJson<HealthCheckResponse>(`/api/workbench/agent-keys/${encodeURIComponent(keyId)}/health-check`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ created_at: new Date().toISOString() })
  });
}

export function addAgentKey(input: {
  agent_id: string;
  alias: string;
  key: string;
  competitive: boolean;
}): Promise<{ status: string; registry: AgentsResponse | null }> {
  return fetchWorkbenchJson("/api/workbench/agent-keys", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...input, created_at: new Date().toISOString() })
  });
}

export function deleteAgentKey(keyId: string): Promise<{ status: string; registry: AgentsResponse | null }> {
  return fetchWorkbenchJson(`/api/workbench/agent-keys/${encodeURIComponent(keyId)}`, {
    method: "DELETE"
  });
}

export function updateAgentRoles(
  agentId: string,
  roles: Record<string, boolean>
): Promise<{ status: string; registry: AgentsResponse | null }> {
  return fetchWorkbenchJson(`/api/workbench/agents/${encodeURIComponent(agentId)}/roles`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ roles, created_at: new Date().toISOString() })
  });
}
