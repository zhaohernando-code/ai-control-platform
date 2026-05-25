#!/usr/bin/env bash

set -euo pipefail

PROMPT_FILE="${1:-}"
if [[ -z "$PROMPT_FILE" || ! -f "$PROMPT_FILE" ]]; then
  echo "usage: run-claude-child-worker.sh <prompt-file>" >&2
  exit 64
fi

CLAUDE_PROXY="${AI_CONTROL_WORKBENCH_CLAUDE_PROXY:-$HOME/claude-proxy.sh}"
CLAUDE_MODEL="${AI_CONTROL_WORKBENCH_CLAUDE_MODEL:-claude-opus-4-7}"

if [[ ! -x "$CLAUDE_PROXY" ]]; then
  echo "claude proxy executable not found: $CLAUDE_PROXY" >&2
  exit 127
fi

for env_name in "${!AI_CONTROL_WORKBENCH_CHILD_WORKER_@}"; do
  unset "$env_name"
done

exec "$CLAUDE_PROXY" -m "$CLAUDE_MODEL" -p "$(cat "$PROMPT_FILE")"
