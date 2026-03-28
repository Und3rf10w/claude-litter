#!/bin/bash
# task-completed-gate.sh — TaskCompleted hook for progress tracking and artifact verification
#
# Arguments (baked at setup time):
#   $1 = INSTANCE_DIR   — absolute path to the swarm-loop instance directory
#   $2 = MODE           — profile name (default, leanswarm, deepplan, async)
#
# Fires on two occasions:
#   1. Explicit TaskUpdate(completed) — exit 2 aborts the write
#   2. Teammate turn-end with owned in_progress tasks — exit 2 forces keep working
#
# Progress tracking: appends to progress.jsonl (atomic O_APPEND, no locking needed)
# Artifact verification: reads metadata.artifact from task file (deepplan only)
#
# Exit 2 = reject task completion
# Exit 0 = allow task completion

set +e

command -v jq >/dev/null 2>&1 || exit 0

INSTANCE_DIR="${1:-}"
MODE="${2:-default}"

[[ -n "$INSTANCE_DIR" ]] || exit 0
[[ -d "$INSTANCE_DIR" ]] || exit 0

INPUT=$(cat)
STATE_FILE="${INSTANCE_DIR}/state.json"
PROGRESS_FILE="${INSTANCE_DIR}/progress.jsonl"

TASK_ID=$(echo "$INPUT" | jq -r '.task_id // ""' 2>/dev/null || echo "")
TASK_SUBJECT=$(echo "$INPUT" | jq -r '.task_subject // ""' 2>/dev/null || echo "")
TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // ""' 2>/dev/null || echo "")
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

# --- Progress tracking (all profiles) ---
# Count completed/total tasks from the task directory
SANITIZED_TEAM=$(printf '%s' "$INSTANCE_TEAM" | sed 's/[^a-zA-Z0-9_-]/-/g')
TASK_DIR="$HOME/.claude/tasks/${SANITIZED_TEAM}"
TASKS_TOTAL=0
TASKS_COMPLETED=0
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
    # Skip deleted tasks — they are terminal and should not count
    [[ "$tf_status" == "deleted" ]] && continue
    TASKS_TOTAL=$((TASKS_TOTAL + 1))
    [[ "$tf_status" == "completed" ]] && TASKS_COMPLETED=$((TASKS_COMPLETED + 1))
  done
fi

# Append to JSONL — O_APPEND makes seek+write atomic; small writes are sequentially
# stitched by the kernel. Safe for concurrent appends from parallel TaskCompleted hooks.
NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
PROGRESS_LINE=$(jq -cn \
  --arg task_id "$TASK_ID" \
  --arg task "$TASK_SUBJECT" \
  --arg teammate "$TEAMMATE" \
  --argjson tasks_completed "$TASKS_COMPLETED" \
  --argjson tasks_total "$TASKS_TOTAL" \
  --arg ts "$NOW_TS" \
  '{task_id:$task_id, task:$task, teammate:$teammate, tasks_completed:$tasks_completed, tasks_total:$tasks_total, ts:$ts}' 2>/dev/null)
if [[ -n "$PROGRESS_LINE" ]]; then
  printf '%s\n' "$PROGRESS_LINE" >> "$PROGRESS_FILE" 2>/dev/null || true
fi

# --- Artifact verification (deepplan only, metadata-based) ---
if [[ "$MODE" == "deepplan" ]] && [[ -n "$TASK_ID" ]]; then
  # Sanitize TASK_ID for file path (prevents path traversal via crafted task IDs)
  TASK_ID_SAFE=$(printf '%s' "$TASK_ID" | sed 's/[^a-zA-Z0-9_-]/_/g')
  TASK_FILE="${TASK_DIR}/${TASK_ID_SAFE}.json"
  if [[ -f "$TASK_FILE" ]]; then
    # Read metadata.artifact from the task file (with torn-read retry)
    ARTIFACT=""
    for _retry in 1 2 3; do
      ARTIFACT=$(jq -r '.metadata.artifact // ""' "$TASK_FILE" 2>/dev/null) && break
      ARTIFACT=""
      [[ $_retry -lt 3 ]] && sleep 0.05
    done

    if [[ -n "$ARTIFACT" ]]; then
      # Path traversal guard: reject artifacts containing .. or starting with /
      if [[ "$ARTIFACT" == *".."* ]] || [[ "$ARTIFACT" == /* ]]; then
        printf 'Rejected: metadata.artifact contains path traversal: %s\n' "$ARTIFACT" >&2
        exit 2
      fi
      ARTIFACT_PATH="${INSTANCE_DIR}/${ARTIFACT}"
      if [[ ! -f "$ARTIFACT_PATH" ]]; then
        printf 'Task requires artifact file at:\n  %s\n' "$ARTIFACT_PATH" >&2
        printf 'Write your findings to that file before calling TaskUpdate.\n' >&2
        exit 2
      fi
    fi
  fi
fi

exit 0
