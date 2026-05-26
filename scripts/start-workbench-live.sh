#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PORT="${AI_CONTROL_WORKBENCH_PORT:-4180}"
HOST="${AI_CONTROL_WORKBENCH_HOST:-127.0.0.1}"
HISTORY_PATH="${AI_CONTROL_WORKBENCH_HISTORY_PATH:-docs/examples/projection-history.json}"
SNAPSHOTS_ROOT="${AI_CONTROL_WORKBENCH_SNAPSHOTS_ROOT:-docs/examples}"
EVENTS_PATH="${AI_CONTROL_WORKBENCH_EVENTS_PATH:-tmp/workbench-live-events.json}"
PROJECT_STATUS="${AI_CONTROL_WORKBENCH_PROJECT_STATUS:-PROJECT_STATUS.json}"
STATE_DB="${AI_CONTROL_WORKBENCH_STATE_DB:-$HOME/codex/runtime/ai-control-platform/workbench-state/workbench-state.sqlite}"
NODE_BIN="${AI_CONTROL_WORKBENCH_NODE:-}"
DEFAULT_CHILD_WORKER_ARGS_JSON='["{prompt_file}","{output_path}"]'
DEFAULT_CHILD_WORKER_OUTPUT_PATH='tmp/workbench-child-workers/{run_id}-{cycle_id}-{work_package_id}.json'

export AI_CONTROL_WORKBENCH_CHILD_WORKER_COMMAND="${AI_CONTROL_WORKBENCH_CHILD_WORKER_COMMAND:-$REPO_ROOT/scripts/run-claude-child-worker.sh}"
export AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_COMMAND="${AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_COMMAND:-$REPO_ROOT/scripts/claude-role-proxy.sh}"
export AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_ROLE="${AI_CONTROL_WORKBENCH_REQUIREMENT_PLAN_ROLE:-manager}"
export AI_CONTROL_WORKBENCH_CHILD_WORKER_ARGS_JSON="${AI_CONTROL_WORKBENCH_CHILD_WORKER_ARGS_JSON:-$DEFAULT_CHILD_WORKER_ARGS_JSON}"
export AI_CONTROL_WORKBENCH_CHILD_WORKER_TIMEOUT_MS="${AI_CONTROL_WORKBENCH_CHILD_WORKER_TIMEOUT_MS:-1800000}"
export AI_CONTROL_WORKBENCH_CHILD_WORKER_MAX_ATTEMPTS="${AI_CONTROL_WORKBENCH_CHILD_WORKER_MAX_ATTEMPTS:-3}"
export AI_CONTROL_WORKBENCH_CHILD_WORKER_SPLIT_RETRY="${AI_CONTROL_WORKBENCH_CHILD_WORKER_SPLIT_RETRY:-1}"
export AI_CONTROL_WORKBENCH_CHILD_WORKER_OUTPUT_PATH="${AI_CONTROL_WORKBENCH_CHILD_WORKER_OUTPUT_PATH:-$DEFAULT_CHILD_WORKER_OUTPUT_PATH}"

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
mkdir -p "$(dirname "$STATE_DB")"
exec "$NODE_BIN" tools/run-with-node18.mjs tools/workbench-server.mjs \
  --host "$HOST" \
  --port "$PORT" \
  --history-path "$HISTORY_PATH" \
  --snapshots-root "$SNAPSHOTS_ROOT" \
  --events-path "$EVENTS_PATH" \
  --project-status "$PROJECT_STATUS" \
  --state-db "$STATE_DB"
