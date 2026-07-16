#!/usr/bin/env bash
# PostToolUse: format the file that was just edited/written (best-effort, never fails the tool).
set -uo pipefail
input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
[ -z "$file" ] && exit 0
[ -f "$file" ] || exit 0

case "$file" in
  *.ts|*.tsx|*.js|*.jsx|*.mjs|*.json|*.md|*.css)
    npx --no-install prettier --write "$file" >/dev/null 2>&1 || true
    ;;
esac
exit 0
