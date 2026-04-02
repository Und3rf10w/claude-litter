#!/bin/bash
# subagent-stop.sh — SubagentStop hook for teammate crash recovery observability
#
# Fires when a teammate (subagent) stops for any reason.
# Scans for in_progress tasks owned by the stopped teammate and logs warnings
# for orchestrator visibility. Also cleans up the idle-retry counter file.
#
# Registered in: settings.local.json via setup-swarm-loop.sh (not in hooks.json)
# Exit 0 always — this is observability only, never blocking.

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

# Extract agent_type — if empty or not a teammate pattern, skip
AGENT_TYPE=$(echo "$INPUT" | jq -r '.agent_type // ""' 2>/dev/null || echo "")
[[ -n "$AGENT_TYPE" ]] || exit 0

# Extract agent_id and derive teammate name (part before '@')
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null || echo "")
[[ -n "$AGENT_ID" ]] || exit 0

# Teammate name is the part before '@' in agent_id (e.g., "researcher@team-name" → "researcher")
TEAMMATE="${AGENT_ID%%@*}"
[[ -n "$TEAMMATE" ]] || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

# Discover instance using session_id from the hook input
HOOK_SESSION=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")

# Try session-based discovery first, then fall back to searching all instances
if [[ -n "$HOOK_SESSION" ]]; then
  discover_instance "$HOOK_SESSION" 2>/dev/null || true
fi

# If session-based discovery failed, try to find via agent's team name embedded in agent_id
if [[ -z "${INSTANCE_DIR:-}" ]]; then
  # agent_id format: "teammate-name@team-name"
  TEAM_FROM_AGENT="${AGENT_ID#*@}"
  if [[ -n "$TEAM_FROM_AGENT" ]] && [[ "$TEAM_FROM_AGENT" != "$AGENT_ID" ]]; then
    discover_instance_by_team_name "$TEAM_FROM_AGENT" 2>/dev/null || true
  fi
fi

# If still no instance, nothing to log to — exit cleanly
[[ -n "${INSTANCE_DIR:-}" ]] || exit 0

trap 'rm -f "${STATE_FILE}.tmp.$$"' EXIT

# Read team_name from state.json
TEAM_NAME=$(jq -r '.team_name // ""' "$STATE_FILE" 2>/dev/null || echo "")
[[ -n "$TEAM_NAME" ]] || exit 0

# Sanitize team name for task directory path (matches Claude Code's sanitizer)
SANITIZED_TEAM=$(printf '%s' "$TEAM_NAME" | sed 's/[^a-zA-Z0-9_-]/-/g')
TASK_DIR="$HOME/.claude/tasks/${SANITIZED_TEAM}"

# Sanitize teammate name for filesystem safety
TEAMMATE_SAFE=$(printf '%s' "$TEAMMATE" | sed 's/[^a-zA-Z0-9_-]/_/g')

# Scan task files for in_progress tasks owned by this teammate
OWNED_INPROGRESS=0
TASK_SUBJECTS=""
if [[ -d "$TASK_DIR" ]]; then
  for task_file in "${TASK_DIR}"/*.json; do
    [[ -f "$task_file" ]] || continue

    # jq parse retry for torn reads (fs.writeFile is not atomic)
    TASK_JSON=""
    for _retry in 1 2 3; do
      TASK_JSON=$(jq '.' "$task_file" 2>/dev/null) && break
      TASK_JSON=""
      [[ $_retry -lt 3 ]] && sleep 0.05
    done
    [[ -z "$TASK_JSON" ]] && continue

    task_owner=$(echo "$TASK_JSON" | jq -r '.owner // ""' 2>/dev/null || echo "")
    task_status=$(echo "$TASK_JSON" | jq -r '.status // ""' 2>/dev/null || echo "")
    task_subject=$(echo "$TASK_JSON" | jq -r '.subject // ""' 2>/dev/null || echo "")

    [[ "$task_status" == "deleted" ]] && continue
    if [[ "$task_owner" == "$TEAMMATE" ]] && [[ "$task_status" == "in_progress" ]]; then
      OWNED_INPROGRESS=$((OWNED_INPROGRESS + 1))
      TASK_SUBJECTS="${TASK_SUBJECTS}  - ${task_subject}"$'\n'
    fi
  done
fi

if [[ $OWNED_INPROGRESS -gt 0 ]]; then
  # Capture and truncate last_assistant_message to 500 chars
  LAST_MSG=$(echo "$INPUT" | jq -r '.last_assistant_message // ""' 2>/dev/null || echo "")
  LAST_MSG_TRUNCATED="${LAST_MSG:0:500}"

  # Log warning to instance log.md
  printf '\n> ⚠️ SubagentStop: %s stopped with %d in_progress task(s): %s\n' \
    "$TEAMMATE" "$OWNED_INPROGRESS" "$TASK_SUBJECTS" \
    >> "$LOG_FILE" 2>/dev/null || true

  # Append hook_warnings entry to state.json for orchestrator visibility
  TEMP_STATE="${STATE_FILE}.tmp.$$"
  NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  jq --arg teammate "$TEAMMATE" --arg ts "$NOW_TS" \
    --argjson count "$OWNED_INPROGRESS" \
    --arg subjects "$TASK_SUBJECTS" \
    --arg last_msg "$LAST_MSG_TRUNCATED" \
    '.hook_warnings = (.hook_warnings // []) + [{
      type: "subagent_stop_inprogress",
      teammate: $teammate,
      inprogress_count: $count,
      task_subjects: $subjects,
      last_assistant_message: $last_msg,
      timestamp: $ts
    }]' "$STATE_FILE" > "$TEMP_STATE" 2>/dev/null
  if [[ -s "$TEMP_STATE" ]]; then
    mv "$TEMP_STATE" "$STATE_FILE"
  else
    rm -f "$TEMP_STATE"
  fi
fi

# Clean up idle-retry counter file regardless of task state
rm -f "${INSTANCE_DIR}/.idle-retry.${TEAMMATE_SAFE}" 2>/dev/null || true

exit 0
