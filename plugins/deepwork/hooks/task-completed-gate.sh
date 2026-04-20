#!/bin/bash
# task-completed-gate.sh — TaskCompleted hook for artifact + cross-check enforcement
#
# Fires on TaskUpdate(completed) events. Two gates:
#   1. Artifact existence — if task.metadata.artifact is set, the file must exist on disk
#      before completion is allowed.
#   2. Cross-check count — if task.metadata.cross_check_required == true, ≥2 tasks
#      sharing the same metadata.bar_id must be completed before any of them is accepted.
#
# CONTRACT (orchestrators and teammates must follow):
#   - metadata.artifact is a SINGLE file path relative to instance dir. If a
#     teammate produces multiple artifacts, create one TaskCreate per artifact
#     (all with the same bar_id). Comma-joined paths are treated as a literal
#     filename and the existence check will reject them.
#   - metadata.cross_check_required: true goes on the PRIMARY task ONLY (the one
#     producing the load-bearing null). The ≥2 independent confirmations come
#     from secondary sibling tasks that share the same bar_id with
#     cross_check_required: false. DO NOT mirror the flag on both sides —
#     mirrored flags deadlock the gate.
#   - Every TaskCreate MUST set owner (at spawn time or via TaskUpdate). The
#     cross-check gate reads owner from the task file, not the hook actor.
#
# Exit 2 = block TaskUpdate(completed) (stderr is shown to the teammate)
# Exit 0 = allow

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

TEAM_NAME=$(echo "$INPUT" | jq -r '.team_name // ""' 2>/dev/null || echo "")
TASK_ID=$(echo "$INPUT" | jq -r '.task_id // ""' 2>/dev/null || echo "")
TEAMMATE=$(echo "$INPUT" | jq -r '.teammate_name // ""' 2>/dev/null || echo "")

[[ -n "$TEAM_NAME" ]] || exit 0
[[ -n "$TASK_ID" ]] || exit 0

if ! discover_instance_by_team_name "$TEAM_NAME"; then
  exit 0
fi

SANITIZED_TEAM=$(printf '%s' "$TEAM_NAME" | sed 's/[^a-zA-Z0-9_-]/-/g')
TASK_DIR="$HOME/.claude/tasks/${SANITIZED_TEAM}"

TASK_ID_SAFE=$(printf '%s' "$TASK_ID" | sed 's/[^a-zA-Z0-9_-]/_/g')
TASK_FILE="${TASK_DIR}/${TASK_ID_SAFE}.json"

[[ -f "$TASK_FILE" ]] || exit 0

# Read task file with torn-read retry
TASK_JSON=""
for _retry in 1 2 3; do
  TASK_JSON=$(jq '.' "$TASK_FILE" 2>/dev/null) && break
  TASK_JSON=""
  [[ $_retry -lt 3 ]] && sleep 0.05
done
[[ -z "$TASK_JSON" ]] && exit 0

