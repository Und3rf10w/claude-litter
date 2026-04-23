#!/usr/bin/env bash
# hooks/state-drift-marker.sh — Pre+PostToolUse drift capture for state.json writes.
#
# Registered TWICE in setup-deepwork.sh:
#   PreToolUse:Write|Edit  — snapshots state.json before the write
#   PostToolUse:Write|Edit — diffs phase + bar verdicts, appends markers to log.md
#
# Dispatches on $HOOK_EVENT_NAME internally (single script file, two registrations).
# Snapshot lives at ${INSTANCE_DIR}/.state-snapshot (not /tmp — avoids cross-session
# collisions; auto-cleaned when instance dir is archived or removed).
# Exit 0 always — append/snapshot failures silently degrade.

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

discover_instance || exit 0   # no active instance = skip

FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

case "$HOOK_EVENT_NAME" in
  PreToolUse)
    case "$FILE_PATH" in "${INSTANCE_DIR}/state.json") ;; *) exit 0 ;; esac
    # Snapshot current state.json so PostToolUse can diff against it
    cp "${INSTANCE_DIR}/state.json" "${INSTANCE_DIR}/.state-snapshot" 2>/dev/null || true
    exit 0
    ;;
  PostToolUse)
    case "$FILE_PATH" in "${INSTANCE_DIR}/state.json") ;; *) exit 0 ;; esac
    [[ -f "${INSTANCE_DIR}/.state-snapshot" ]] || exit 0
    [[ -f "${INSTANCE_DIR}/state.json" ]] || exit 0
    [[ -f "$LOG_FILE" ]] || exit 0

    # Diff phase field
    OLD_PHASE=$(jq -r '.phase // ""' "${INSTANCE_DIR}/.state-snapshot" 2>/dev/null || echo "")
    NEW_PHASE=$(jq -r '.phase // ""' "${INSTANCE_DIR}/state.json" 2>/dev/null || echo "")
    if [[ -n "$OLD_PHASE" ]] && [[ "$OLD_PHASE" != "$NEW_PHASE" ]]; then
      MARKER="> [phase-transition ${NOW}] ${OLD_PHASE} → ${NEW_PHASE}"
      # Dedup: check last 50 lines of log.md for identical marker
      if ! tail -50 "$LOG_FILE" 2>/dev/null | grep -qF "$MARKER"; then
        printf '%s\n' "$MARKER" >> "$LOG_FILE" 2>/dev/null || true
      fi
    fi

    # Diff bar verdicts
    OLD_BAR=$(jq -r '.bar[] | "\(.id)\t\(.verdict // "null")"' "${INSTANCE_DIR}/.state-snapshot" 2>/dev/null || echo "")
    NEW_BAR=$(jq -r '.bar[] | "\(.id)\t\(.verdict // "null")"' "${INSTANCE_DIR}/state.json" 2>/dev/null || echo "")
    if [[ "$OLD_BAR" != "$NEW_BAR" ]]; then
      # Find changed entries: lines in new not in old
      while IFS=$'\t' read -r BAR_ID BAR_VERDICT; do
        [[ -z "$BAR_ID" ]] && continue
        OLD_V=$(printf '%s' "$OLD_BAR" | awk -F'\t' -v id="$BAR_ID" '$1==id{print $2}')
        if [[ "$OLD_V" != "$BAR_VERDICT" ]]; then
          BMARKER="> [bar-verdict ${NOW}] ${BAR_ID} → ${BAR_VERDICT}"
          if ! tail -50 "$LOG_FILE" 2>/dev/null | grep -qF "$BMARKER"; then
            printf '%s\n' "$BMARKER" >> "$LOG_FILE" 2>/dev/null || true
          fi
        fi
      done < <(printf '%s\n' "$NEW_BAR")
    fi

    exit 0
    ;;
  *) exit 0 ;;
esac
