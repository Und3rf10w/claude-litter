#!/bin/bash
# teammate-idle-gate.sh — TeammateIdle hook enforcing task completion discipline
#
# Fires in the teammate's session after all tool calls complete.
# If the teammate owns any in_progress tasks, re-injects instructions via exit 2.
# Uses a per-teammate retry counter (max 3) to prevent infinite loops.
# Logs retries to the instance log.md for orchestrator observability.
#
# On max-retries reached: emits a hook_warnings entry to state.json AND appends
# an incident-derived guardrail to state.json.guardrails[] (principle 5).
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

SANITIZED_TEAM=$(printf '%s' "$TEAM_NAME" | sed 's/[^a-zA-Z0-9_-]/-/g')
TASK_DIR="$HOME/.claude/tasks/${SANITIZED_TEAM}"
TEAMMATE_SAFE=$(printf '%s' "$TEAMMATE" | sed 's/[^a-zA-Z0-9_-]/_/g')

MAX_RETRIES=3
COUNTER_FILE="${INSTANCE_DIR}/.idle-retry.${TEAMMATE_SAFE}"

OWNED_INPROGRESS=0
TASK_SUBJECTS=""
OWNED_TASK_IDS=()
if [[ -d "$TASK_DIR" ]]; then
  for task_file in "${TASK_DIR}"/*.json; do
    [[ -f "$task_file" ]] || continue

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
    task_id=$(echo "$TASK_JSON" | jq -r '.id // .taskId // ""' 2>/dev/null || echo "")

    [[ "$task_status" == "deleted" ]] && continue
    if [[ "$task_owner" == "$TEAMMATE" ]] && [[ "$task_status" == "in_progress" ]]; then
      OWNED_INPROGRESS=$((OWNED_INPROGRESS + 1))
      TASK_SUBJECTS="${TASK_SUBJECTS}  - ${task_subject}"$'\n'
      [[ -n "$task_id" ]] && OWNED_TASK_IDS+=("$task_id")
    fi
  done
fi

# M5 Change C — sidecar marker AGE<300 exemption (drift class l prevention).
# If ANY owned in-progress task has a fresh gate-block marker (written by
# task-completed-gate.sh when cross_check is pending), allow idle without
# retry loop. The cross-check sibling's completion will delete the marker
# and the next idle triggers normal retry enforcement again.
#
# Rationale: the task-completed-gate already blocked completion (exit 2); the
# teammate can't make progress until the cross-check sibling lands. Forcing
# retry would just re-invoke the same blocked gate. After 5 minutes (stale
# marker) we fall through to normal retry — either the cross-check is never
# coming (real stuckness) or the marker was orphaned by a crashed gate.
if [[ $OWNED_INPROGRESS -gt 0 ]] && [[ ${#OWNED_TASK_IDS[@]} -gt 0 ]]; then
  NOW_EPOCH=$(date +%s)
  for tid in "${OWNED_TASK_IDS[@]}"; do
    TID_SAFE=$(printf '%s' "$tid" | sed 's/[^a-zA-Z0-9_-]/_/g')
    MARKER="${INSTANCE_DIR}/.gate-blocked-${TID_SAFE}"
    [[ -f "$MARKER" ]] || continue
    # Portable mtime: try GNU stat first, then BSD stat.
    MARKER_MTIME=$(stat -c %Y "$MARKER" 2>/dev/null || stat -f %m "$MARKER" 2>/dev/null || echo "")
    [[ "$MARKER_MTIME" =~ ^[0-9]+$ ]] || continue
    AGE=$((NOW_EPOCH - MARKER_MTIME))
    if [[ $AGE -lt 300 ]]; then
      printf '\n> ✓ teammate-idle-gate: %s has gate-blocked task %s (age=%ds < 300s); idle allowed without retry (drift class l fix).\n' \
        "$TEAMMATE" "$tid" "$AGE" >> "$LOG_FILE" 2>/dev/null || true
      # Reset retry counter so a later unrelated idle starts fresh.
      rm -f "$COUNTER_FILE" 2>/dev/null || true
      exit 0
    fi
  done
fi

if [[ $OWNED_INPROGRESS -gt 0 ]]; then
  RETRY_COUNT=0
  if [[ -f "$COUNTER_FILE" ]]; then
    RETRY_COUNT=$(cat "$COUNTER_FILE" 2>/dev/null | tr -cd '0-9')
    RETRY_COUNT=${RETRY_COUNT:-0}
  fi

  if [[ $RETRY_COUNT -lt $MAX_RETRIES ]]; then
    echo $((RETRY_COUNT + 1)) > "$COUNTER_FILE" 2>/dev/null
    if [[ $? -ne 0 ]]; then
      exit 0
    fi

    printf '\n> ⚠️ TeammateIdle gate: %s retry %d/%d — %d in_progress task(s)\n' \
      "$TEAMMATE" "$((RETRY_COUNT + 1))" "$MAX_RETRIES" "$OWNED_INPROGRESS" \
      >> "$LOG_FILE" 2>/dev/null || true

    printf 'You have %d in-progress task(s) that were not completed:\n%s\n' \
      "$OWNED_INPROGRESS" "$TASK_SUBJECTS" >&2
    printf 'You MUST complete your work before going idle:\n' >&2
    printf '  1. Finish the task or summarize what was done\n' >&2
    printf '  2. Call TaskUpdate(taskId, status: "completed") to mark the task done\n' >&2
    printf '  3. Call SendMessage(to: "team-lead") with your results summary\n' >&2
    printf 'Retry %d of %d.\n' "$((RETRY_COUNT + 1))" "$MAX_RETRIES" >&2
    exit 2
  else
    # Max retries reached. Per principle 5 (institutional memory), this is a
    # real incident worth capturing as a guardrail. Append to incidents.jsonl
    # (atomic O_APPEND, deduped by incident_ref). render_guardrails()
    # consolidates into {{HARD_GUARDRAILS}} at render time.
    printf '\n> ⚠️ TeammateIdle gate: %s max retries (%d) reached — releasing teammate and capturing incident.\n' \
      "$TEAMMATE" "$MAX_RETRIES" >> "$LOG_FILE" 2>/dev/null || true

    NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    INCIDENT_REF="teammate_idle_max_retries/${TEAMMATE}"
    INCIDENTS_FILE="${INSTANCE_DIR}/incidents.jsonl"

    # Dedup on incident_ref
    if ! { [[ -f "$INCIDENTS_FILE" ]] && grep -Fq "\"incident_ref\":\"${INCIDENT_REF}\"" "$INCIDENTS_FILE" 2>/dev/null; }; then
      INCIDENT_JSON=$(jq -cn --arg teammate "$TEAMMATE" --arg ts "$NOW_TS" --arg ref "$INCIDENT_REF" \
        '{rule: ("teammate \($teammate) exhausted TeammateIdle retries; consider spawning a replacement or splitting the task on respawn"), source: "incident", timestamp: $ts, incident_ref: $ref}')
      [[ -n "$INCIDENT_JSON" ]] && printf '%s\n' "$INCIDENT_JSON" >> "$INCIDENTS_FILE" 2>/dev/null || true
    fi

    rm -f "$COUNTER_FILE" 2>/dev/null || true
    exit 0
  fi
else
  rm -f "$COUNTER_FILE" 2>/dev/null || true
  exit 0
fi
