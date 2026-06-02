import { runAgentHealthCheck } from "../src/workflow/agent-health-checker.js";
import { loadAgentInvocationConfig } from "../src/workflow/agent-invocation.js";

function agentStoreUnavailable(stateStore, methodName) {
  return !stateStore || typeof stateStore[methodName] !== "function";
}

function agentHealthOptions(options = {}) {
  return {
    fetchImpl: options.agentHealthFetch || options.fetchImpl,
    accountHealthRunner: options.agentAccountHealthRunner,
    accountHealthCheckImpl: options.agentAccountHealthCheckImpl,
    manualAgentCliPath: options.manualAgentCliPath
  };
}

function invocationConfigResponse() {
  const invocationConfig = loadAgentInvocationConfig({
    channels_path: process.env.AI_CONTROL_WORKBENCH_AGENT_CHANNELS_PATH,
    profiles_path: process.env.AI_CONTROL_WORKBENCH_AGENT_PROFILES_PATH
  });
  return {
    version: invocationConfig.version,
    profiles_path: invocationConfig.profiles_path,
    channels_path: invocationConfig.channels_path,
    profiles: Object.entries(invocationConfig.profiles).map(([id, profile]) => ({
      id,
      role: profile.role,
      stage: profile.stage,
      risk: profile.risk,
      budget_tier: profile.budget_tier,
      strength: profile.strength,
      timeout_ms: profile.timeout_ms,
      hooks: profile.hooks || [],
      candidates: (profile.candidates || []).map((candidate) => ({
        agent_id: candidate.agent_id || candidate.agentId,
        model: candidate.model
      }))
    }))
  };
}

export function createAgentKeyRouteHandler({
  stateStore,
  options = {},
  jsonBodyLimitBytes,
  jsonResponse,
  readJsonBody
} = {}) {
  return async function handleAgentKeyRoute(url, req, res) {
    if (url.pathname === "/api/workbench/agents" && req.method === "GET") {
      if (agentStoreUnavailable(stateStore, "listAgents")) {
        jsonResponse(res, 503, { error: "agent key store requires SQLite workbench state" });
        return true;
      }
      jsonResponse(res, 200, {
        ...stateStore.listAgents(),
        invocation: invocationConfigResponse()
      });
      return true;
    }

    if (url.pathname === "/api/workbench/agents/health-check" && req.method === "POST") {
      if (agentStoreUnavailable(stateStore, "listAgents")) {
        jsonResponse(res, 503, { error: "agent key store requires SQLite workbench state" });
        return true;
      }
      const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
      const result = await runAgentHealthCheck(stateStore, {
        ...input,
        include_fresh: input.include_fresh ?? true
      }, agentHealthOptions(options));
      jsonResponse(res, result.status === "fail" ? 400 : 201, result);
      return true;
    }

    const agentHealthMatch = url.pathname.match(/^\/api\/workbench\/agents\/([^/]+)\/health-check$/);
    if (agentHealthMatch && req.method === "POST") {
      if (agentStoreUnavailable(stateStore, "listAgents")) {
        jsonResponse(res, 503, { error: "agent key store requires SQLite workbench state" });
        return true;
      }
      const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
      const result = await runAgentHealthCheck(stateStore, {
        ...input,
        agent_id: decodeURIComponent(agentHealthMatch[1]),
        include_fresh: input.include_fresh ?? true
      }, agentHealthOptions(options));
      jsonResponse(res, result.status === "fail" ? 400 : 201, result);
      return true;
    }

    if (url.pathname === "/api/workbench/agent-keys" && req.method === "POST") {
      if (agentStoreUnavailable(stateStore, "addAgentKey")) {
        jsonResponse(res, 503, { error: "agent key store requires SQLite workbench state" });
        return true;
      }
      const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
      const result = stateStore.addAgentKey(input, input.created_at || input.createdAt || new Date().toISOString());
      jsonResponse(res, result.status === "created" ? 201 : 400, {
        ...result,
        registry: result.status === "created" ? stateStore.listAgents() : null
      });
      return true;
    }

    const agentKeyDeleteMatch = url.pathname.match(/^\/api\/workbench\/agent-keys\/([^/]+)$/);
    if (agentKeyDeleteMatch && req.method === "DELETE") {
      if (agentStoreUnavailable(stateStore, "deleteAgentKey")) {
        jsonResponse(res, 503, { error: "agent key store requires SQLite workbench state" });
        return true;
      }
      const result = stateStore.deleteAgentKey(decodeURIComponent(agentKeyDeleteMatch[1]), new Date().toISOString());
      jsonResponse(res, result.status === "deleted" ? 200 : 404, {
        ...result,
        registry: result.status === "deleted" ? stateStore.listAgents() : null
      });
      return true;
    }

    const agentKeyHealthMatch = url.pathname.match(/^\/api\/workbench\/agent-keys\/([^/]+)\/health-check$/);
    if (agentKeyHealthMatch && req.method === "POST") {
      if (agentStoreUnavailable(stateStore, "readAgentKeyForHealth")) {
        jsonResponse(res, 503, { error: "agent key store requires SQLite workbench state" });
        return true;
      }
      const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
      const result = await runAgentHealthCheck(stateStore, {
        ...input,
        key_id: decodeURIComponent(agentKeyHealthMatch[1])
      }, agentHealthOptions(options));
      jsonResponse(res, result.status === "fail" ? 400 : 201, result);
      return true;
    }

    const agentRolesMatch = url.pathname.match(/^\/api\/workbench\/agents\/([^/]+)\/roles$/);
    if (agentRolesMatch && req.method === "PUT") {
      if (agentStoreUnavailable(stateStore, "updateAgentRoles")) {
        jsonResponse(res, 503, { error: "agent key store requires SQLite workbench state" });
        return true;
      }
      const input = await readJsonBody(req, { maxBytes: jsonBodyLimitBytes });
      const result = stateStore.updateAgentRoles(
        decodeURIComponent(agentRolesMatch[1]),
        input.roles || input,
        input.created_at || input.createdAt || new Date().toISOString()
      );
      jsonResponse(res, result.status === "updated" ? 200 : 400, {
        ...result,
        registry: result.status === "updated" ? stateStore.listAgents() : null
      });
      return true;
    }

    return false;
  };
}
