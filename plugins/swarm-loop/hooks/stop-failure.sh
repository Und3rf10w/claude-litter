#!/bin/bash
# stop-failure.sh — StopFailure observability hook
#
# Fires when the model's turn ends due to an API error (rate limit, billing,
# server error, etc.) instead of normal completion.
#
# StopFailure is fire-and-forget — CC ignores hook output and exit codes.
# This hook is purely for observability/logging.

# Don't fail on errors — this is a non-critical observability hook
set +e

# Require jq
command -v jq >/dev/null 2>&1 || exit 0

# Read hook input from stdin
INPUT=$(cat)

# Bail if subagent — StopFailure for teammates is not actionable at the orchestrator level
HOOK_AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null || echo "")
if [[ -n "$HOOK_AGENT_ID" ]]; then
  exit 0
fi

# Discover instance
_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
HOOK_SESSION=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
discover_instance "$HOOK_SESSION" 2>/dev/null || exit 0

# Read error fields from stdin JSON
ERROR_TYPE=$(echo "$INPUT" | jq -r '.error // "unknown"' 2>/dev/null || echo "unknown")
ERROR_DETAILS=$(echo "$INPUT" | jq -r '.error_details // ""' 2>/dev/null || echo "")

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Read current iteration from state
ITERATION=$(jq -r '.iteration // 1' "$STATE_FILE" 2>/dev/null || echo "1")

# 1. Log to instance log.md
{
  echo ""
  printf '> ⚠️ StopFailure: API error %s: %s at %s\n' "$ERROR_TYPE" "$ERROR_DETAILS" "$NOW"
} >> "$LOG_FILE" 2>/dev/null || true

# 2. Update state.json: set autonomy_health to "degraded", append to api_errors array
TEMP_FILE="${STATE_FILE}.tmp.$$"
jq \
  --arg health "degraded" \
  --arg now "$NOW" \
  --arg error_type "$ERROR_TYPE" \
  --arg details "$ERROR_DETAILS" \
  --argjson iteration "$ITERATION" \
  '.autonomy_health = $health |
   .last_updated = $now |
   .api_errors = ((.api_errors // []) + [{
     "error": $error_type,
     "details": $details,
     "timestamp": $now,
     "iteration": $iteration
   }])' \
  "$STATE_FILE" > "$TEMP_FILE" 2>/dev/null
if [[ -s "$TEMP_FILE" ]]; then
  mv "$TEMP_FILE" "$STATE_FILE"
else
  rm -f "$TEMP_FILE"
fi

# 3. Update heartbeat with error status
GOAL=$(jq -r '.goal // ""' "$STATE_FILE" 2>/dev/null || echo "")
TEAM_NAME=$(jq -r '.team_name // ""' "$STATE_FILE" 2>/dev/null || echo "")
SENTINEL_TIMEOUT=$(jq -r '.sentinel_timeout // 600' "$STATE_FILE" 2>/dev/null || echo "600")
jq -n \
  --argjson iteration "$ITERATION" \
  --arg timestamp "$NOW" \
  --arg phase "api_error" \
  --arg last_tool "stop-failure" \
  --arg goal "$GOAL" \
  --arg team_name "$TEAM_NAME" \
  --arg autonomy_health "degraded" \
  --arg error_type "$ERROR_TYPE" \
  --argjson sentinel_timeout "$SENTINEL_TIMEOUT" \
  '{
    iteration: $iteration,
    timestamp: $timestamp,
    phase: $phase,
    last_tool: $last_tool,
    goal: $goal,
    team_name: $team_name,
    team_active: false,
    autonomy_health: $autonomy_health,
    error_type: $error_type,
    sentinel_timeout: $sentinel_timeout
  }' > "$HEARTBEAT_FILE" 2>/dev/null || true

exit 0
