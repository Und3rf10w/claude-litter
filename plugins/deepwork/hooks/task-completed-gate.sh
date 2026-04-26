#!/bin/bash
# task-completed-gate.sh — TaskCompleted hook for artifact + cross-check enforcement
#
# Fires on TaskUpdate(completed) events. Four gates:
#   1. Artifact existence — if task.metadata.artifact is set, the file must exist on disk
#      before completion is allowed. Absolute paths and traversal paths rejected
#      with a message citing references/task-conventions.md.
#   2. Cross-check count — if task.metadata.cross_check_required == true, ≥2 tasks
#      sharing the same metadata.bar_id must be completed before any of them is
#      accepted. On block, writes sidecar marker ${INSTANCE_DIR}/.gate-blocked-<task_id>
#      so teammate-idle-gate.sh can break the retry cycle (drift class l).
#   3. commit_sha (execute-mode) — if metadata.commit_sha is set, the referenced
#      commit must exist in the repo.
#   4. scope_items (M5 Change A, opt-in) — if metadata.scope_items is an array,
#      check each scope item string appears in the artifact file. Warn-only by
#      default; with metadata.scope_strict == true, blocks on miss.
#
# CONTRACT (orchestrators and teammates must follow):
#   - metadata.artifact is a SINGLE file path RELATIVE to instance dir (see
#     references/task-conventions.md). Absolute paths and paths containing `..`
#     are rejected — Gate 1 cites the reference in its error message.
#   - metadata.cross_check_required: true goes on the PRIMARY task ONLY (the one
#     producing the load-bearing null). The ≥2 independent confirmations come
#     from secondary sibling tasks that share the same bar_id with
#     cross_check_required: false. DO NOT mirror the flag on both sides —
#     mirrored flags deadlock the gate.
#   - Every TaskCreate MUST set owner (at spawn time or via TaskUpdate). The
#     cross-check gate reads owner from the task file, not the hook actor.
#   - metadata.scope_items: optional array of scope sentences. When set, Gate 4
#     checks each sentence against the artifact. Add metadata.scope_strict: true
#     to upgrade warn-only to blocking.
#
# Exit 2 = block TaskUpdate(completed) (stderr is shown to the teammate)
# Exit 0 = allow

set +e

command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

