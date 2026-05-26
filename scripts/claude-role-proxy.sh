#!/usr/bin/env bash

set -euo pipefail

POOL_DIR="${AI_CONTROL_WORKBENCH_CLAUDE_KEY_POOL_DIR:-$HOME/codex/runtime/ai-control-platform/secrets/claude-key-pools}"
STATE_DIR="${AI_CONTROL_WORKBENCH_CLAUDE_KEY_STATE_DIR:-$HOME/codex/runtime/ai-control-platform/claude-key-state}"
BASE_URL="${AI_CONTROL_WORKBENCH_CLAUDE_BASE_URL:-https://cc.freemodel.dev}"
DEFAULT_ROLE="${AI_CONTROL_WORKBENCH_CLAUDE_ROLE:-developer}"
AVAILABLE_MODELS=("claude-opus-4-7" "claude-sonnet-4-6" "claude-haiku-4-5-20251001")

mkdir -p "$STATE_DIR"

ROLE="$DEFAULT_ROLE"
MODEL=""
CLAUDE_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --role)
      ROLE="${2:-}"
      shift 2
      ;;
    -m|--model)
      MODEL="${2:-}"
      shift 2
      ;;
    *)
      CLAUDE_ARGS+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$ROLE" || ! "$ROLE" =~ ^[a-zA-Z0-9_-]+$ ]]; then
  echo "[claude-role-proxy] invalid role: ${ROLE:-missing}" >&2
  exit 64
fi

if [[ -z "$MODEL" || "$MODEL" == "random" ]]; then
  MODEL="${AVAILABLE_MODELS[$((RANDOM % ${#AVAILABLE_MODELS[@]}))]}"
fi

VALID=false
for candidate in "${AVAILABLE_MODELS[@]}"; do
  if [[ "$MODEL" == "$candidate" ]]; then
    VALID=true
    break
  fi
done
if [[ "$VALID" != true ]]; then
  echo "[claude-role-proxy] unknown model: $MODEL" >&2
  echo "  Available: ${AVAILABLE_MODELS[*]}" >&2
  exit 64
fi

KEYS_FILE="$POOL_DIR/$ROLE.keys"
if [[ "$ROLE" == "manager" && ! -f "$KEYS_FILE" && -f "$HOME/.claude/configs/proxy/keys.txt" ]]; then
  KEYS_FILE="$HOME/.claude/configs/proxy/keys.txt"
fi
if [[ ! -f "$KEYS_FILE" ]]; then
  echo "[claude-role-proxy] key pool not found for role=$ROLE: $KEYS_FILE" >&2
  exit 66
fi

SELECTED_KEY=""
SELECTED_LOCK=""
while IFS= read -r line || [[ -n "$line" ]]; do
  [[ -z "$line" || "$line" == \#* ]] && continue
  key="$line"
  key_hash="$(printf '%s' "$key" | shasum -a 256 | cut -c1-16)"
  lock_file="$STATE_DIR/$ROLE-$key_hash.lock"
  if [[ -f "$lock_file" ]]; then
    lock_pid="$(cat "$lock_file" 2>/dev/null || true)"
    if [[ -n "$lock_pid" ]] && kill -0 "$lock_pid" 2>/dev/null; then
      continue
    fi
    rm -f "$lock_file"
  fi

  SELECTED_KEY="$key"
  SELECTED_LOCK="$lock_file"
  break
done < "$KEYS_FILE"

if [[ -z "$SELECTED_KEY" || -z "$SELECTED_LOCK" ]]; then
  echo "[claude-role-proxy] no available API keys for role=$ROLE" >&2
  exit 75
fi

printf '%s\n' "$$" > "$SELECTED_LOCK"
cleanup() {
  rm -f "$SELECTED_LOCK"
}
trap cleanup EXIT

export ANTHROPIC_BASE_URL="$BASE_URL"
export ANTHROPIC_API_KEY="$SELECTED_KEY"
export ANTHROPIC_MODEL="$MODEL"

echo "[claude-role-proxy] role=$ROLE model=$MODEL" >&2

exec claude "${CLAUDE_ARGS[@]}"
