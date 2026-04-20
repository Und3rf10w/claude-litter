#!/bin/bash
# session-context.sh — Re-injects orchestrator identity after /clear or /compact
#
# Called by the SessionStart(clear|compact) hook generated in settings.local.json
# by setup-deepwork.sh. Reads the deepwork state file and outputs a minimal
# orchestrator-identity prompt pointing at disk-backed truth (state.json + log.md
# + PROFILE.md + references/).
#
# Output goes to stdout and is injected into Claude's context.

set -euo pipefail

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
TEAM_NAME=$(echo "$STATE_JSON" | jq -r '.team_name // ""')
MODE=$(echo "$STATE_JSON" | jq -r '.mode // "default"')
PHASE=$(echo "$STATE_JSON" | jq -r '.phase // "scope"')

# Sanitize user-controlled text (defense in depth)
_sanitize() { printf '%s' "$1" | sed 's/[$`\\!]/\\&/g'; }
GOAL=$(_sanitize "$GOAL")

# Load profile helpers and per-mode reinject builder
source "${_PLUGIN_ROOT}/scripts/profile-lib.sh"
load_profile "$MODE" "$_PLUGIN_ROOT"
MODE="$RESOLVED_MODE"
source "${PROFILE_DIR}/reinject.sh"

# build_reinject_prompt is defined in the profile's reinject.sh; it uses
# STATE_FILE, INSTANCE_DIR, GOAL, TEAM_NAME, PHASE to produce REINJECT_PROMPT.
build_reinject_prompt
printf '%s\n' "$REINJECT_PROMPT"
