#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${AI_CONTROL_WORKBENCH_PORT:-4180}"
HOST="${AI_CONTROL_WORKBENCH_HOST:-127.0.0.1}"
HISTORY_PATH="${AI_CONTROL_WORKBENCH_HISTORY_PATH:-docs/examples/projection-history.json}"
SNAPSHOTS_ROOT="${AI_CONTROL_WORKBENCH_SNAPSHOTS_ROOT:-docs/examples}"
EVENTS_PATH="${AI_CONTROL_WORKBENCH_EVENTS_PATH:-tmp/workbench-live-events.json}"
PROJECT_STATUS="${AI_CONTROL_WORKBENCH_PROJECT_STATUS:-PROJECT_STATUS.json}"
NODE_BIN="${AI_CONTROL_WORKBENCH_NODE:-}"

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
exec "$NODE_BIN" tools/run-with-node18.mjs tools/workbench-server.mjs \
  --host "$HOST" \
  --port "$PORT" \
  --history-path "$HISTORY_PATH" \
  --snapshots-root "$SNAPSHOTS_ROOT" \
  --events-path "$EVENTS_PATH" \
  --project-status "$PROJECT_STATUS"
