#!/bin/bash
# session-context.sh — Re-injects orchestrator identity on SessionStart events.
#
# Handles four trigger types from the CC runtime:
#   startup  — fresh session start
#   resume   — session resumed after disconnect; emits recovery checklist
#   clear    — user ran /clear; emits compact reinject prompt
#   compact  — auto-compaction; emits compact reinject prompt
#
# Output goes to stdout and is injected into Claude's context.

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

# Parse the SessionStart trigger type from hook stdin
SESSION_TRIGGER=$(printf '%s' "$INPUT" | jq -r '.source // ""' 2>/dev/null || echo "")

discover_instance "$SESSION_ID" 2>/dev/null || exit 0

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

# Resume trigger: emit recovery checklist instead of standard reinject
if [[ "$SESSION_TRIGGER" == "resume" ]]; then
  build_resume_prompt
else
  # build_reinject_prompt is defined in the profile's reinject.sh; it uses
  # STATE_FILE, INSTANCE_DIR, GOAL, TEAM_NAME, PHASE to produce REINJECT_PROMPT.
  build_reinject_prompt
fi

# W14: collect watchPaths for concrete proposal files so chokidar watches them directly.
_watch_paths=()
if [[ -d "${INSTANCE_DIR}/proposals" ]]; then
  while IFS= read -r -d '' _pf; do
    _watch_paths+=("$_pf")
  done < <(find "${INSTANCE_DIR}/proposals" -maxdepth 1 -name 'v*.md' -print0 2>/dev/null)
fi

# Emit a single JSON hookSpecificOutput object per cli_formatted_2.1.118.js:265720.
# additionalContext carries the reinject text; watchPaths registers proposal files.
_watch_json="[]"
if [[ ${#_watch_paths[@]} -gt 0 ]]; then
  _watch_json=$(printf '%s\n' "${_watch_paths[@]}" | jq -R . | jq -sc '.')
fi
jq -cn \
  --arg ctx "$REINJECT_PROMPT" \
  --argjson wp "$_watch_json" \
  '{hookSpecificOutput: {hookEventName: "SessionStart", additionalContext: $ctx, watchPaths: $wp}}'
