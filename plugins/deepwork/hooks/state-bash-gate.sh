#!/usr/bin/env bash
# hooks/state-bash-gate.sh
# Registered: PreToolUse:Bash via hook-manifest.json (modes: both)
# Blocks shell-redirect writes to state.json and audit-trail files that bypass
# frontmatter-gate.sh, which only covers Write|Edit tool calls (W8 H2, W13).
#
# Protected files (case-insensitive suffix match):
#   state.json
#   events.jsonl
#   pending-change.json
#   discoveries.jsonl
#   rollback_log.jsonl
#   incidents.jsonl
#   metrics-violations.jsonl
#   test-results.jsonl
#   hook-timing.jsonl
#   override-tokens.json
#
# Blocked patterns (case-insensitive):
#   > .*<file>       redirect
#   >> .*<file>      append redirect
#   cp .* <file>     copy overwrite
#   mv .* <file>     move overwrite
#   tee .* <file>    tee write
#   dd .* of=.*<file>  dd write
#
# Allowlist (checked before block):
#   - command invokes `bash .*state-transition\.sh`
#   - command invokes `bash .*test-capture\.sh` (canonical writer for test-results.jsonl)
#   - env sentinel _DW_STATE_TRANSITION_WRITER=1 is set (subprocess of state-transition.sh)

set +e

command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')

[[ -n "$COMMAND" ]] || exit 0

# Allowlist: canonical writers; let them through.
if printf '%s' "$COMMAND" | grep -qiE 'bash[[:space:]]+[^;|&]*state-transition\.sh'; then
  exit 0
fi
if printf '%s' "$COMMAND" | grep -qiE 'bash[[:space:]]+[^;|&]*test-capture\.sh'; then
  exit 0
fi
# Subprocess sentinel: state-transition.sh sets this before writing
[[ "${_DW_STATE_TRANSITION_WRITER:-}" == "1" ]] && exit 0

# Protected file pattern — matches any of the audit-trail filenames.
_PROTECTED='(state\.json|events\.jsonl|pending-change\.json|discoveries\.jsonl|rollback_log\.jsonl|incidents\.jsonl|metrics-violations\.jsonl|test-results\.jsonl|hook-timing\.jsonl|override-tokens\.json)'

# pending-change.json writes get a discriminated error with actionable instruction.
_PENDING_CHANGE='pending-change\.json'
if printf '%s' "$COMMAND" | grep -qiE \
  ">[[:space:]]*[^;|&]*${_PENDING_CHANGE}|>>[[:space:]]*[^;|&]*${_PENDING_CHANGE}|cp[[:space:]]+[^;|&]*[[:space:]]+${_PENDING_CHANGE}|mv[[:space:]]+[^;|&]*[[:space:]]+${_PENDING_CHANGE}|tee[[:space:]]+[^;|&]*${_PENDING_CHANGE}|dd[[:space:]]+[^;|&]*of=[^;|&]*${_PENDING_CHANGE}"; then
  printf 'state-bash-gate: EXIT_PENDING_CHANGE_DIRECT_WRITE — direct Bash write to pending-change.json is blocked.\n' >&2
  printf '  Use: bash plugins/deepwork/scripts/state-transition.sh pending_change_set --plan-section <id> --files <json-array> --rationale <text>\n' >&2
  exit 2
fi

# Block redirect/copy/move/tee/dd writes to any other protected file.
if printf '%s' "$COMMAND" | grep -qiE \
  ">[[:space:]]*[^;|&]*${_PROTECTED}|>>[[:space:]]*[^;|&]*${_PROTECTED}|cp[[:space:]]+[^;|&]*[[:space:]]+${_PROTECTED}|mv[[:space:]]+[^;|&]*[[:space:]]+${_PROTECTED}|tee[[:space:]]+[^;|&]*${_PROTECTED}|dd[[:space:]]+[^;|&]*of=[^;|&]*${_PROTECTED}"; then
  _matched=$(printf '%s' "$COMMAND" | grep -oiE \
    ">[[:space:]]*[^;|&]*${_PROTECTED}|>>[[:space:]]*[^;|&]*${_PROTECTED}|cp[[:space:]]+[^;|&]*[[:space:]]+${_PROTECTED}|mv[[:space:]]+[^;|&]*[[:space:]]+${_PROTECTED}|tee[[:space:]]+[^;|&]*${_PROTECTED}|dd[[:space:]]+[^;|&]*of=[^;|&]*${_PROTECTED}" | head -1)
  printf 'state-bash-gate: SINGLE_WRITER_VIOLATION — direct Bash write to audit-trail file is blocked; use state-transition.sh\n' >&2
  printf '  matched: %s\n' "$_matched" >&2
  exit 2
fi

exit 0
