#!/usr/bin/env bash
# hooks/state-bash-gate.sh
# Registered: PreToolUse:Bash via hook-manifest.json (modes: both)
# Blocks shell-redirect writes to state.json that bypass frontmatter-gate.sh,
# which only covers Write|Edit tool calls (W8 H2).
#
# Blocked patterns (case-insensitive):
#   > .*state\.json       redirect
#   >> .*state\.json      append redirect
#   cp .* state\.json     copy overwrite
#   mv .* state\.json     move overwrite
#   tee .* state\.json    tee write
#   dd .* of=.*state\.json  dd write
#
# Allowlist: command invokes the canonical writer via `bash .*state-transition\.sh`.

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

[[ -n "$COMMAND" ]] || exit 0

# Allowlist: state-transition.sh is the canonical writer; let it through.
if printf '%s' "$COMMAND" | grep -qiE 'bash[[:space:]]+[^;|&]*state-transition\.sh'; then
  exit 0
fi

# Block any command that writes to a file named state.json via shell operators or tools.
if printf '%s' "$COMMAND" | grep -qiE '>[[:space:]]*[^;|&]*state\.json|>>[[:space:]]*[^;|&]*state\.json|cp[[:space:]]+[^;|&]*[[:space:]]+state\.json|mv[[:space:]]+[^;|&]*[[:space:]]+state\.json|tee[[:space:]]+[^;|&]*state\.json|dd[[:space:]]+[^;|&]*of=[^;|&]*state\.json'; then
  printf 'state-bash-gate: SINGLE_WRITER_VIOLATION — direct Bash write to state.json is blocked; use state-transition.sh\n' >&2
  exit 2
fi

exit 0