TEAM_NAME=$(printf '%s' "$INPUT" | jq -r '.team_name // ""' 2>/dev/null || echo "")
TASK_ID=$(printf '%s' "$INPUT" | jq -r '.task_id // ""' 2>/dev/null || echo "")
TEAMMATE=$(printf '%s' "$INPUT" | jq -r '.teammate_name // ""' 2>/dev/null || echo "")

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
  # Path traversal / absolute path guard (drift class i — implicit path
  # convention). Error message cites the task-conventions reference.
  if [[ "$ARTIFACT" == *".."* ]] || [[ "$ARTIFACT" == /* ]]; then
    printf 'Rejected: metadata.artifact must be RELATIVE to the instance directory.\n' >&2
    printf '  Received: %s\n' "$ARTIFACT" >&2
    printf '  Expected form: empirical_results.E1.md (relative) not /Users/.../E1.md or ../x/E1.md.\n' >&2
    printf 'See plugins/deepwork/references/task-conventions.md for the full convention.\n' >&2
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
    # M5 Change C — write sidecar marker so teammate-idle-gate.sh can detect
    # the legitimate pending-cross-check state and break the deadlock cycle
    # (drift class l). Marker is idempotent; if it already exists, we don't
    # rewrite it (preserving the original blocked_at timestamp is correct —
    # only a SUCCESSFUL gate-pass deletes the marker).
    TASK_ID_SAFE_NAME=$(printf '%s' "$TASK_ID" | sed 's/[^a-zA-Z0-9_-]/_/g')
    MARKER="${INSTANCE_DIR}/.gate-blocked-${TASK_ID_SAFE_NAME}"
    if [[ ! -f "$MARKER" ]]; then
      NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
      jq -cn --arg at "$NOW_TS" --arg reason "cross_check_pending" --arg tid "$TASK_ID" --arg bar "$BAR_ID" \
        '{blocked_at: $at, reason: $reason, task_id: $tid, bar_id: $bar}' > "$MARKER" 2>/dev/null || true
    fi

    printf 'Gate %s requires cross_check — ≥2 completions by DISTINCT owners.\n' "$BAR_ID" >&2
    printf '  Current completed: %d / %d total for this gate\n' "$COMPLETED_COUNT" "$TOTAL_COUNT" >&2
    printf '  Distinct owners:   %d\n\n' "$DISTINCT_OWNERS" >&2
    printf 'Another teammate must independently verify this claim from a different starting point.\n' >&2
    printf 'Cross-check pending — waiting for second owner. Teammate may idle safely; idle-gate will not cycle.\n' >&2
    printf 'Ask the orchestrator to spawn or reassign a second investigator for this gate.\n' >&2
    exit 2
  else
    # Gate passed — delete any stale sidecar marker from a prior block on this task.
    TASK_ID_SAFE_NAME=$(printf '%s' "$TASK_ID" | sed 's/[^a-zA-Z0-9_-]/_/g')
    rm -f "${INSTANCE_DIR}/.gate-blocked-${TASK_ID_SAFE_NAME}" 2>/dev/null || true
  fi
fi

# --- Gate 3: commit_sha artifact existence (execute-mode) ---
# If metadata.commit_sha is set, the referenced commit must exist in the repo.
# Plan-mode tasks never set commit_sha — this gate is a no-op for them.
# CC source: cli_formatted_2.1.116.js:265849 (TaskCompleted schema), :564789 (exit 2 → blockingError).
COMMIT_SHA=$(printf '%s' "$TASK_JSON" | jq -r '.metadata.commit_sha // ""' 2>/dev/null || echo "")
if [[ -n "$COMMIT_SHA" ]] && [[ "$COMMIT_SHA" != "null" ]]; then
  PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd -P)}"
  if ! git -C "$PROJECT_DIR" cat-file -e "${COMMIT_SHA}^{commit}" 2>/dev/null; then
    printf 'metadata.commit_sha "%s" does not exist in repo at %s\n' "$COMMIT_SHA" "$PROJECT_DIR" >&2
    printf 'Ensure the commit exists (not squashed, rebased, or on a different branch) before completing this task.\n' >&2
    exit 2
  fi
fi

# --- Gate 4: scope_items check (M5 Change A, opt-in) ---
# If metadata.scope_items is a non-empty array AND metadata.artifact is set
# AND the artifact exists (Gate 1 already verified), check each scope item
# string appears in the artifact. Warn-only by default; metadata.scope_strict
# upgrades to blocking.
SCOPE_ITEMS_LEN=$(echo "$TASK_JSON" | jq -r '.metadata.scope_items // [] | length' 2>/dev/null || echo "0")
if [[ "$SCOPE_ITEMS_LEN" =~ ^[0-9]+$ ]] && [[ "$SCOPE_ITEMS_LEN" -gt 0 ]] && [[ -n "$ARTIFACT" ]] && [[ -f "${INSTANCE_DIR}/${ARTIFACT}" ]]; then
  SCOPE_STRICT=$(echo "$TASK_JSON" | jq -r '.metadata.scope_strict // false' 2>/dev/null || echo "false")
  MISSING_ITEMS=()
  for i in $(seq 0 $((SCOPE_ITEMS_LEN - 1))); do
    ITEM=$(echo "$TASK_JSON" | jq -r ".metadata.scope_items[$i] // \"\"" 2>/dev/null)
    [[ -z "$ITEM" ]] && continue
    # grep -F for literal substring match. Skip if the artifact contains it.
    if ! grep -Fq "$ITEM" "${INSTANCE_DIR}/${ARTIFACT}" 2>/dev/null; then
      MISSING_ITEMS+=("$ITEM")
    fi
  done
  if [[ ${#MISSING_ITEMS[@]} -gt 0 ]]; then
    printf 'Gate 4 (scope_items): %d of %d scope item(s) not found in artifact %s:\n' \
      "${#MISSING_ITEMS[@]}" "$SCOPE_ITEMS_LEN" "$ARTIFACT" >&2
    for m in "${MISSING_ITEMS[@]}"; do
      printf '  - %s\n' "$m" >&2
    done
    if [[ "$SCOPE_STRICT" == "true" ]]; then
      printf 'metadata.scope_strict=true → blocking. Update the artifact to address each scope_item or adjust the scope list.\n' >&2
      exit 2
    else
      printf '(warn-only; set metadata.scope_strict=true to block on this gate)\n' >&2
    fi
  fi
fi

exit 0
