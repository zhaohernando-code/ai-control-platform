import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const AGENT_KEY_STORE_VERSION = "agent-key-store.sqlite.v1";
const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DEFAULT_AGENT_CHANNEL_CONFIG_PATH = resolve(PROJECT_ROOT, "config/agent-channels.json");
export const DEFAULT_MANUAL_AGENT_CONFIG_PATH = DEFAULT_AGENT_CHANNEL_CONFIG_PATH;

export const AGENT_ROLE_DEFINITIONS = [
  { id: "plan_generation", label: "计划生成" },
  { id: "task_scheduling", label: "任务生成调度" },
  { id: "code_implementation", label: "代码落地" },
  { id: "acceptance_check", label: "验收检查" },
  { id: "recovery_locator", label: "恢复/定位" }
];

export const ROLE_IDS = new Set(AGENT_ROLE_DEFINITIONS.map((role) => role.id));

export function normalizeString(value) {
  return String(value || "").trim();
}

export function normalizeToken(value) {
  return normalizeString(value).toLowerCase();
}

export function asArray(value) {
  return Array.isArray(value) ? value : [];
}

export function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function nowIso() {
  return new Date().toISOString();
}

export function sqlString(value) {
  return `'${String(value ?? "").replace(/'/g, "''")}'`;
}

export function runSql(dbPath, sql, options = {}) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const result = spawnSync(options.sqliteBin || "sqlite3", [dbPath], {
    input: sql,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    const error = new Error(normalizeString(result.stderr) || "sqlite3 command failed");
    error.code = "SQLITE_AGENT_KEY_STORE_FAILED";
    error.stderr = result.stderr;
    error.stdout = result.stdout;
    throw error;
  }
  return result.stdout;
}

export function queryRows(dbPath, sql, options = {}) {
  const result = spawnSync(options.sqliteBin || "sqlite3", ["-json", dbPath], {
    input: sql,
    encoding: "utf8",
    maxBuffer: options.maxBuffer || 20 * 1024 * 1024
  });
  if (result.status !== 0) {
    const error = new Error(normalizeString(result.stderr) || "sqlite3 query failed");
    error.code = "SQLITE_AGENT_KEY_STORE_FAILED";
    error.stderr = result.stderr;
    error.stdout = result.stdout;
    throw error;
  }
  const output = normalizeString(result.stdout);
  return output ? JSON.parse(output) : [];
}

