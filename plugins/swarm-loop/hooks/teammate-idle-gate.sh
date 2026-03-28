#!/bin/bash
# teammate-idle-gate.sh — TeammateIdle hook enforcing task completion discipline
#
# Fires in the teammate's session after all tool calls complete.
# If the teammate owns any in_progress tasks, re-injects instructions via exit 2.
# Uses a per-teammate retry counter (max 3) to prevent infinite loops.
# Logs retries to the instance log.md for orchestrator observability.
#
# Registered in: hooks.json (plugin-level, fires on all teammate sessions)
# Exit 2 = force keep working (stderr is injected as feedback)
# Exit 0 = allow idle

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

TEAM_NAME=$(echo "$INPUT" | jq -r '.team_name // ""' 2>/dev/null || echo "")
TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // ""' 2>/dev/null || echo "")

[[ -n "$TEAM_NAME" ]] || exit 0
[[ -n "$TEAMMATE" ]] || exit 0

if ! discover_instance_by_team_name "$TEAM_NAME"; then
  exit 0
fi

# Sanitize team name for task directory path (matches Claude Code's Tk6 sanitizer)
SANITIZED_TEAM=$(printf '%s' "$TEAM_NAME" | sed 's/[^a-zA-Z0-9_-]/-/g')
TASK_DIR="$HOME/.claude/tasks/${SANITIZED_TEAM}"

# Sanitize teammate name for counter filename (prevents path traversal)
TEAMMATE_SAFE=$(printf '%s' "$TEAMMATE" | sed 's/[^a-zA-Z0-9_-]/_/g')

# Scan task files for owned in_progress tasks
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

MAX_RETRIES=3
COUNTER_FILE="${INSTANCE_DIR}/.idle-retry.${TEAMMATE_SAFE}"

if [[ $OWNED_INPROGRESS -gt 0 ]]; then
  # Read current retry count
  RETRY_COUNT=0
  if [[ -f "$COUNTER_FILE" ]]; then
    RETRY_COUNT=$(cat "$COUNTER_FILE" 2>/dev/null | tr -cd '0-9')
    RETRY_COUNT=${RETRY_COUNT:-0}
  fi

  if [[ $RETRY_COUNT -lt $MAX_RETRIES ]]; then
    # Increment counter — if write fails, exit 0 to avoid infinite loop
    echo $((RETRY_COUNT + 1)) > "$COUNTER_FILE" 2>/dev/null
    if [[ $? -ne 0 ]]; then
      exit 0
    fi

    # Log retry for orchestrator observability
    printf '\n> ⚠️ TeammateIdle gate: %s retry %d/%d — %d in_progress task(s)\n' \
      "$TEAMMATE" "$((RETRY_COUNT + 1))" "$MAX_RETRIES" "$OWNED_INPROGRESS" \
      >> "$LOG_FILE" 2>/dev/null || true

    # Build feedback message for the teammate (sent via stderr → injected as feedback)
    printf 'You have %d in-progress task(s) that were not completed:\n%s\n' \
      "$OWNED_INPROGRESS" "$TASK_SUBJECTS" >&2
    printf 'You MUST complete your work before going idle:\n' >&2
    printf '  1. Finish the task or summarize what was done\n' >&2
    printf '  2. Call TaskUpdate(taskId, status: "completed") to mark the task done\n' >&2
    printf '  3. Call SendMessage(to: "team-lead") with your results summary\n' >&2
    printf 'Retry %d of %d.\n' "$((RETRY_COUNT + 1))" "$MAX_RETRIES" >&2
    exit 2
  else
    # Max retries reached — log warning and allow idle
    printf '\n> ⚠️ TeammateIdle gate: %s max retries (%d) reached — allowing idle. Sentinel timeout will recover.\n' \
      "$TEAMMATE" "$MAX_RETRIES" >> "$LOG_FILE" 2>/dev/null || true

    # Append hook_warnings entry to state.json for orchestrator visibility
    TEMP_STATE="${STATE_FILE}.tmp.$$"
    NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    jq --arg teammate "$TEAMMATE" --arg ts "$NOW_TS" --argjson max "$MAX_RETRIES" \
      '.hook_warnings = (.hook_warnings // []) + [{
        type: "teammate_idle_max_retries",
        teammate: $teammate,
        max_retries: $max,
        timestamp: $ts
      }]' "$STATE_FILE" > "$TEMP_STATE" 2>/dev/null
    if [[ -s "$TEMP_STATE" ]]; then
      mv "$TEMP_STATE" "$STATE_FILE"
    else
      rm -f "$TEMP_STATE"
    fi

    rm -f "$COUNTER_FILE" 2>/dev/null || true
    exit 0
  fi
else
  # No owned in_progress tasks — clean up counter and allow idle
  rm -f "$COUNTER_FILE" 2>/dev/null || true
  exit 0
fi
