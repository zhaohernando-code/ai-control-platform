#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
shared_hooks="$repo_root/../../.githooks"
shared_pre_commit="$shared_hooks/pre-commit"

if [ ! -f "$shared_pre_commit" ]; then
  echo "install-git-hooks failed: shared pre-commit hook not found at $shared_pre_commit" >&2
  exit 1
fi

chmod +x "$shared_pre_commit"
git config core.hooksPath ../../.githooks

echo "Installed ai-control-platform git hooks via core.hooksPath=../../.githooks"
