#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${AI_CONTROL_WORKBENCH_PORT:-4180}"
HOST="${AI_CONTROL_WORKBENCH_HOST:-127.0.0.1}"
API_PORT="${AI_CONTROL_WORKBENCH_API_PORT:-4182}"
API_HOST="${AI_CONTROL_WORKBENCH_API_HOST:-127.0.0.1}"
HISTORY_PATH="${AI_CONTROL_WORKBENCH_HISTORY_PATH:-docs/examples/projection-history.json}"
SNAPSHOTS_ROOT="${AI_CONTROL_WORKBENCH_SNAPSHOTS_ROOT:-docs/examples}"
EVENTS_PATH="${AI_CONTROL_WORKBENCH_EVENTS_PATH:-tmp/workbench-live-events.json}"
PROJECT_STATUS="${AI_CONTROL_WORKBENCH_PROJECT_STATUS:-PROJECT_STATUS.json}"
STATE_DB="${AI_CONTROL_WORKBENCH_STATE_DB:-$HOME/codex/runtime/ai-control-platform/workbench-state/workbench-state.sqlite}"
NEXTJS_AUTO_BUILD="${AI_CONTROL_WORKBENCH_NEXTJS_AUTO_BUILD:-1}"
NODE_BIN="${AI_CONTROL_WORKBENCH_NODE:-}"
NEXT_DIR="$REPO_ROOT/apps/workbench"
NEXT_BIN="$NEXT_DIR/node_modules/next/dist/bin/next"

export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:$HOME/.local/bin:/Applications/Codex.app/Contents/Resources:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export AI_CONTROL_WORKBENCH_AGENT_CHANNELS_PATH="${AI_CONTROL_WORKBENCH_AGENT_CHANNELS_PATH:-$REPO_ROOT/config/agent-channels.json}"
export AI_CONTROL_WORKBENCH_AGENT_PROFILES_PATH="${AI_CONTROL_WORKBENCH_AGENT_PROFILES_PATH:-$REPO_ROOT/config/agent-profiles.json}"
export AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_TIMEOUT_MS="${AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_TIMEOUT_MS:-300000}"
export AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS="${AI_CONTROL_WORKBENCH_CONTEXT_PROVIDER_TIMEOUT_SECONDS:-120}"

if [[ -z "$NODE_BIN" ]]; then
  if command -v node >/dev/null 2>&1; then
    NODE_BIN="$(command -v node)"
  elif [[ -x "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" ]]; then
    NODE_BIN="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
  elif [[ -x "$HOME/.nvm/versions/node/v22.16.0/bin/node" ]]; then
    NODE_BIN="$HOME/.nvm/versions/node/v22.16.0/bin/node"
  else
    echo "node executable not found; set AI_CONTROL_WORKBENCH_NODE" >&2
    exit 127
  fi
fi

cd "$REPO_ROOT"

if [[ ! -x "$NEXT_BIN" ]]; then
  (cd "$NEXT_DIR" && npm install --no-audit --no-fund)
fi

if [[ "$NEXTJS_AUTO_BUILD" != "0" ]]; then
  echo "[workbench-live] building Next.js runtime app..." >&2
  (
    cd "$NEXT_DIR"
    WORKBENCH_MOUNT_PREFIX="${WORKBENCH_MOUNT_PREFIX:-/projects/ai-control-platform}" \
    WORKBENCH_API_BASE="${WORKBENCH_API_BASE:-/projects/ai-control-platform}" \
    WORKBENCH_API_PROXY_TARGET="${WORKBENCH_API_PROXY_TARGET:-http://${API_HOST}:${API_PORT}}" \
    "$NODE_BIN" "$NEXT_BIN" build
  )
fi

mkdir -p "$(dirname "$STATE_DB")"
cleanup() {
  if [[ -n "${NEXT_PID:-}" ]]; then
    kill "$NEXT_PID" >/dev/null 2>&1 || true
    wait "$NEXT_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${API_PID:-}" ]]; then
    kill "$API_PID" >/dev/null 2>&1 || true
    wait "$API_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT INT TERM

"$NODE_BIN" tools/run-with-node18.mjs tools/workbench-server.mjs \
  --host "$API_HOST" \
  --port "$API_PORT" \
  --history-path "$HISTORY_PATH" \
  --snapshots-root "$SNAPSHOTS_ROOT" \
  --events-path "$EVENTS_PATH" \
  --project-status "$PROJECT_STATUS" \
  --state-db "$STATE_DB" &
API_PID="$!"

sleep 1
if ! kill -0 "$API_PID" >/dev/null 2>&1; then
  echo "[workbench-live] API backend failed to start on ${API_HOST}:${API_PORT}" >&2
  wait "$API_PID" || true
  exit 1
fi

cd "$NEXT_DIR"
export WORKBENCH_MOUNT_PREFIX="${WORKBENCH_MOUNT_PREFIX:-/projects/ai-control-platform}"
export WORKBENCH_API_BASE="${WORKBENCH_API_BASE:-/projects/ai-control-platform}"
export WORKBENCH_API_PROXY_TARGET="${WORKBENCH_API_PROXY_TARGET:-http://${API_HOST}:${API_PORT}}"

"$NODE_BIN" "$NEXT_BIN" start \
  -H "$HOST" \
  -p "$PORT" &
NEXT_PID="$!"
wait "$NEXT_PID"
