#!/usr/bin/env bash

set -euo pipefail

PROMPT_FILE="${1:-}"
if [[ -z "$PROMPT_FILE" || ! -f "$PROMPT_FILE" ]]; then
  echo "usage: run-claude-child-worker.sh <prompt-file> [child-output-json]" >&2
  exit 64
fi
CHILD_OUTPUT_PATH="${2:-}"

PRIMARY_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_NAME="$(basename "$PRIMARY_REPO_ROOT")"
USE_WORKTREE="${AI_CONTROL_WORKBENCH_CHILD_WORKER_USE_WORKTREE:-1}"
INTEGRATE_MAINLINE="${AI_CONTROL_WORKBENCH_CHILD_WORKER_INTEGRATE_MAINLINE:-1}"
WORKER_ROOT="${AI_CONTROL_WORKBENCH_WORKER_WORKSPACES_ROOT:-$HOME/codex/worker-workspaces}"
EXECUTION_ROOT="$PRIMARY_REPO_ROOT"
BASE_COMMIT="$(git -C "$PRIMARY_REPO_ROOT" rev-parse HEAD)"
WORKTREE_DIR=""
WORKTREE_BRANCH=""

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
STDOUT_FILE="$(mktemp -t ai-control-child-worker-stdout.XXXXXX)"
STDERR_FILE="$(mktemp -t ai-control-child-worker-stderr.XXXXXX)"

set +e
"$CLAUDE_PROXY" \
  -m "$CLAUDE_MODEL" \
  --role "$CLAUDE_ROLE" \
  --bare \
  --permission-mode bypassPermissions \
  --no-session-persistence \
  --tools default \
  --add-dir "$EXECUTION_ROOT" \
  -p "$(cat "$PROMPT_FILE")" >"$STDOUT_FILE" 2>"$STDERR_FILE"
CLAUDE_STATUS=$?
set -e

cat "$STDERR_FILE" >&2 || true
cat "$STDOUT_FILE" || true

update_child_output_integration() {
  local status="$1"
  local message="$2"
  local worker_head="${3:-}"
  local integrated_commit="${4:-}"

  [[ -n "$CHILD_OUTPUT_PATH" && -f "$CHILD_OUTPUT_PATH" ]] || return 0

  CHILD_OUTPUT_PATH="$CHILD_OUTPUT_PATH" \
  INTEGRATION_STATUS="$status" \
  INTEGRATION_MESSAGE="$message" \
  INTEGRATION_REQUIRED="$([[ "$USE_WORKTREE" != "0" && "$INTEGRATE_MAINLINE" != "0" ]] && printf true || printf false)" \
  PRIMARY_REPO_ROOT="$PRIMARY_REPO_ROOT" \
  WORKTREE_DIR="$WORKTREE_DIR" \
  WORKTREE_BRANCH="$WORKTREE_BRANCH" \
  BASE_COMMIT="$BASE_COMMIT" \
  WORKER_HEAD="$worker_head" \
  INTEGRATED_COMMIT="$integrated_commit" \
  node --input-type=module <<'NODE'
import { readFileSync, writeFileSync } from "node:fs";

const path = process.env.CHILD_OUTPUT_PATH;
let output = {};
try {
  output = JSON.parse(readFileSync(path, "utf8"));
} catch {
  output = {};
}

const required = process.env.INTEGRATION_REQUIRED === "true";
const integration = {
  required,
  status: process.env.INTEGRATION_STATUS,
  message: process.env.INTEGRATION_MESSAGE,
  merge_mode: required ? "ff-only" : "not_required",
  primary_worktree_path: process.env.PRIMARY_REPO_ROOT || null,
  worker_worktree_path: process.env.WORKTREE_DIR || null,
  worker_branch: process.env.WORKTREE_BRANCH || null,
  base_commit: process.env.BASE_COMMIT || null,
  worker_head: process.env.WORKER_HEAD || null,
  integrated_commit: process.env.INTEGRATED_COMMIT || null
};

output.command_evidence = {
  ...(output.command_evidence || output.commandEvidence || {}),
  child_worker_integration: integration
};

if (required && integration.status !== "pass") {
  output.status = "fail";
  output.blocker = output.blocker || integration.message;
  output.continuation_readiness = { ready: false };
  output.self_evaluation = {
    ...(output.self_evaluation || output.selfEvaluation || {}),
    aligned: false,
    drifted: false,
    evidence_sufficient: false
  };
  output.process_hardening = {
    required: true,
    status: "pending"
  };
}

writeFileSync(path, `${JSON.stringify(output, null, 2)}\n`);
NODE
}

