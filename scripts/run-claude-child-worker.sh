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
const alreadySatisfied = required &&
  integration.status === "pass" &&
  Boolean(integration.base_commit) &&
  integration.integrated_commit === integration.base_commit;

output.command_evidence = {
  ...(output.command_evidence || output.commandEvidence || {}),
  child_worker_integration: integration
};

if (alreadySatisfied) {
  output.no_diff = true;
}

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

validate_child_output_before_integration() {
  [[ -n "$CHILD_OUTPUT_PATH" && -f "$CHILD_OUTPUT_PATH" ]] || {
    printf '%s\n%s\n' "fail" "child output JSON is missing; mainline integration skipped"
    return 0
  }

  CHILD_OUTPUT_PATH="$CHILD_OUTPUT_PATH" \
  CHILD_WORKER_AHEAD_COUNT="${CHILD_WORKER_AHEAD_COUNT:-}" \
  CHILD_WORKER_MERGE_BLOCKING_DIRTY_STATUS="${CHILD_WORKER_MERGE_BLOCKING_DIRTY_STATUS:-}" \
  node --input-type=module <<'NODE'
import { readFileSync } from "node:fs";

function isObject(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}

function passToken(value) {
  return ["pass", "passed", "ok", "success"].includes(normalizeToken(value));
}

function durableStatePass(output) {
  return output.durable_state_updated === true ||
    output.workflow_state_updated === true ||
    isObject(output.durable_state) ||
    isObject(output.workflow_state);
}

const path = process.env.CHILD_OUTPUT_PATH;
let output;
try {
  output = JSON.parse(readFileSync(path, "utf8"));
} catch (error) {
  console.log("fail");
  console.log(`child output JSON cannot be parsed: ${error.message}`);
  process.exit(0);
}

const issues = [];
const testResults = asArray(output.test_results || output.testResults);
const changedFiles = asArray(output.changed_files || output.changedFiles || output.diff_files || output.diffFiles)
  .concat(asArray(output.touched_files || output.touchedFiles))
  .map((entry) => String(entry || "").trim())
  .filter(Boolean);
const processHardening = output.process_hardening || output.processHardening || {};
const continuationReadiness = output.continuation_readiness || output.continuationReadiness || {};
const selfEvaluation = output.self_evaluation || output.selfEvaluation || {};
const allowNoChangedFiles =
  process.env.CHILD_WORKER_AHEAD_COUNT === "0" &&
  !String(process.env.CHILD_WORKER_MERGE_BLOCKING_DIRTY_STATUS || "").trim();

if (!isObject(output)) {
  issues.push("child output must be a JSON object");
}
if (!passToken(output.status)) {
  issues.push("child output status is not pass");
}
if (String(output.host || output.host_classification || "").trim() !== "platform_core") {
  issues.push("child output host is not platform_core");
}
if (changedFiles.length === 0 && !allowNoChangedFiles) {
  issues.push("child output has no changed/touched files");
}
if (testResults.length === 0) {
  issues.push("child output has no test results");
}
for (const [index, testResult] of testResults.entries()) {
  if (!passToken(testResult?.status || testResult?.result)) {
    const command = String(testResult?.command || `test_results[${index}]`).trim();
    issues.push(`child output test failed: ${command}`);
  }
}
if (!durableStatePass(output)) {
  issues.push("child output has no durable state evidence");
}
if (processHardening.required === true && processHardening.status !== "completed") {
  issues.push("child output process hardening is incomplete");
}
if (continuationReadiness.ready !== true) {
  issues.push("child output continuation readiness is not true");
}
if (selfEvaluation.aligned !== true || selfEvaluation.drifted === true) {
  issues.push("child output self evaluation is not aligned");
}

console.log(issues.length ? "fail" : "pass");
console.log(issues.length ? issues.join("; ") : "child output is eligible for mainline integration");
NODE
}

merge_blocking_dirty_status() {
  local repo_root="$1"
  local raw_status="$2"
  [[ -n "$raw_status" ]] || return 0

  CHILD_OUTPUT_PATH="$CHILD_OUTPUT_PATH" \
  RAW_GIT_STATUS="$raw_status" \
  node --input-type=module <<'NODE'
import { existsSync, readFileSync } from "node:fs";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizePath(value = "") {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
}

function statusPath(line = "") {
  const path = line.slice(3).trim();
  const renameParts = path.split(" -> ");
  return normalizePath(renameParts.at(-1) || path);
}

const outputPath = process.env.CHILD_OUTPUT_PATH || "";
let declaredFiles = new Set();
if (outputPath && existsSync(outputPath)) {
  try {
    const output = JSON.parse(readFileSync(outputPath, "utf8"));
    declaredFiles = new Set([
      ...asArray(output.changed_files || output.changedFiles || output.diff_files || output.diffFiles),
      ...asArray(output.touched_files || output.touchedFiles)
    ].map(normalizePath).filter(Boolean));
  } catch {
    declaredFiles = new Set();
  }
}

const allowedPackageManagerSideEffects = new Set(["package-lock.json"]);
const blocking = String(process.env.RAW_GIT_STATUS || "")
  .split(/\r?\n/)
  .filter(Boolean)
  .filter((line) => {
    const path = statusPath(line);
    return !(allowedPackageManagerSideEffects.has(path) && !declaredFiles.has(path));
  });

console.log(blocking.join("\n"));
NODE
}

