#!/bin/bash
# heartbeat-update.sh — Async PostToolUse hook for real-time heartbeat updates
#
# Called after every tool call (async, non-blocking). Updates the heartbeat file
# with the latest activity so external monitors can track progress mid-iteration.
#
# Throttled: only updates if the heartbeat file is older than 5 seconds to avoid
# I/O pressure from rapid tool calls.
#
# Schema matches stop-hook.sh heartbeat writes for consistency.

# Don't fail on errors — this is a non-critical observability hook
set +e

# Require jq
command -v jq >/dev/null 2>&1 || exit 0

# Read hook input from stdin
INPUT=$(cat)

# Discover instance
_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
HOOK_SESSION=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
discover_instance "$HOOK_SESSION" 2>/dev/null || exit 0

# Throttle: skip if heartbeat was updated less than 5 seconds ago
if [[ -f "$HEARTBEAT_FILE" ]]; then
  # Fail-open: if stat fails on both platforms, HEARTBEAT_MTIME defaults to "0",
  # making AGE = NOW_SECS (a huge value), so AGE -lt 5 is false and the update
  # proceeds. This is intentional — a missing mtime should never suppress a write.
  HEARTBEAT_MTIME=$(stat -f %m "$HEARTBEAT_FILE" 2>/dev/null || stat -c %Y "$HEARTBEAT_FILE" 2>/dev/null || echo "0")
  NOW_SECS=$(date +%s)
  AGE=$((NOW_SECS - HEARTBEAT_MTIME))
  if [[ $AGE -lt 5 ]]; then
    exit 0  # Too recent, skip
  fi
fi

TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)

# Read state for context
STATE_JSON=$(cat "$STATE_FILE" 2>/dev/null)
ITERATION=$(echo "$STATE_JSON" | jq -r '.iteration // 1' 2>/dev/null)
GOAL=$(echo "$STATE_JSON" | jq -r '.goal // ""' 2>/dev/null)
TEAM_NAME=$(echo "$STATE_JSON" | jq -r '.team_name // ""' 2>/dev/null)
AUTONOMY_HEALTH=$(echo "$STATE_JSON" | jq -r '.autonomy_health // "healthy"' 2>/dev/null)
PERMISSION_FAILURES=$(echo "$STATE_JSON" | jq '[.permission_failures[]?] | length' 2>/dev/null || echo "0")
SENTINEL_TIMEOUT=$(echo "$STATE_JSON" | jq -r '.sentinel_timeout // 600' 2>/dev/null)
PHASE=$(echo "$STATE_JSON" | jq -r '.phase // "working"' 2>/dev/null)

# Read progress from progress.jsonl (v3), fall back to state.json progress_history (v2)
TASKS_COMPLETED=0
TASKS_TOTAL=0
if [[ -f "${INSTANCE_DIR}/progress.jsonl" ]] && [[ -s "${INSTANCE_DIR}/progress.jsonl" ]]; then
  LAST_PROGRESS=$(jq -s '.[-1] // {}' "${INSTANCE_DIR}/progress.jsonl" 2>/dev/null || echo "{}")
  TASKS_COMPLETED=$(echo "$LAST_PROGRESS" | jq '.tasks_completed // 0' 2>/dev/null || echo "0")
  TASKS_TOTAL=$(echo "$LAST_PROGRESS" | jq '.tasks_total // 0' 2>/dev/null || echo "0")
else
  LAST_PROGRESS=$(echo "$STATE_JSON" | jq '.progress_history[-1] // {}' 2>/dev/null)
  TASKS_COMPLETED=$(echo "$LAST_PROGRESS" | jq '.tasks_completed // 0' 2>/dev/null || echo "0")
  TASKS_TOTAL=$(echo "$LAST_PROGRESS" | jq '.tasks_total // 0' 2>/dev/null || echo "0")
fi

# Write heartbeat — unified schema matching stop-hook.sh idle-path writes.
# team_active is always true here because PostToolUse only fires while the session is running.
jq -n \
  --argjson iteration "$ITERATION" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson tasks_completed "$TASKS_COMPLETED" \
  --argjson tasks_total "$TASKS_TOTAL" \
  --arg phase "$PHASE" \
  --arg last_tool "$TOOL_NAME" \
  --arg goal "$GOAL" \
  --arg team_name "$TEAM_NAME" \
  --arg autonomy_health "$AUTONOMY_HEALTH" \
  --argjson permission_failure_count "$PERMISSION_FAILURES" \
  --argjson sentinel_timeout "$SENTINEL_TIMEOUT" \
  '{
    iteration: $iteration,
    timestamp: $timestamp,
    tasks_completed: $tasks_completed,
    tasks_total: $tasks_total,
    phase: $phase,
    last_tool: $last_tool,
    goal: $goal,
    team_name: $team_name,
    team_active: true,
    autonomy_health: $autonomy_health,
    permission_failure_count: $permission_failure_count,
    sentinel_timeout: $sentinel_timeout
  }' > "$HEARTBEAT_FILE" 2>/dev/null

exit 0
