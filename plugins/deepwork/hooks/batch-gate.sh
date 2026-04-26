#!/usr/bin/env bash
# hooks/batch-gate.sh — PostToolBatch consolidation for state-drift-marker Pre leg (W3-b).
# Fires once per parallel batch after all tool calls resolve.
#
# Exit conventions (hooks.md:510, hooks.md:539):
#   0  — non-blocking; batch result forwarded as-is
#   2  — blocking error; stderr + additionalContext injected into tool results
#
# Discriminated error codes (observation-only; none currently block):
#   MALFORMED_STATE       — state.json unreadable or not valid JSON (fail-open)
#   DRIFT_SNAPSHOT_FAILED — .state-snapshot write failed (non-blocking, logged only)
#   PHASE_TRANSITION_POST — phase changed in batch; logged to log.md (non-blocking)
#   BAR_VERDICT_POST      — bar verdict changed in batch; logged to log.md (non-blocking)
#
# Per-tool snapshots: frontmatter-gate.sh writes .state-snapshot.<TOOL_USE_ID>.json before
# each state.json write (keyed by tool_use_id for parallel-batch safety). This hook reads the
# matching snapshot per tool call and deletes it after diffing. Falls back to .state-snapshot
# when TOOL_USE_ID is absent (pre-2.1.118 or non-Write paths).
#
# Requires CC >= 2.1.118 (PostToolBatch event introduced). Older CC silently ignores
# unknown events — this hook will never fire on pre-2.1.118 installs (§4 of design doc).
#
# Feature flag: state.batch_gate_enabled (default true). Set to false to disable without
# removing the hook registration. Snapshot is still written by frontmatter-gate.sh (§9.1).

set +e
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
discover_instance "$SESSION_ID" 2>/dev/null || exit 0

# Feature flag check — defaults to enabled
BATCH_GATE_ENABLED=$(jq -r '.batch_gate_enabled // true' "$STATE_FILE" 2>/dev/null || echo "true")
[[ "$BATCH_GATE_ENABLED" == "false" ]] && exit 0

# Read state.json once for the entire batch (fail-open on parse error)
STATE_CONTENT=$(cat "$STATE_FILE" 2>/dev/null) || exit 0
printf '%s' "$STATE_CONTENT" | jq -e . >/dev/null 2>&1 || exit 0

TOOL_CALLS=$(printf '%s' "$INPUT" | jq -c '.tool_calls // []' 2>/dev/null)
CALL_COUNT=$(printf '%s' "$TOOL_CALLS" | jq 'length' 2>/dev/null || echo "0")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

# ── dispatch per tool call ────────────────────────────────────────────────────

