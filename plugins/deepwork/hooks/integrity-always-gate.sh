#!/usr/bin/env bash
# hooks/integrity-always-gate.sh
# Registered: PreToolUse:Write|Edit|Bash|TaskCreate|TaskUpdate|SendMessage (modes: both)
# Always-on event_head integrity check — fires on every tool use, not just state.json writes.
# Fail-open when no active instance (exit 0). Delegates to _verify_event_head_or_block.

set +e

command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

discover_instance "$SESSION_ID" || exit 0   # no active instance = fail-open

_verify_event_head_or_block || exit 2

exit 0
