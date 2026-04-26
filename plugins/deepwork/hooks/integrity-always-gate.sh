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

# Bypass for /deepwork-reconcile recovery: state-transition.sh replay is read-only
# against events.jsonl and does not depend on event_head being valid — it rebuilds
# state from the event log, which is exactly the operation that fixes a mismatch.
# Blocking replay here would create an unrecoverable deadlock (shlyuz incident 2026-04-26).
# Only bypass when TOOL_NAME is Bash and the command invokes the replay subcommand.
if [[ "$TOOL_NAME" == "Bash" ]]; then
  _IAG_CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
  if printf '%s' "$_IAG_CMD" | grep -qE 'state-transition\.sh[^|;&]*[[:space:]]replay([[:space:]]|$)'; then
    exit 0
  fi
fi

_verify_event_head_or_block || exit 2

exit 0
