#!/usr/bin/env bash
# PreToolUse guard: block edits to secret/env files. Exit 2 = block the tool call.
set -euo pipefail
input="$(cat)"
file="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null || true)"
[ -z "$file" ] && exit 0

case "$file" in
  *.env|*.env.*|*/.env|*.pem|*secrets*|*credentials*)
    echo "Blocked: refusing to modify secret/env file '$file'. Edit .env.example (with placeholder values) instead." >&2
    exit 2
    ;;
esac
exit 0
