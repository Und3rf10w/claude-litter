#!/bin/bash
# task-created-gate.sh — TaskCreated hook for max task cap enforcement
#
# Arguments (baked at setup time):
#   $1 = INSTANCE_DIR   — absolute path to the swarm-loop instance directory
#   $2 = MODE           — profile name (default, leanswarm, deepplan, async)
#   $3 = MAX_TASKS      — max non-completed task count (from teammates_max_count)
#
# Scope enforcement for deepplan is handled by a separate prompt hook (LLM classifier),
# not this command hook. This hook only enforces the max task cap.
#
# Exit 2 = reject task creation (stderr is injected as feedback)
# Exit 0 = allow task creation

set +e

command -v jq >/dev/null 2>&1 || exit 0

INSTANCE_DIR="${1:-}"
MODE="${2:-default}"
MAX_TASKS="${3:-8}"

[[ -n "$INSTANCE_DIR" ]] || exit 0
[[ -d "$INSTANCE_DIR" ]] || exit 0
[[ "$MAX_TASKS" =~ ^[0-9]+$ ]] || MAX_TASKS=8

INPUT=$(cat)
STATE_FILE="${INSTANCE_DIR}/state.json"

TEAM_NAME=$(echo "$INPUT" | jq -r '.team_name // ""' 2>/dev/null || echo "")

# Read state.json with torn-read retry
STATE_JSON=""
for _retry in 1 2 3; do
  STATE_JSON=$(jq '.' "$STATE_FILE" 2>/dev/null) && break
  STATE_JSON=""
  [[ $_retry -lt 3 ]] && sleep 0.05
done
[[ -z "$STATE_JSON" ]] && exit 0

# Verify this hook is for our team (empty team_name = bail, don't run against wrong instance)
INSTANCE_TEAM=$(echo "$STATE_JSON" | jq -r '.team_name // ""' 2>/dev/null || echo "")
[[ -n "$TEAM_NAME" ]] || exit 0
[[ "$INSTANCE_TEAM" == "$TEAM_NAME" ]] || exit 0

# --- Max task cap enforcement (all profiles) ---
if [[ $MAX_TASKS -gt 0 ]]; then
  SANITIZED_TEAM=$(printf '%s' "$INSTANCE_TEAM" | sed 's/[^a-zA-Z0-9_-]/-/g')
  TASK_DIR="$HOME/.claude/tasks/${SANITIZED_TEAM}"
  ACTIVE_COUNT=0
  if [[ -d "$TASK_DIR" ]]; then
    for tf in "${TASK_DIR}"/*.json; do
      [[ -f "$tf" ]] || continue
      # jq parse retry for torn reads
      TF_JSON=""
      for _retry in 1 2 3; do
        TF_JSON=$(jq '.' "$tf" 2>/dev/null) && break
        TF_JSON=""
        [[ $_retry -lt 3 ]] && sleep 0.05
      done
      [[ -z "$TF_JSON" ]] && continue
      tf_status=$(echo "$TF_JSON" | jq -r '.status // ""' 2>/dev/null || echo "")
      # Skip completed and deleted tasks — both are terminal
      [[ "$tf_status" == "completed" ]] && continue
      [[ "$tf_status" == "deleted" ]] && continue
      ACTIVE_COUNT=$((ACTIVE_COUNT + 1))
    done
  fi

  if [[ $ACTIVE_COUNT -ge $MAX_TASKS ]]; then
    printf 'Task creation rejected: already at maximum active task count (%d/%d).\n' \
      "$ACTIVE_COUNT" "$MAX_TASKS" >&2
    printf 'Complete or cancel existing tasks before creating new ones.\n' >&2
    exit 2
  fi
fi

exit 0
