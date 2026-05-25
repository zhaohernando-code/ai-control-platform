#!/usr/bin/env bash

set -euo pipefail

PROMPT_FILE="${1:-}"
if [[ -z "$PROMPT_FILE" || ! -f "$PROMPT_FILE" ]]; then
  echo "usage: run-codex-proxy-child-worker.sh <prompt-file>" >&2
  exit 64
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CODEX_PROXY="${AI_CONTROL_WORKBENCH_CODEX_PROXY:-/Users/hernando_zhao/codex-proxy.sh}"
CODEX_MODEL="${AI_CONTROL_WORKBENCH_CODEX_MODEL:-gpt-5}"
export PATH="$HOME/.nvm/versions/node/v22.16.0/bin:/Applications/Codex.app/Contents/Resources:$PATH"

if [[ ! -x "$CODEX_PROXY" ]]; then
  echo "codex proxy executable not found: $CODEX_PROXY" >&2
  exit 127
fi

exec "$CODEX_PROXY" exec \
  -m "$CODEX_MODEL" \
  --dangerously-bypass-approvals-and-sandbox \
  -C "$REPO_ROOT" \
  - < "$PROMPT_FILE"
