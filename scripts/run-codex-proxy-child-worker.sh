#!/usr/bin/env bash

set -euo pipefail

PROMPT_FILE="${1:-}"
if [[ -z "$PROMPT_FILE" || ! -f "$PROMPT_FILE" ]]; then
  echo "usage: run-codex-proxy-child-worker.sh <prompt-file>" >&2
  exit 64
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_PROXY="${AI_CONTROL_WORKBENCH_CODEX_PROXY:-/Users/hernando_zhao/codex-proxy.sh}"
CODEX_BIN="${AI_CONTROL_WORKBENCH_CODEX_BIN:-codex}"
CHILD_WORKER_MODE="${AI_CONTROL_WORKBENCH_CHILD_WORKER_MODE:-account}"
CODEX_MODEL="${AI_CONTROL_WORKBENCH_CODEX_MODEL:-}"
export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:/Applications/Codex.app/Contents/Resources:$PATH"

if [[ "$CHILD_WORKER_MODE" == "proxy" ]]; then
  if [[ ! -x "$CODEX_PROXY" ]]; then
    echo "codex proxy executable not found: $CODEX_PROXY" >&2
    exit 127
  fi
  CODEX_BIN="$CODEX_PROXY"
fi

ARGS=(exec)
if [[ -n "$CODEX_MODEL" ]]; then
  ARGS+=(-m "$CODEX_MODEL")
fi
ARGS+=(--dangerously-bypass-approvals-and-sandbox -C "$REPO_ROOT")
ARGS+=(-)

exec "$CODEX_BIN" "${ARGS[@]}" < "$PROMPT_FILE"
