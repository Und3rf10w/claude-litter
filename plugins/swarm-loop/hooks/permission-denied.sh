#!/bin/bash
# permission-denied.sh — PermissionDenied hook for recording teammate permission failures
#
# Fires when a tool use is denied by the permission system (user denial or hook denial).
# Records the failure in state.json's permission_failures array so the stop hook's
# stuck escalation can surface it to the orchestrator.
#
# Registered in: settings.local.json via setup-swarm-loop.sh (not in hooks.json)
# Exit 0 always — this is observability only, never blocking.

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

# Only record failures from subagents (teammates), not the orchestrator
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null || echo "")
[[ -n "$AGENT_ID" ]] || exit 0

# Derive teammate name (part before '@')
TEAMMATE="${AGENT_ID%%@*}"
[[ -n "$TEAMMATE" ]] || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

# Discover instance — try session first, then team name from agent_id
HOOK_SESSION=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
if [[ -n "$HOOK_SESSION" ]]; then
  discover_instance "$HOOK_SESSION" 2>/dev/null || true
fi

if [[ -z "${INSTANCE_DIR:-}" ]]; then
  TEAM_FROM_AGENT="${AGENT_ID#*@}"
  if [[ -n "$TEAM_FROM_AGENT" ]] && [[ "$TEAM_FROM_AGENT" != "$AGENT_ID" ]]; then
    discover_instance_by_team_name "$TEAM_FROM_AGENT" 2>/dev/null || true
  fi
fi

[[ -n "${INSTANCE_DIR:-}" ]] || exit 0

trap 'rm -f "${STATE_FILE}.tmp.$$"' EXIT

# Read denied tool info
TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
REASON=$(printf '%s' "$INPUT" | jq -r '.reason // ""' 2>/dev/null || echo "")
ITERATION=$(jq -r '.iteration // 0' "$STATE_FILE" 2>/dev/null || echo "0")

# Truncate tool_input to avoid bloating state.json
TOOL_INPUT_SUMMARY=$(printf '%s' "$INPUT" | jq -r '.tool_input | tostring | .[0:200]' 2>/dev/null || echo "")

# Log to instance log.md
printf '\n> ⚠️ PermissionDenied: %s denied %s for teammate %s: %s\n' \
  "$TOOL_NAME" "$REASON" "$TEAMMATE" "$TOOL_INPUT_SUMMARY" \
  >> "$LOG_FILE" 2>/dev/null || true

# Append to permission_failures in state.json
TEMP_STATE="${STATE_FILE}.tmp.$$"
NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq --arg teammate "$TEAMMATE" \
   --arg tool "$TOOL_NAME" \
   --arg reason "$REASON" \
   --arg operation "$TOOL_INPUT_SUMMARY" \
   --argjson iter "$ITERATION" \
   --arg ts "$NOW_TS" \
   '.permission_failures = (.permission_failures // []) + [{
     iteration: $iter,
     teammate: $teammate,
     tool: $tool,
     operation: $operation,
     reason: $reason,
     timestamp: $ts
   }]' "$STATE_FILE" > "$TEMP_STATE" 2>/dev/null
if [[ -s "$TEMP_STATE" ]]; then
  mv "$TEMP_STATE" "$STATE_FILE"
else
  rm -f "$TEMP_STATE"
fi

exit 0