# --- Gate 1: Artifact existence ---
ARTIFACT=$(echo "$TASK_JSON" | jq -r '.metadata.artifact // ""' 2>/dev/null || echo "")
if [[ -n "$ARTIFACT" ]]; then
  # Path traversal guard
  if [[ "$ARTIFACT" == *".."* ]] || [[ "$ARTIFACT" == /* ]]; then
    printf 'Rejected: metadata.artifact contains path traversal: %s\n' "$ARTIFACT" >&2
    exit 2
  fi
  ARTIFACT_PATH="${INSTANCE_DIR}/${ARTIFACT}"
  if [[ ! -f "$ARTIFACT_PATH" ]]; then
    printf 'Task requires artifact file at:\n  %s\n\n' "$ARTIFACT_PATH" >&2
    printf 'Write your findings to that file BEFORE calling TaskUpdate(status: "completed").\n' >&2
    printf 'The file must exist on disk — the hook verifies this.\n' >&2
    exit 2
  fi
fi

# --- Gate 2: Cross-check count ---
CROSS_CHECK=$(echo "$TASK_JSON" | jq -r '.metadata.cross_check_required // false' 2>/dev/null || echo "false")
if [[ "$CROSS_CHECK" == "true" ]]; then
  BAR_ID=$(echo "$TASK_JSON" | jq -r '.metadata.bar_id // ""' 2>/dev/null || echo "")
  if [[ -z "$BAR_ID" ]]; then
    printf 'Task has cross_check_required: true but no metadata.bar_id — cannot identify sibling tasks. Allowing completion; orchestrator should fix the task metadata.\n' >&2
    exit 0
  fi

  # Count completed tasks sharing this bar_id (including THIS one being completed)
  COMPLETED_COUNT=0
  TOTAL_COUNT=0
  OWNERS_COMPLETED=()
  for tf in "${TASK_DIR}"/*.json; do
    [[ -f "$tf" ]] || continue

    TF_JSON=""
    for _retry in 1 2 3; do
      TF_JSON=$(jq '.' "$tf" 2>/dev/null) && break
      TF_JSON=""
      [[ $_retry -lt 3 ]] && sleep 0.05
    done
    [[ -z "$TF_JSON" ]] && continue

    tf_bar=$(echo "$TF_JSON" | jq -r '.metadata.bar_id // ""' 2>/dev/null || echo "")
    [[ "$tf_bar" == "$BAR_ID" ]] || continue

    tf_status=$(echo "$TF_JSON" | jq -r '.status // ""' 2>/dev/null || echo "")
    [[ "$tf_status" == "deleted" ]] && continue

    TOTAL_COUNT=$((TOTAL_COUNT + 1))

    # This task is about to be marked completed; count it as completed for the purpose
    # of the ≥2 check. Others already marked completed also count.
    tf_id=$(echo "$TF_JSON" | jq -r '.id // .taskId // ""' 2>/dev/null || echo "")
    tf_owner=$(echo "$TF_JSON" | jq -r '.owner // ""' 2>/dev/null || echo "")
    if [[ "$tf_status" == "completed" ]]; then
      COMPLETED_COUNT=$((COMPLETED_COUNT + 1))
      [[ -n "$tf_owner" ]] && OWNERS_COMPLETED+=("$tf_owner")
    elif [[ "$tf_id" == "$TASK_ID" ]]; then
      # This task (about to be marked completed). Use owner from task file
      # (tf_owner already parsed above), not hook actor — protects distinct-owner
      # integrity for principle 6 when orchestrator completes on behalf of a silent teammate.
      # Falls back to $TEAMMATE only when task.owner is empty.
      COMPLETED_COUNT=$((COMPLETED_COUNT + 1))
      OWNER_FOR_THIS="${tf_owner:-$TEAMMATE}"
      [[ -n "$OWNER_FOR_THIS" ]] && OWNERS_COMPLETED+=("$OWNER_FOR_THIS")
    fi
  done

  # Require ≥2 completions AND ≥2 distinct owners (avoid same agent completing both)
  DISTINCT_OWNERS=$(printf '%s\n' "${OWNERS_COMPLETED[@]:-}" | sort -u | wc -l | tr -d ' ')

  if [[ $COMPLETED_COUNT -lt 2 ]] || [[ $DISTINCT_OWNERS -lt 2 ]]; then
    printf 'Gate %s requires cross_check — ≥2 completions by DISTINCT owners.\n' "$BAR_ID" >&2
    printf '  Current completed: %d / %d total for this gate\n' "$COMPLETED_COUNT" "$TOTAL_COUNT" >&2
    printf '  Distinct owners:   %d\n\n' "$DISTINCT_OWNERS" >&2
    printf 'Another teammate must independently verify this claim from a different starting point.\n' >&2
    printf 'Ask the orchestrator to spawn or reassign a second investigator for this gate.\n' >&2
    exit 2
  fi
fi

exit 0