for i in $(seq 0 $((CALL_COUNT - 1))); do
  CALL=$(printf '%s' "$TOOL_CALLS" | jq -c ".[$i]" 2>/dev/null)
  TOOL_NAME=$(printf '%s' "$CALL" | jq -r '.tool_name // ""' 2>/dev/null)
  FILE_PATH=$(printf '%s' "$CALL" | jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null)
  CALL_TOOL_USE_ID=$(printf '%s' "$CALL" | jq -r '.tool_use_id // ""' 2>/dev/null)

  case "$TOOL_NAME" in
    Write|Edit)
      # Only act on state.json writes in this instance
      [[ "$FILE_PATH" == "${INSTANCE_DIR}/state.json" ]] || continue

      # Resolve per-tool snapshot (keyed by TOOL_USE_ID); fall back to shared snapshot
      _SNAPSHOT_FILE=""
      if [[ -n "$CALL_TOOL_USE_ID" ]] && [[ -f "${INSTANCE_DIR}/.state-snapshot.${CALL_TOOL_USE_ID}.json" ]]; then
        _SNAPSHOT_FILE="${INSTANCE_DIR}/.state-snapshot.${CALL_TOOL_USE_ID}.json"
      elif [[ -f "${INSTANCE_DIR}/.state-snapshot" ]]; then
        _SNAPSHOT_FILE="${INSTANCE_DIR}/.state-snapshot"
      fi
      [[ -n "$_SNAPSHOT_FILE" ]] || continue

      OLD_PHASE=$(jq -r '.phase // ""' "$_SNAPSHOT_FILE" 2>/dev/null || echo "")
      NEW_PHASE=$(jq -r '.phase // ""' "${INSTANCE_DIR}/state.json" 2>/dev/null || echo "")
      if [[ -n "$OLD_PHASE" && "$OLD_PHASE" != "$NEW_PHASE" ]]; then
        MARKER="> [phase-transition ${NOW}] ${OLD_PHASE} → ${NEW_PHASE}"
        if [[ -f "$LOG_FILE" ]] && ! tail -50 "$LOG_FILE" 2>/dev/null | grep -qF "$MARKER"; then
          printf '%s\n' "$MARKER" >> "$LOG_FILE" 2>/dev/null || true
        fi
      fi

      OLD_BAR=$(jq -r '.bar[]? | "\(.id)\t\(.verdict // "null")"' \
        "$_SNAPSHOT_FILE" 2>/dev/null || echo "")
      NEW_BAR=$(jq -r '.bar[]? | "\(.id)\t\(.verdict // "null")"' \
        "${INSTANCE_DIR}/state.json" 2>/dev/null || echo "")
      if [[ "$OLD_BAR" != "$NEW_BAR" ]]; then
        while IFS=$'\t' read -r BAR_ID BAR_VERDICT; do
          [[ -z "$BAR_ID" ]] && continue
          OLD_V=$(printf '%s' "$OLD_BAR" | awk -F'\t' -v id="$BAR_ID" '$1==id{print $2}')
          if [[ "$OLD_V" != "$BAR_VERDICT" ]]; then
            BMARKER="> [bar-verdict ${NOW}] ${BAR_ID} → ${BAR_VERDICT}"
            if [[ -f "$LOG_FILE" ]] && ! tail -50 "$LOG_FILE" 2>/dev/null | grep -qF "$BMARKER"; then
              printf '%s\n' "$BMARKER" >> "$LOG_FILE" 2>/dev/null || true
            fi
          fi
        done < <(printf '%s\n' "$NEW_BAR")
      fi

      rm -f "$_SNAPSHOT_FILE" 2>/dev/null || true
      ;;

    Bash)
      # Bash state.json writes go via state-transition.sh which also triggers frontmatter-gate
      # (when _DW_STATE_TRANSITION_WRITER=1). Resolve snapshot the same way.
      _SNAPSHOT_FILE=""
      if [[ -n "$CALL_TOOL_USE_ID" ]] && [[ -f "${INSTANCE_DIR}/.state-snapshot.${CALL_TOOL_USE_ID}.json" ]]; then
        _SNAPSHOT_FILE="${INSTANCE_DIR}/.state-snapshot.${CALL_TOOL_USE_ID}.json"
      fi
      [[ -n "$_SNAPSHOT_FILE" ]] || continue

      OLD_PHASE=$(jq -r '.phase // ""' "$_SNAPSHOT_FILE" 2>/dev/null || echo "")
      NEW_PHASE=$(jq -r '.phase // ""' "${INSTANCE_DIR}/state.json" 2>/dev/null || echo "")
      if [[ -n "$OLD_PHASE" && "$OLD_PHASE" != "$NEW_PHASE" ]]; then
        MARKER="> [phase-transition ${NOW}] ${OLD_PHASE} → ${NEW_PHASE}"
        if [[ -f "$LOG_FILE" ]] && ! tail -50 "$LOG_FILE" 2>/dev/null | grep -qF "$MARKER"; then
          printf '%s\n' "$MARKER" >> "$LOG_FILE" 2>/dev/null || true
        fi
      fi

      rm -f "$_SNAPSHOT_FILE" 2>/dev/null || true
      ;;

    # ExitPlanMode and SendMessage remain gated by their Pre hooks — no Post action needed
    *) continue ;;
  esac
done

exit 0