FINAL_STATUS=$CLAUDE_STATUS
if [[ "$USE_WORKTREE" != "0" && "$INTEGRATE_MAINLINE" != "0" && -n "$CHILD_OUTPUT_PATH" ]]; then
  WORKER_HEAD="$(git -C "$EXECUTION_ROOT" rev-parse HEAD)"
  AHEAD_COUNT="$(git -C "$EXECUTION_ROOT" rev-list --count "$BASE_COMMIT..HEAD")"
  DIRTY_STATUS="$(git -C "$EXECUTION_ROOT" status --porcelain)"
  MERGE_BLOCKING_DIRTY_STATUS="$(merge_blocking_dirty_status "$EXECUTION_ROOT" "$DIRTY_STATUS")"
  PRIMARY_STATUS="$(git -C "$PRIMARY_REPO_ROOT" status --porcelain)"
  PRIMARY_HEAD="$(git -C "$PRIMARY_REPO_ROOT" rev-parse HEAD)"
  export CHILD_WORKER_AHEAD_COUNT="$AHEAD_COUNT"
  export CHILD_WORKER_MERGE_BLOCKING_DIRTY_STATUS="$MERGE_BLOCKING_DIRTY_STATUS"
  CHILD_OUTPUT_VALIDATION="$(validate_child_output_before_integration)"
  CHILD_MERGE_STATUS="$(printf '%s\n' "$CHILD_OUTPUT_VALIDATION" | sed -n '1p')"
  CHILD_MERGE_MESSAGE="$(printf '%s\n' "$CHILD_OUTPUT_VALIDATION" | sed -n '2,$p' | tr '\n' ' ' | sed 's/[[:space:]]*$//')"

  if [[ "$CHILD_MERGE_STATUS" == "pass" ]]; then
    if [[ "$AHEAD_COUNT" -gt 0 && -z "$MERGE_BLOCKING_DIRTY_STATUS" && -z "$PRIMARY_STATUS" && "$PRIMARY_HEAD" == "$BASE_COMMIT" ]]; then
      if git -C "$PRIMARY_REPO_ROOT" merge --ff-only "$WORKTREE_BRANCH" >&2; then
        INTEGRATED_COMMIT="$(git -C "$PRIMARY_REPO_ROOT" rev-parse HEAD)"
        update_child_output_integration "pass" "isolated worker branch fast-forwarded into primary mainline" "$WORKER_HEAD" "$INTEGRATED_COMMIT"
      else
        FINAL_STATUS=1
        update_child_output_integration "fail" "failed to fast-forward isolated worker branch into primary mainline" "$WORKER_HEAD" ""
      fi
    elif [[ "$AHEAD_COUNT" -eq 0 && -z "$MERGE_BLOCKING_DIRTY_STATUS" && -z "$PRIMARY_STATUS" && "$PRIMARY_HEAD" == "$BASE_COMMIT" ]]; then
      update_child_output_integration "pass" "child returned pass with no new committed delta; current mainline accepted as already satisfying the work package" "$WORKER_HEAD" "$PRIMARY_HEAD"
    else
      FINAL_STATUS=1
      update_child_output_integration "fail" "isolated worker result is not mergeable: ahead_count=$AHEAD_COUNT dirty_worker=$([[ -n "$MERGE_BLOCKING_DIRTY_STATUS" ]] && printf yes || printf no) dirty_primary=$([[ -n "$PRIMARY_STATUS" ]] && printf yes || printf no) primary_head_matches_base=$([[ "$PRIMARY_HEAD" == "$BASE_COMMIT" ]] && printf yes || printf no)" "$WORKER_HEAD" ""
    fi
  else
    FINAL_STATUS=1
    update_child_output_integration "fail" "$CHILD_MERGE_MESSAGE" "$WORKER_HEAD" ""
  fi
fi

rm -f "$STDOUT_FILE" "$STDERR_FILE"
exit "$FINAL_STATUS"
