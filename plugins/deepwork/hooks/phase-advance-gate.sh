#!/bin/bash
# phase-advance-gate.sh — PreToolUse hook blocking premature phase transitions.
#
# Thin wrapper (W6): extracts the proposed phase from the incoming Write|Edit
# payload, then delegates all gate logic to:
#   state-transition.sh phase_advance --dry-run --to <proposed_phase>
#
# Gate logic (Checklists A, B, C, D) lives single-source in state-transition.sh.
# Exit 2 → stderr becomes blockingError injected into model context.

set +e
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
FILE_PATH=$(_canonical_path "$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")")

# Pass-through for non-target tools / non-state.json paths.
[[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]] || exit 0
[[ -n "$FILE_PATH" ]] || exit 0
[[ "$(basename "$FILE_PATH")" == "state.json" ]] || exit 0

case "$FILE_PATH" in
  */.claude/deepwork/*/state.json) ;;
  *) exit 0 ;;
esac

[[ -f "$FILE_PATH" ]] || exit 0
STATE_FILE="$FILE_PATH"

# Extract proposed phase from the incoming payload.
CURRENT_PHASE=$(jq -r '.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")

if [[ "$TOOL_NAME" == "Write" ]]; then
  PROPOSED_CONTENT=$(printf '%s' "$INPUT" | jq -r '.tool_input.content // ""' 2>/dev/null)
  PROPOSED_PHASE=$(printf '%s' "$PROPOSED_CONTENT" | jq -r '.phase // ""' 2>/dev/null || echo "")
else
  OLD_STRING=$(printf '%s' "$INPUT" | jq -r '.tool_input.old_string // ""' 2>/dev/null)
  NEW_STRING=$(printf '%s' "$INPUT" | jq -r '.tool_input.new_string // ""' 2>/dev/null)
  if [[ -n "$OLD_STRING" && -n "$NEW_STRING" ]]; then
    PROPOSED_CONTENT=$(awk -v old="$OLD_STRING" -v new="$NEW_STRING" '
      BEGIN { RS = "\0"; ORS = "" }
      { sub(old, new); print }
    ' "$STATE_FILE" 2>/dev/null)
    PROPOSED_PHASE=$(printf '%s' "$PROPOSED_CONTENT" | jq -r '.phase // ""' 2>/dev/null || echo "")
  else
    PROPOSED_PHASE="$CURRENT_PHASE"
  fi
fi

# No transition → pass-through.
[[ -n "$PROPOSED_PHASE" ]] || exit 0
[[ "$PROPOSED_PHASE" != "$CURRENT_PHASE" ]] || exit 0

# Delegate to state-transition.sh --dry-run (all gate logic is there).
STATE_FILE="$STATE_FILE" bash "${_PLUGIN_ROOT}/scripts/state-transition.sh" \
  phase_advance --dry-run --to "$PROPOSED_PHASE"
exit $?
