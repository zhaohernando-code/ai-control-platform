#!/usr/bin/env bash

set -euo pipefail

PROMPT_FILE="${1:-}"
if [[ -z "$PROMPT_FILE" || ! -f "$PROMPT_FILE" ]]; then
  echo "usage: run-claude-child-worker.sh <prompt-file>" >&2
  exit 64
fi

PRIMARY_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_NAME="$(basename "$PRIMARY_REPO_ROOT")"
USE_WORKTREE="${AI_CONTROL_WORKBENCH_CHILD_WORKER_USE_WORKTREE:-1}"
WORKER_ROOT="${AI_CONTROL_WORKBENCH_WORKER_WORKSPACES_ROOT:-$HOME/codex/worker-workspaces}"
EXECUTION_ROOT="$PRIMARY_REPO_ROOT"

if [[ "$USE_WORKTREE" != "0" ]]; then
  PROMPT_HASH="$(shasum -a 256 "$PROMPT_FILE" | cut -c1-12)"
  WORKTREE_DIR="$WORKER_ROOT/$REPO_NAME/child-$PROMPT_HASH-$$"
  WORKTREE_BRANCH="worker/$REPO_NAME/child-$PROMPT_HASH-$$"
  mkdir -p "$(dirname "$WORKTREE_DIR")"
  git -C "$PRIMARY_REPO_ROOT" worktree add -b "$WORKTREE_BRANCH" "$WORKTREE_DIR" HEAD >&2
  EXECUTION_ROOT="$WORKTREE_DIR"
  export AI_CONTROL_WORKBENCH_CHILD_WORKTREE_PATH="$WORKTREE_DIR"
  export AI_CONTROL_WORKBENCH_CHILD_WORKTREE_BRANCH="$WORKTREE_BRANCH"
  export AI_CONTROL_WORKBENCH_PRIMARY_WORKTREE_PATH="$PRIMARY_REPO_ROOT"
fi

CLAUDE_PROXY="${AI_CONTROL_WORKBENCH_CLAUDE_PROXY:-$PRIMARY_REPO_ROOT/scripts/claude-role-proxy.sh}"
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

cd "$EXECUTION_ROOT"
exec "$CLAUDE_PROXY" \
  -m "$CLAUDE_MODEL" \
  --role "$CLAUDE_ROLE" \
  --bare \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --tools default \
  --add-dir "$EXECUTION_ROOT" \
  -p "$(cat "$PROMPT_FILE")"
