#!/usr/bin/env bash

set -euo pipefail

PROMPT_FILE="${1:-}"
if [[ -z "$PROMPT_FILE" || ! -f "$PROMPT_FILE" ]]; then
  echo "usage: run-claude-child-worker.sh <prompt-file>" >&2
  exit 64
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLAUDE_PROXY="${AI_CONTROL_WORKBENCH_CLAUDE_PROXY:-$REPO_ROOT/scripts/claude-role-proxy.sh}"
CLAUDE_MODEL="${AI_CONTROL_WORKBENCH_CLAUDE_MODEL:-claude-opus-4-7}"
CLAUDE_ROLE="${AI_CONTROL_WORKBENCH_CLAUDE_ROLE:-developer}"
export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/v22.16.0/bin:/Applications/Codex.app/Contents/Resources:$PATH"

if [[ ! -x "$CLAUDE_PROXY" ]]; then
  echo "claude proxy executable not found: $CLAUDE_PROXY" >&2
  exit 127
fi

for env_name in "${!AI_CONTROL_WORKBENCH_CHILD_WORKER_@}"; do
  unset "$env_name"
done

exec "$CLAUDE_PROXY" \
  -m "$CLAUDE_MODEL" \
  --role "$CLAUDE_ROLE" \
  --bare \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --tools default \
  --add-dir "$REPO_ROOT" \
  -p "$(cat "$PROMPT_FILE")"
