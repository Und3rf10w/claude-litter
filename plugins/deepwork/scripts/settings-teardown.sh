#!/bin/bash
# settings-teardown.sh — Restore .claude/settings.local.json when no active
# deepwork instances remain in PROJECT_ROOT.
#
# Usage: bash settings-teardown.sh <project_root> [instance_id]
#
# Called by:
#   - hooks/approve-archive.sh (after archive on APPROVE)
#   - skills/deepwork-teardown/SKILL.md step 10 (after archive on teardown)
#
# No-op when other active instances still exist (they still need the hooks).
# When instance_id is supplied: removes only hooks tagged with that instance
# (_deepwork_instance == instance_id), leaving sibling-instance hooks intact.
# When instance_id is absent: removes all _deepwork:true-tagged entries (legacy
# behaviour, safe when only one instance runs at a time).
# Fallback: restore from .deepwork-backup if jq fails (e.g., corrupt JSON).

set +e
command -v jq >/dev/null 2>&1 || exit 0

PROJECT_ROOT="${1:-}"
INSTANCE_ID="${2:-}"
[[ -n "$PROJECT_ROOT" ]] || exit 0

SETTINGS_FILE="${PROJECT_ROOT}/.claude/settings.local.json"
BACKUP_FILE="${PROJECT_ROOT}/.claude/settings.local.json.deepwork-backup"

# Skip restore if any active instance remains
for _sf in "${PROJECT_ROOT}"/.claude/deepwork/*/state.json; do
  [[ -f "$_sf" ]] && exit 0
done

[[ -f "$SETTINGS_FILE" ]] || exit 0

TMP_FILE="${SETTINGS_FILE}.teardown-tmp.$$"

if [[ -n "$INSTANCE_ID" ]]; then
  # Per-instance removal: strip only hooks tagged for this instance
  _FILTER='if .hooks then
    .hooks |= with_entries(.value = [.value[]? | select(._deepwork_instance != $iid)] | select(.value | length > 0))
    | if (.hooks | length) == 0 then del(.hooks) else . end
  else . end'
  JQ_RESULT=$(jq --arg iid "$INSTANCE_ID" "$_FILTER" "$SETTINGS_FILE" 2>/dev/null)
else
  # Legacy: remove all _deepwork:true entries when no instance_id given
  _FILTER='if .hooks then
    .hooks |= with_entries(.value = [.value[]? | select(._deepwork != true)] | select(.value | length > 0))
    | if (.hooks | length) == 0 then del(.hooks) else . end
  else . end'
  JQ_RESULT=$(jq "$_FILTER" "$SETTINGS_FILE" 2>/dev/null)
fi

if [[ -n "$JQ_RESULT" ]]; then
  printf '%s\n' "$JQ_RESULT" > "$TMP_FILE" 2>/dev/null
  if [[ -s "$TMP_FILE" ]]; then
    mv "$TMP_FILE" "$SETTINGS_FILE" 2>/dev/null
    rm -f "$BACKUP_FILE" 2>/dev/null
  else
    rm -f "$TMP_FILE" 2>/dev/null
    [[ -f "$BACKUP_FILE" ]] && mv "$BACKUP_FILE" "$SETTINGS_FILE" 2>/dev/null
  fi
else
  [[ -f "$BACKUP_FILE" ]] && mv "$BACKUP_FILE" "$SETTINGS_FILE" 2>/dev/null
fi

exit 0