FINAL_STATUS=$CLAUDE_STATUS
if [[ "$USE_WORKTREE" != "0" && "$INTEGRATE_MAINLINE" != "0" && -n "$CHILD_OUTPUT_PATH" ]]; then
  WORKER_HEAD="$(git -C "$EXECUTION_ROOT" rev-parse HEAD)"
  CHILD_STATUS="$(CHILD_OUTPUT_PATH="$CHILD_OUTPUT_PATH" node --input-type=module <<'NODE'
import { existsSync, readFileSync } from "node:fs";
const path = process.env.CHILD_OUTPUT_PATH;
if (!path || !existsSync(path)) {
  console.log("");
  process.exit(0);
}
try {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  console.log(String(parsed.status || "").toLowerCase());
} catch {
  console.log("");
}
NODE
)"
  if [[ "$CHILD_STATUS" == "pass" ]]; then
    AHEAD_COUNT="$(git -C "$EXECUTION_ROOT" rev-list --count "$BASE_COMMIT..HEAD")"
    DIRTY_STATUS="$(git -C "$EXECUTION_ROOT" status --porcelain)"
    PRIMARY_STATUS="$(git -C "$PRIMARY_REPO_ROOT" status --porcelain)"
    PRIMARY_HEAD="$(git -C "$PRIMARY_REPO_ROOT" rev-parse HEAD)"

    if [[ "$AHEAD_COUNT" -gt 0 && -z "$DIRTY_STATUS" && -z "$PRIMARY_STATUS" && "$PRIMARY_HEAD" == "$BASE_COMMIT" ]]; then
      if git -C "$PRIMARY_REPO_ROOT" merge --ff-only "$WORKTREE_BRANCH" >&2; then
        INTEGRATED_COMMIT="$(git -C "$PRIMARY_REPO_ROOT" rev-parse HEAD)"
        update_child_output_integration "pass" "isolated worker branch fast-forwarded into primary mainline" "$WORKER_HEAD" "$INTEGRATED_COMMIT"
      else
        FINAL_STATUS=1
        update_child_output_integration "fail" "failed to fast-forward isolated worker branch into primary mainline" "$WORKER_HEAD" ""
      fi
    elif [[ "$AHEAD_COUNT" -eq 0 && -z "$DIRTY_STATUS" ]]; then
      FINAL_STATUS=1
      update_child_output_integration "fail" "child returned pass but isolated worker branch has no committed mainline delta" "$WORKER_HEAD" ""
    else
      FINAL_STATUS=1
      update_child_output_integration "fail" "isolated worker result is not mergeable: ahead_count=$AHEAD_COUNT dirty_worker=$([[ -n "$DIRTY_STATUS" ]] && printf yes || printf no) dirty_primary=$([[ -n "$PRIMARY_STATUS" ]] && printf yes || printf no) primary_head_matches_base=$([[ "$PRIMARY_HEAD" == "$BASE_COMMIT" ]] && printf yes || printf no)" "$WORKER_HEAD" ""
    fi
  else
    update_child_output_integration "skipped" "child output status is not pass; mainline integration skipped" "$WORKER_HEAD" ""
  fi
fi

rm -f "$STDOUT_FILE" "$STDERR_FILE"
exit "$FINAL_STATUS"
