#!/usr/bin/env bash
# hooks/state-drift-marker.sh — Pre+PostToolUse drift capture for state.json writes.
#
# Registered THREE TIMES in setup-deepwork.sh:
#   PreToolUse:Write|Edit  — snapshots state.json before the write
#   PreToolUse:Bash        — snapshots state.json when command mentions state.json
#   PostToolUse:Write|Edit|Bash — diffs phase + bar verdicts, validates banners[],
#                                  reverts on banner corruption
#
# Dispatches on $HOOK_EVENT_NAME internally (single script file, multiple registrations).
# Snapshot lives at ${INSTANCE_DIR}/.state-snapshot (not /tmp — avoids cross-session
# collisions; auto-cleaned when instance dir is archived or removed).
# Exit 0 always — append/snapshot failures silently degrade.

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

discover_instance || exit 0   # no active instance = skip

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""')
FILE_PATH=$(_canonical_path "$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // .tool_input.path // ""')")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

case "$HOOK_EVENT_NAME" in
  PreToolUse)
    # Write|Edit: snapshot when file_path is state.json
    if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" ]]; then
      case "$FILE_PATH" in "${INSTANCE_DIR}/state.json") ;; *) exit 0 ;; esac
      cp "${INSTANCE_DIR}/state.json" "${INSTANCE_DIR}/.state-snapshot" 2>/dev/null || true
      exit 0
    fi
    # Bash: snapshot when command mentions state.json
    if [[ "$TOOL_NAME" == "Bash" ]]; then
      BASH_CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')
      if printf '%s' "$BASH_CMD" | grep -q 'state\.json'; then
        cp "${INSTANCE_DIR}/state.json" "${INSTANCE_DIR}/.state-snapshot" 2>/dev/null || true
      fi
      exit 0
    fi
    exit 0
    ;;
  PostToolUse)
    # For Write|Edit: check FILE_PATH targets state.json
    if [[ "$TOOL_NAME" == "Write" || "$TOOL_NAME" == "Edit" ]]; then
      case "$FILE_PATH" in "${INSTANCE_DIR}/state.json") ;; *) exit 0 ;; esac
    fi
    # For Bash: only proceed if a snapshot exists (pre-leg fired for this command)
    if [[ "$TOOL_NAME" == "Bash" ]]; then
      [[ -f "${INSTANCE_DIR}/.state-snapshot" ]] || exit 0
      [[ -f "${INSTANCE_DIR}/state.json" ]] || exit 0
      # Only run if command mentioned state.json
      BASH_CMD=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""')
      printf '%s' "$BASH_CMD" | grep -q 'state\.json' || exit 0
    fi

    [[ -f "${INSTANCE_DIR}/.state-snapshot" ]] || exit 0
    [[ -f "${INSTANCE_DIR}/state.json" ]] || exit 0
    [[ -f "$LOG_FILE" ]] || exit 0

    # ── banners[] schema validation (post-write revert) ─────────────────────
    # Validate banners[] in the committed state.json. On violation, revert from
    # snapshot and log a blocker line to log.md.
    BANNER_COUNT=$(jq -r '(.banners // []) | length' "${INSTANCE_DIR}/state.json" 2>/dev/null || echo "0")
    if [[ -n "$BANNER_COUNT" && "$BANNER_COUNT" != "0" ]]; then
      VALIDATION_RESULT=$(jq -r '
        .banners // [] | to_entries[] |
        .key as $i | .value as $b |
        (
          if ($b | type) != "object" then
            "[\($i)] BANNER_NOT_OBJECT"
          elif ($b | has("artifact_path") | not) then
            "[\($i)] MISSING_ARTIFACT_PATH"
          elif ($b.artifact_path == null or ($b.artifact_path | type) != "string" or ($b.artifact_path | length) == 0) then
            "[\($i)] ARTIFACT_PATH_NOT_STRING"
          elif ($b | has("banner_type") | not) then
            "[\($i)] MISSING_BANNER_TYPE"
          elif ($b.banner_type == null or ($b.banner_type | type) != "string") then
            "[\($i)] BANNER_TYPE_NOT_STRING"
          elif (["pre-reconciliation-draft","synthesis-deviation-backpointer"] | index($b.banner_type)) == null then
            "[\($i)] UNKNOWN_BANNER_TYPE:\($b.banner_type)"
          elif ($b | has("reason") | not) then
            "[\($i)] MISSING_REASON"
          elif ($b.reason == null or ($b.reason | type) != "string" or ($b.reason | length) == 0) then
            "[\($i)] REASON_NOT_STRING"
          elif ($b | has("added_at") | not) then
            "[\($i)] MISSING_ADDED_AT"
          elif ($b.added_at == null or ($b.added_at | type) != "string") then
            "[\($i)] ADDED_AT_NOT_STRING"
          elif ($b.added_at | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}") | not) then
            "[\($i)] ADDED_AT_NOT_ISO8601:\($b.added_at)"
          elif ($b | has("added_by") | not) then
            "[\($i)] MISSING_ADDED_BY"
          elif ($b.added_by == null or ($b.added_by | type) != "string" or ($b.added_by | length) == 0) then
            "[\($i)] ADDED_BY_NOT_STRING"
          else
            (
              $b | keys[] | select(. != "artifact_path" and . != "banner_type" and . != "reason" and . != "added_at" and . != "added_by")
              | "[\($i)] UNKNOWN_FIELD:\(.)"
            )
          end
        )
      ' "${INSTANCE_DIR}/state.json" 2>/dev/null || echo "")

      if [[ -n "$VALIDATION_RESULT" ]]; then
        # Revert state.json from snapshot
        cp "${INSTANCE_DIR}/.state-snapshot" "${INSTANCE_DIR}/state.json" 2>/dev/null || true
        # Append blocker line to log.md
        BLOCKER_LINE="> [banner-corruption ${NOW}] ${VALIDATION_RESULT}"
        printf '%s\n' "$BLOCKER_LINE" >> "$LOG_FILE" 2>/dev/null || true
        # Print error to stderr (non-blocking — revert is the corrective action)
        printf 'state-drift-marker: banners[] schema violation — reverted state.json\n%s\n' \
          "$VALIDATION_RESULT" >&2
        exit 0
      fi
    fi

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
