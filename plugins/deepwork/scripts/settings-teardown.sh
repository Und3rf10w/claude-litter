#!/bin/bash
# settings-teardown.sh — Restore .claude/settings.local.json when no active
# deepwork instances remain in PROJECT_ROOT.
#
# Usage: bash settings-teardown.sh <project_root>
#
# Called by:
#   - hooks/approve-archive.sh (after archive on APPROVE)
#   - skills/deepwork-cancel/SKILL.md step 10 (after archive on cancel)
#
# No-op when other active instances still exist (they still need the hooks).
# Primary: selective jq removal of _deepwork:true-tagged entries (preserves
# hooks added by user or sibling plugins). Fallback: restore from
# .deepwork-backup if jq fails (e.g., corrupt JSON).

set +e
command -v jq >/dev/null 2>&1 || exit 0

PROJECT_ROOT="${1:-}"
[[ -n "$PROJECT_ROOT" ]] || exit 0

SETTINGS_FILE="${PROJECT_ROOT}/.claude/settings.local.json"
BACKUP_FILE="${PROJECT_ROOT}/.claude/settings.local.json.deepwork-backup"

# Skip restore if any active instance remains
for _sf in "${PROJECT_ROOT}"/.claude/deepwork/*/state.json; do
  [[ -f "$_sf" ]] && exit 0
done

[[ -f "$SETTINGS_FILE" ]] || exit 0

TMP_FILE="${SETTINGS_FILE}.teardown-tmp.$$"

# Primary: selective removal of _deepwork:true entries
if jq 'if .hooks then
         .hooks |= with_entries(.value = [.value[]? | select(._deepwork != true)] | select(.value | length > 0))
         | if (.hooks | length) == 0 then del(.hooks) else . end
       else . end' "$SETTINGS_FILE" > "$TMP_FILE" 2>/dev/null && [[ -s "$TMP_FILE" ]]; then
  mv "$TMP_FILE" "$SETTINGS_FILE" 2>/dev/null
  rm -f "$BACKUP_FILE" 2>/dev/null
else
  rm -f "$TMP_FILE" 2>/dev/null
  [[ -f "$BACKUP_FILE" ]] && mv "$BACKUP_FILE" "$SETTINGS_FILE" 2>/dev/null
fi

exit 0
