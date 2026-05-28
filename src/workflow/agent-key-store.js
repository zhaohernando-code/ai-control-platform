import { resolve } from "node:path";
import {
  AGENT_KEY_STORE_VERSION,
  AGENT_ROLE_DEFINITIONS,
  DEFAULT_MANUAL_AGENT_CONFIG_PATH,
  ROLE_IDS,
  agentStatus,
  issue,
  latestHealthByKey,
  maskSecret,
  normalizeRoles,
  normalizeString,
  normalizeToken,
  nowIso,
  parseJson,
  providerFromChannel,
  publicKey,
  queryRows,
  readManualChannels,
  roleDefaults,
  runSql,
  safeIdPart,
  schemaSql,
  sqlString
} from "./agent-key-store-utils.js";

export {
  AGENT_KEY_STORE_VERSION,
  AGENT_ROLE_DEFINITIONS,
  DEFAULT_MANUAL_AGENT_CONFIG_PATH,
  maskSecret
};

export function createAgentKeyStore(options = {}) {
  const dbPath = resolve(options.dbPath || options.db_path);
  const sqliteBin = options.sqliteBin || options.sqlite_bin || "sqlite3";
  const manualAgentConfigPath = options.manualAgentConfigPath ||
    options.manual_agent_config_path ||
    process.env.MANUAL_AGENT_CONFIG ||
    DEFAULT_MANUAL_AGENT_CONFIG_PATH;
  runSql(dbPath, schemaSql(), { sqliteBin });

  const syncAgentChannels = (channels = readManualChannels(manualAgentConfigPath), updatedAt = nowIso()) => {
    for (const channel of channels) {
      runSql(dbPath, `
INSERT INTO agent_channels(id, label, runner, base_url, auth_type, default_model, models_json, account_login, updated_at)
VALUES (${sqlString(channel.id)}, ${sqlString(channel.label)}, ${sqlString(channel.runner)}, ${sqlString(channel.base_url)}, ${sqlString(channel.auth_type)}, ${sqlString(channel.default_model)}, ${sqlString(JSON.stringify(channel.models || []))}, ${channel.account_login ? 1 : 0}, ${sqlString(updatedAt)})
ON CONFLICT(id) DO UPDATE SET
  label = excluded.label,
  runner = excluded.runner,
  base_url = excluded.base_url,
  auth_type = excluded.auth_type,
  default_model = excluded.default_model,
  models_json = excluded.models_json,
  account_login = excluded.account_login,
  updated_at = excluded.updated_at;
`, { sqliteBin });
    }
    return channels;
  };

  syncAgentChannels();

  const readChannels = () => queryRows(dbPath, "SELECT * FROM agent_channels ORDER BY account_login DESC, id;", { sqliteBin });
  const readActiveKeys = (agentId = "") => {
    const where = agentId ? `AND agent_id = ${sqlString(agentId)}` : "";
    return queryRows(dbPath, `SELECT * FROM agent_api_keys WHERE deleted_at IS NULL ${where} ORDER BY created_at, id;`, { sqliteBin });
  };
  const readLatestHealthRows = () => queryRows(dbPath, "SELECT * FROM agent_key_health_checks ORDER BY checked_at;", { sqliteBin });
  const readLocks = () => queryRows(dbPath, "SELECT * FROM agent_key_locks;", { sqliteBin });
  const readRoleRows = () => queryRows(dbPath, "SELECT * FROM agent_role_settings;", { sqliteBin });
  const readMeta = (key) => {
    const rows = queryRows(dbPath, `SELECT value FROM agent_health_meta WHERE key = ${sqlString(key)} LIMIT 1;`, { sqliteBin });
    return rows[0]?.value || null;
  };
  const writeMeta = (key, value, updatedAt = nowIso()) => {
    runSql(dbPath, `
INSERT INTO agent_health_meta(key, value, updated_at)
VALUES (${sqlString(key)}, ${sqlString(value)}, ${sqlString(updatedAt)})
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
`, { sqliteBin });
  };

  const listAgents = () => {
    syncAgentChannels();
    const keys = readActiveKeys();
    const healthByKey = latestHealthByKey(readLatestHealthRows());
    const locksByKey = new Map(readLocks().map((lock) => [lock.key_id, lock]));
    const rolesByAgent = new Map(readRoleRows().map((row) => [row.agent_id, normalizeRoles(parseJson(row.roles_json, {}))]));
    const agents = readChannels().map((channel) => {
      const agentKeys = keys
        .filter((key) => key.agent_id === channel.id)
        .map((key) => publicKey(key, healthByKey.get(key.id), locksByKey.get(key.id)));
      const available = agentKeys.filter((key) => key.health.status === "success").length;
      return {
        id: channel.id,
        label: channel.label,
        runner: channel.runner,
        base_url: channel.base_url,
        auth_type: channel.auth_type,
        default_model: channel.default_model,
        models: parseJson(channel.models_json, []),
        account_login: Boolean(channel.account_login),
        roles: rolesByAgent.get(channel.id) || roleDefaults(),
        keys: Boolean(channel.account_login) ? [] : agentKeys,
        key_counts: {
          available,
          total: Boolean(channel.account_login) ? 0 : agentKeys.length
        },
        status: Boolean(channel.account_login) ? "unknown" : agentStatus(agentKeys)
      };
    });
    return {
      version: AGENT_KEY_STORE_VERSION,
      role_definitions: AGENT_ROLE_DEFINITIONS,
      last_refresh_at: readMeta("last_refresh_at"),
      agents
    };
  };

  const addAgentKey = (input = {}, createdAt = nowIso()) => {
    const agentId = normalizeString(input.agent_id || input.agentId);
    const alias = normalizeString(input.alias);
    const secret = normalizeString(input.key || input.secret);
    const issues = [];
    const channel = readChannels().find((entry) => entry.id === agentId);
    if (!channel) issues.push(issue("unknown_agent", "agent_id must reference a known manual agent channel", "agent_id"));
    if (channel?.account_login) issues.push(issue("account_login_agent_key_forbidden", "codex account login agents do not accept API keys", "agent_id"));
    if (!alias) issues.push(issue("missing_key_alias", "alias is required", "alias"));
    if (!secret) issues.push(issue("missing_key_secret", "key is required", "key"));
    if (issues.length > 0) return { status: "fail", issues };

    const id = normalizeString(input.id) || `agent-key-${safeIdPart(agentId)}-${Date.now()}`;
    const provider = normalizeString(input.provider) || providerFromChannel(channel);
    const baseUrl = normalizeString(input.base_url || input.baseUrl) || channel.base_url || "";
    const authType = normalizeString(input.auth_type || input.authType) || channel.auth_type || "";
    const defaultModel = normalizeString(input.default_model || input.defaultModel) || channel.default_model || "";
    runSql(dbPath, `
INSERT INTO agent_api_keys(id, agent_id, alias, secret, masked_secret, competitive, provider, base_url, auth_type, default_model, created_at, updated_at, deleted_at)
VALUES (${sqlString(id)}, ${sqlString(agentId)}, ${sqlString(alias)}, ${sqlString(secret)}, ${sqlString(maskSecret(secret))}, ${input.competitive ? 1 : 0}, ${sqlString(provider)}, ${sqlString(baseUrl)}, ${sqlString(authType)}, ${sqlString(defaultModel)}, ${sqlString(createdAt)}, ${sqlString(createdAt)}, NULL);
`, { sqliteBin });
    writeMeta("last_refresh_at", createdAt, createdAt);
    return {
      status: "created",
      key: publicKey(readActiveKeys(agentId).find((key) => key.id === id), null, null),
      issues: []
    };
  };

  const deleteAgentKey = (keyId, deletedAt = nowIso()) => {
    const id = normalizeString(keyId);
    const existing = readActiveKeys().find((key) => key.id === id);
    if (!existing) return { status: "fail", issues: [issue("unknown_agent_key", "active agent key not found", "key_id")] };
    runSql(dbPath, `
UPDATE agent_api_keys
SET secret = '', masked_secret = '', deleted_at = ${sqlString(deletedAt)}, updated_at = ${sqlString(deletedAt)}
WHERE id = ${sqlString(id)} AND deleted_at IS NULL;
DELETE FROM agent_key_locks WHERE key_id = ${sqlString(id)};
`, { sqliteBin });
    writeMeta("last_refresh_at", deletedAt, deletedAt);
    return { status: "deleted", key_id: id, issues: [] };
  };

  const updateAgentRoles = (agentId, roles = {}, updatedAt = nowIso()) => {
    const id = normalizeString(agentId);
    if (!readChannels().some((channel) => channel.id === id)) {
      return { status: "fail", issues: [issue("unknown_agent", "agent_id must reference a known manual agent channel", "agent_id")] };
    }
    const unknown = Object.keys(roles || {}).find((role) => !ROLE_IDS.has(role));
    if (unknown) return { status: "fail", issues: [issue("unknown_agent_role", `unknown agent role: ${unknown}`, "roles")] };
    const normalized = normalizeRoles(roles);
    runSql(dbPath, `
INSERT INTO agent_role_settings(agent_id, roles_json, updated_at)
VALUES (${sqlString(id)}, ${sqlString(JSON.stringify(normalized))}, ${sqlString(updatedAt)})
ON CONFLICT(agent_id) DO UPDATE SET roles_json = excluded.roles_json, updated_at = excluded.updated_at;
`, { sqliteBin });
    writeMeta("last_refresh_at", updatedAt, updatedAt);
    return { status: "updated", agent_id: id, roles: normalized, issues: [] };
  };

  const readAgentKeyForHealth = (keyId) => {
    const id = normalizeString(keyId);
    return queryRows(dbPath, `SELECT * FROM agent_api_keys WHERE id = ${sqlString(id)} AND deleted_at IS NULL LIMIT 1;`, { sqliteBin })[0] || null;
  };

  const recordAgentKeyHealth = (input = {}, checkedAt = nowIso()) => {
    const keyId = normalizeString(input.key_id || input.keyId);
    const key = readAgentKeyForHealth(keyId);
    if (!key) return { status: "fail", issues: [issue("unknown_agent_key", "active agent key not found", "key_id")] };
    const id = normalizeString(input.id) || `agent-health-${safeIdPart(keyId)}-${Date.now()}`;
    const status = normalizeToken(input.status) || "unknown";
    runSql(dbPath, `
INSERT INTO agent_key_health_checks(id, key_id, agent_id, status, latency_ms, checked_at, error_code, error_summary, raw_json)
VALUES (${sqlString(id)}, ${sqlString(keyId)}, ${sqlString(key.agent_id)}, ${sqlString(status)}, ${Number.isFinite(Number(input.latency_ms)) ? Math.round(Number(input.latency_ms)) : "NULL"}, ${sqlString(checkedAt)}, ${sqlString(input.error_code || input.errorCode || "")}, ${sqlString(input.error_summary || input.errorSummary || "")}, ${sqlString(JSON.stringify(input.raw || {}))});
`, { sqliteBin });
    writeMeta("last_refresh_at", checkedAt, checkedAt);
    return { status: "recorded", key_id: keyId, health: publicKey(key, { ...input, status, checked_at: checkedAt }, null).health, issues: [] };
  };

  const keysDueForHealthCheck = (options = {}) => {
    const agentId = normalizeString(options.agent_id || options.agentId);
    const ttlMs = Number(options.ttl_ms || options.ttlMs || 10 * 60 * 1000);
    const nowTime = Date.parse(options.now || nowIso());
    const healthByKey = latestHealthByKey(readLatestHealthRows());
    return readActiveKeys(agentId)
      .filter((key) => normalizeToken(key.auth_type) !== "codex_account")
      .filter((key) => {
        if (options.include_fresh || options.includeFresh) return true;
        const checkedAt = Date.parse(healthByKey.get(key.id)?.checked_at || "");
        return !Number.isFinite(checkedAt) || nowTime - checkedAt >= ttlMs;
      });
  };

  const summarizeAgentRegistry = () => {
    const registry = listAgents();
    const agents = registry.agents.filter((agent) => !agent.account_login);
    const total = agents.reduce((sum, agent) => sum + agent.key_counts.total, 0);
    const available = agents.reduce((sum, agent) => sum + agent.key_counts.available, 0);
    return {
      status: total === 0 ? "unknown" : available === total ? "success" : available > 0 ? "warning" : "error",
      agent_count: agents.length,
      key_count: total,
      available_key_count: available,
      last_refresh_at: registry.last_refresh_at,
      agents: agents.map((agent) => ({
        id: agent.id,
        label: agent.label,
        status: agent.status,
        available_keys: agent.key_counts.available,
        total_keys: agent.key_counts.total,
        roles: agent.roles
      }))
    };
  };

  const acquireAgentKeyForRole = (roleId, options = {}) => {
    const role = normalizeString(roleId);
    if (!ROLE_IDS.has(role)) return { status: "fail", issues: [issue("unknown_agent_role", `unknown agent role: ${role}`, "role")] };
    const lockOwner = normalizeString(options.lock_owner || options.lockOwner) || "agent-scheduler";
    const lockedAt = normalizeString(options.now) || nowIso();
    const ttlMs = Number(options.ttl_ms || options.ttlMs || 10 * 60 * 1000);
    const expiresAt = new Date(Date.parse(lockedAt) + ttlMs).toISOString();
    const registry = listAgents();
    const locks = new Map(readLocks().map((lock) => [lock.key_id, lock]));
    const candidates = registry.agents
      .filter((agent) => !agent.account_login && agent.roles?.[role] === true)
      .flatMap((agent) => agent.keys.map((key) => ({ agent, key })))
      .filter(({ key }) => key.health.status === "success")
      .filter(({ key }) => {
        if (key.competitive) return true;
        const lock = locks.get(key.id);
        return !lock || Date.parse(lock.expires_at) <= Date.parse(lockedAt);
      });
    if (candidates.length === 0) {
      return { status: "blocked", key: null, issues: [issue("no_healthy_agent_key_for_role", `no healthy agent key is available for role ${role}`, "role")] };
    }
    const { agent, key } = candidates[0];
    if (!key.competitive) {
      runSql(dbPath, `
INSERT INTO agent_key_locks(key_id, lock_owner, locked_at, expires_at)
VALUES (${sqlString(key.id)}, ${sqlString(lockOwner)}, ${sqlString(lockedAt)}, ${sqlString(expiresAt)})
ON CONFLICT(key_id) DO UPDATE SET lock_owner = excluded.lock_owner, locked_at = excluded.locked_at, expires_at = excluded.expires_at;
`, { sqliteBin });
    }
    const secretRow = readAgentKeyForHealth(key.id);
    return {
      status: "acquired",
      key: {
        ...key,
        secret: secretRow?.secret || "",
        agent: { id: agent.id, label: agent.label },
        lock: key.competitive ? null : { lock_owner: lockOwner, locked_at: lockedAt, expires_at: expiresAt }
      },
      issues: []
    };
  };

  const releaseAgentKeyLock = (keyId, lockOwner = "") => {
    const ownerClause = normalizeString(lockOwner) ? `AND lock_owner = ${sqlString(lockOwner)}` : "";
    runSql(dbPath, `DELETE FROM agent_key_locks WHERE key_id = ${sqlString(keyId)} ${ownerClause};`, { sqliteBin });
    return { status: "released", key_id: keyId };
  };

  const markFullHealthCheck = (checkedAt = nowIso()) => {
    writeMeta("last_full_check_at", checkedAt, checkedAt);
    writeMeta("last_refresh_at", checkedAt, checkedAt);
    return { status: "recorded", checked_at: checkedAt };
  };

  return {
    version: AGENT_KEY_STORE_VERSION,
    syncAgentChannels,
    listAgents,
    addAgentKey,
    deleteAgentKey,
    updateAgentRoles,
    readAgentKeyForHealth,
    recordAgentKeyHealth,
    keysDueForHealthCheck,
    summarizeAgentRegistry,
    acquireAgentKeyForRole,
    releaseAgentKeyLock,
    markFullHealthCheck
  };
}
