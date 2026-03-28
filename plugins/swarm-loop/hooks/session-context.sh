#!/bin/bash
# session-context.sh — Re-injects orchestrator context after /clear or /compact
#
# Called by the SessionStart(clear|compact) hook generated in settings.local.json.
# Reads the swarm loop state file and outputs the orchestrator identity, goal,
# and key instructions. This ensures the model doesn't lose its role after
# auto-compaction or manual /clear.
#
# Output goes to stdout and is injected into Claude's context.

set -euo pipefail

# Require jq
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
HOOK_INPUT=$(cat)
HOOK_SESSION=$(echo "$HOOK_INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
discover_instance "$HOOK_SESSION" 2>/dev/null || exit 0

# Read state
STATE_JSON=$(cat "$STATE_FILE" 2>/dev/null)
if [[ -z "$STATE_JSON" ]] || ! echo "$STATE_JSON" | jq empty 2>/dev/null; then
  exit 0
fi

GOAL=$(echo "$STATE_JSON" | jq -r '.goal // ""')
ITERATION=$(echo "$STATE_JSON" | jq -r '.iteration // 1')
PROMISE=$(echo "$STATE_JSON" | jq -r '.completion_promise // ""')
TEAM_NAME=$(echo "$STATE_JSON" | jq -r '.team_name // ""')
COMPACT_ON_ITERATION=$(echo "$STATE_JSON" | jq -r '.compact_on_iteration // false')
TEAMMATES_ISOLATION=$(echo "$STATE_JSON" | jq -r '.teammates_isolation // "shared"')
TEAMMATES_MAX_COUNT=$(echo "$STATE_JSON" | jq -r '.teammates_max_count // 8')

MODE=$(echo "$STATE_JSON" | jq -r '.mode // "default"')
source "${_PLUGIN_ROOT}/scripts/profile-lib.sh"
load_profile "$MODE" "$_PLUGIN_ROOT"
MODE="$RESOLVED_MODE"
source "${PROFILE_DIR}/reinject.sh"

# Sanitize user-supplied values to prevent shell expansion
_sanitize() { printf '%s' "$1" | sed 's/[$`\\!]/\\&/g'; }
GOAL_SAFE=$(_sanitize "$GOAL")
PROMISE_SAFE=$(_sanitize "$PROMISE")

# Output orchestrator context — this gets injected into Claude's context
COMPACT_MODE="$COMPACT_ON_ITERATION"
NEXT_ITERATION="$ITERATION"
STUCK_MSG="" BUDGET_MSG="" STUCK_TIMEOUT_MSG=""
build_reinject_prompt
printf '%s\n' "$REINJECT_PROMPT"