export function schemaSql() {
  return `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS agent_channels (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  runner TEXT NOT NULL,
  base_url TEXT,
  auth_type TEXT,
  default_model TEXT,
  models_json TEXT NOT NULL DEFAULT '[]',
  account_login INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_role_settings (
  agent_id TEXT PRIMARY KEY,
  roles_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_api_keys (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  secret TEXT NOT NULL,
  masked_secret TEXT NOT NULL,
  competitive INTEGER NOT NULL DEFAULT 0,
  provider TEXT,
  base_url TEXT,
  auth_type TEXT,
  default_model TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  FOREIGN KEY(agent_id) REFERENCES agent_channels(id)
);
CREATE INDEX IF NOT EXISTS agent_api_keys_agent_idx ON agent_api_keys(agent_id, deleted_at);
CREATE TABLE IF NOT EXISTS agent_key_health_checks (
  id TEXT PRIMARY KEY,
  key_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  checked_at TEXT NOT NULL,
  error_code TEXT,
  error_summary TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(key_id) REFERENCES agent_api_keys(id)
);
CREATE INDEX IF NOT EXISTS agent_key_health_latest_idx ON agent_key_health_checks(key_id, checked_at);
CREATE TABLE IF NOT EXISTS agent_account_health_checks (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  status TEXT NOT NULL,
  latency_ms INTEGER,
  checked_at TEXT NOT NULL,
  error_code TEXT,
  error_summary TEXT,
  raw_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(agent_id) REFERENCES agent_channels(id)
);
CREATE INDEX IF NOT EXISTS agent_account_health_latest_idx ON agent_account_health_checks(agent_id, checked_at);
CREATE TABLE IF NOT EXISTS agent_key_locks (
  key_id TEXT PRIMARY KEY,
  lock_owner TEXT NOT NULL,
  locked_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  FOREIGN KEY(key_id) REFERENCES agent_api_keys(id)
);
CREATE TABLE IF NOT EXISTS agent_health_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;
}

export function safeIdPart(value) {
  return normalizeString(value).replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

export function maskSecret(secret = "") {
  const value = normalizeString(secret);
  if (!value) return "";
  const head = value.slice(0, Math.min(6, Math.max(2, Math.floor(value.length / 4))));
  const tail = value.slice(Math.max(value.length - 4, head.length));
  return `${head}...${tail}`;
}

export function providerFromChannel(channel = {}) {
  const authType = normalizeToken(channel.auth?.type || channel.auth_type || channel.authType);
  const runner = normalizeToken(channel.runner);
  const baseUrl = normalizeToken(channel.base_url || channel.baseUrl);
  if (authType.includes("anthropic") || runner === "claude" || baseUrl.includes("anthropic")) return "anthropic";
  if (authType.includes("openai") || runner === "codex" || baseUrl.includes("openai")) return "openai";
  return runner || "unknown";
}

export function channelFromManualConfig(channel = {}) {
  const authType = normalizeString(channel.auth?.type || channel.auth_type || channel.authType);
  const id = normalizeString(channel.id);
  if (!id) return null;
  return {
    id,
    label: normalizeString(channel.label) || id,
    runner: normalizeString(channel.runner) || "unknown",
    base_url: normalizeString(channel.base_url || channel.baseUrl),
    auth_type: authType,
    default_model: normalizeString(channel.default_model || channel.defaultModel),
    models: asArray(channel.models).map(normalizeString).filter(Boolean),
    account_login: authType === "codex_account"
  };
}

export function readManualChannels(configPath) {
  if (!configPath || !existsSync(configPath)) return [];
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  return asArray(parsed.channels).map(channelFromManualConfig).filter(Boolean);
}

export function readManualChannelHealthConfig(configPath, agentId) {
  if (!configPath || !existsSync(configPath)) return null;
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  const channel = asArray(parsed.channels).find((entry) => normalizeString(entry.id) === normalizeString(agentId));
  if (!channel) return null;
  const normalized = channelFromManualConfig(channel);
  if (!normalized) return null;
  return {
    ...normalized,
    cli: normalizeString(channel.cli),
    codex_home: normalizeString(channel.codex_home || channel.codexHome),
    fixed_args: asArray(channel.fixed_args || channel.args).map(normalizeString).filter(Boolean),
    env: isObject(channel.env) ? channel.env : {}
  };
}

export function roleDefaults() {
  return Object.fromEntries(AGENT_ROLE_DEFINITIONS.map((role) => [role.id, true]));
}

export function normalizeRoles(input = {}) {
  const defaults = roleDefaults();
  if (!isObject(input)) return defaults;
  return Object.fromEntries(AGENT_ROLE_DEFINITIONS.map((role) => [
    role.id,
    typeof input[role.id] === "boolean" ? input[role.id] : defaults[role.id]
  ]));
}

export function issue(code, message, path) {
  return { code, message, path };
}

export function latestHealthByKey(rows = []) {
  const latest = new Map();
  for (const row of rows) {
    const existing = latest.get(row.key_id);
    if (!existing || normalizeString(existing.checked_at) < normalizeString(row.checked_at)) {
      latest.set(row.key_id, row);
    }
  }
  return latest;
}

export function latestHealthByAgent(rows = []) {
  const latest = new Map();
  for (const row of rows) {
    const existing = latest.get(row.agent_id);
    if (!existing || normalizeString(existing.checked_at) < normalizeString(row.checked_at)) {
      latest.set(row.agent_id, row);
    }
  }
  return latest;
}

export function parseJson(value, fallback) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function agentStatus(keys = []) {
  if (keys.length === 0) return "unknown";
  const statuses = keys.map((key) => key.health?.status || "unknown");
  const success = statuses.filter((status) => status === "success").length;
  if (success === keys.length) return "success";
  if (success > 0) return "warning";
  if (statuses.some((status) => status === "error" || status === "warning")) return "error";
  return "unknown";
}

export function publicKey(row = {}, health = null, lock = null) {
  return {
    id: row.id,
    agent_id: row.agent_id,
    alias: row.alias,
    masked_secret: row.masked_secret,
    competitive: Boolean(row.competitive),
    provider: row.provider,
    base_url: row.base_url,
    auth_type: row.auth_type,
    default_model: row.default_model,
    created_at: row.created_at,
    updated_at: row.updated_at,
    deleted_at: row.deleted_at || null,
    health: health ? {
      status: health.status,
      latency_ms: health.latency_ms,
      checked_at: health.checked_at,
      error_code: health.error_code || null,
      error_summary: health.error_summary || null
    } : {
      status: "unknown",
      latency_ms: null,
      checked_at: null,
      error_code: null,
      error_summary: null
    },
    lock: lock ? {
      lock_owner: lock.lock_owner,
      locked_at: lock.locked_at,
      expires_at: lock.expires_at
    } : null
  };
}

export function publicAccountHealth(health = null) {
  return health ? {
    status: health.status,
    latency_ms: health.latency_ms,
    checked_at: health.checked_at,
    error_code: health.error_code || null,
    error_summary: health.error_summary || null
  } : {
    status: "unknown",
    latency_ms: null,
    checked_at: null,
    error_code: null,
    error_summary: null
  };
}
