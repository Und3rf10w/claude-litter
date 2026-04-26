#!/bin/bash
# verdict-version-gate.sh — PreToolUse hook on SendMessage: Layer 1 of the
# 3-layer halt-pending-verdict defense (M3 Component C, proposals/v3-final.md).
#
# Blocks CRITIC from delivering a verdict that references a superseded proposal
# version. Prevents drift class (h) — async messaging race where CRITIC
# verdicts v<N> while orchestrator already bumped to v<N+1>.
#
# Mechanics:
#   1. Fires on every SendMessage PreToolUse (CC source: SendMessage tool in
#      cli_formatted_2.1.117.js:220337; PreToolUse dispatched via Ms_() at
#      :425283; tool_input fully resolved per hooks.md §PreToolUse).
#   2. Filters to messages addressed to "critic" OR messages that look like
#      critique verdicts (contain APPROVED / HOLDING / FAIL / PASS patterns).
#   3. Reads version-sentinel.json from the discovered deepwork INSTANCE_DIR.
#      Absent sentinel → exit 0 (backward-compat for sessions not using the
#      version-bump protocol).
#   4. Extracts the first v<N> reference from tool_input.message. If it does
#      not match sentinel.current_version, exits 2 with version-mismatch
#      error telling CRITIC to re-read the current proposal.
#
# Exit codes:
#   0 — message allowed through
#   2 — message blocked; stderr becomes blockingError injected to model context

set +e
command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

[[ "$TOOL_NAME" == "SendMessage" ]] || exit 0

TO=$(printf '%s' "$INPUT" | jq -r '.tool_input.to // ""' 2>/dev/null)
MESSAGE=$(printf '%s' "$INPUT" | jq -r '.tool_input.message // ""' 2>/dev/null)

# Only act on messages addressed to critic OR messages that look like verdict
# deliveries. Filters out unrelated DMs (e.g., orchestrator → runtime).
IS_VERDICT_SHAPE=0
if [[ "$TO" == "critic" ]]; then
  # Orchestrator → critic: only gate if the message is actively citing a version
  # (this is common when re-sending a verdict request on a new version).
  if printf '%s' "$MESSAGE" | grep -qE '\bv[0-9]+(-final)?\b'; then
    IS_VERDICT_SHAPE=1
  fi
fi
# critic → team-lead verdict delivery (the load-bearing case):
if printf '%s' "$MESSAGE" | grep -qE '\b(APPROVED|HOLDING|FAIL-because|PASS|CONDITIONAL-on)\b'; then
  IS_VERDICT_SHAPE=1
fi
[[ "$IS_VERDICT_SHAPE" == 1 ]] || exit 0

# Discover instance via session_id (hook base input). If we can't resolve, let
# it through — we don't want to block non-deepwork SendMessage traffic.
discover_instance "$SESSION_ID" 2>/dev/null || exit 0

SENTINEL="${INSTANCE_DIR}/version-sentinel.json"
[[ -f "$SENTINEL" ]] || exit 0   # Backward-compat: sessions without version-bump protocol.

CUR_VER=$(jq -r '.current_version // ""' "$SENTINEL" 2>/dev/null)
[[ -n "$CUR_VER" ]] || exit 0

# Extract first v<N> (optionally -final) reference from the message.
MSG_VER=$(printf '%s' "$MESSAGE" | grep -oE 'v[0-9]+(-final)?' | head -1)
[[ -n "$MSG_VER" ]] || exit 0  # No version referenced → nothing to check.

# Normalize: treat v3 and v3-final as equivalent for currency check (sentinel
# may hold "v3" while message cites "v3-final" or vice versa).
MSG_VER_BASE="${MSG_VER%-final}"
CUR_VER_BASE="${CUR_VER%-final}"

if [[ "$MSG_VER_BASE" != "$CUR_VER_BASE" ]]; then
  printf 'Version mismatch: message references %s but the current proposal version is %s.\n' "$MSG_VER" "$CUR_VER" >&2
  printf 'Re-read proposals/%s-final.md (or proposals/%s.md) before sending the verdict.\n' "$CUR_VER_BASE" "$CUR_VER_BASE" >&2
  printf 'This gate prevents drift class (h) — verdicting a superseded version wastes a CRITIQUE cycle.\n' >&2
  printf '  sentinel.current_version = %s\n  message references         %s\n' "$CUR_VER" "$MSG_VER" >&2
  exit 2
fi

exit 0
