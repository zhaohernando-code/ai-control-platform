#!/usr/bin/env bash

set -euo pipefail

PROMPT_FILE="${1:-}"
if [[ -z "$PROMPT_FILE" || ! -f "$PROMPT_FILE" ]]; then
  echo "usage: run-codex-account-child-worker.sh <prompt-file>" >&2
  exit 64
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_BIN="${AI_CONTROL_WORKBENCH_CODEX_BIN:-codex}"
CODEX_MODEL="${AI_CONTROL_WORKBENCH_CODEX_MODEL:-}"
export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:/Applications/Codex.app/Contents/Resources:$PATH"

ARGS=(exec)
if [[ -n "$CODEX_MODEL" ]]; then
  ARGS+=(-m "$CODEX_MODEL")
fi
ARGS+=(--dangerously-bypass-approvals-and-sandbox -C "$REPO_ROOT")
ARGS+=(-)

for env_name in "${!AI_CONTROL_WORKBENCH_CHILD_WORKER_@}"; do
  unset "$env_name"
done

exec "$CODEX_BIN" "${ARGS[@]}" < "$PROMPT_FILE"
