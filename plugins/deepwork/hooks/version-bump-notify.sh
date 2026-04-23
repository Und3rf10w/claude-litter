#!/bin/bash
# version-bump-notify.sh — FileChanged hook on proposal files.
#
# Async (FileChanged is fire-and-forget per hooks.md §FileChanged). Runs when
# any proposals/v*.md file changes, adds, or is unlinked. Advisory only —
# logs a drift warning to INSTANCE_DIR/drift.log when an OLDER version is
# modified after a newer sentinel.current_version has been set. Does NOT
# update the sentinel (that's done by the orchestrator's supersede-vN.md macro).
#
# Matcher semantics: FileChanged matcher is basename-only per hooks.md. A
# matcher like "v*.md" is compiled as regex (contains `.`); better to use
# a regex that catches v1.md, v1-final.md, v2.md, etc. The setup-deepwork.sh
# registration uses matcher "^v[0-9]+(-final)?\\.md$".
#
# Input schema (hooks.md §FileChanged):
#   {hook_event_name: "FileChanged", file_path: string, event: "change"|"add"|"unlink"}
#
# Never blocks (FileChanged is fire-and-forget; exit code is ignored). All
# output goes to drift.log or stderr.

set +e
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.file_path // ""' 2>/dev/null)
EVENT=$(printf '%s' "$INPUT" | jq -r '.event // ""' 2>/dev/null)

[[ -n "$FILE_PATH" ]] || exit 0

# Only handle proposals/v<N>.md or proposals/v<N>-final.md. Basename matcher
# could match any v*.md in the repo; this guard scopes to deepwork sessions.
case "$FILE_PATH" in
  */.claude/deepwork/*/proposals/v*.md) ;;
  *) exit 0 ;;
esac

INSTANCE_DIR="$(dirname "$(dirname "$FILE_PATH")")"
SENTINEL="${INSTANCE_DIR}/version-sentinel.json"
DRIFT_LOG="${INSTANCE_DIR}/drift.log"

[[ -f "$SENTINEL" ]] || exit 0   # No sentinel → no currency comparison possible.

CUR_VER=$(jq -r '.current_version // ""' "$SENTINEL" 2>/dev/null)
[[ -n "$CUR_VER" ]] || exit 0

# Extract the changed file's version.
CHANGED_BASE="$(basename "$FILE_PATH")"
CHANGED_VER=$(printf '%s' "$CHANGED_BASE" | grep -oE '^v[0-9]+(-final)?' | head -1)
[[ -n "$CHANGED_VER" ]] || exit 0

CHANGED_BASE_VER="${CHANGED_VER%-final}"
CUR_BASE_VER="${CUR_VER%-final}"

# Compare numerically: only warn when CHANGED < CUR (an older version was edited
# after a newer one was declared current).
CHANGED_N="${CHANGED_BASE_VER#v}"
CUR_N="${CUR_BASE_VER#v}"
if [[ "$CHANGED_N" =~ ^[0-9]+$ ]] && [[ "$CUR_N" =~ ^[0-9]+$ ]] && [[ "$CHANGED_N" -lt "$CUR_N" ]]; then
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '%s  WARN version-bump-notify: %s edited (event=%s) but sentinel.current_version=%s. Did you mean to edit the current version?\n' \
    "$TS" "$CHANGED_BASE" "$EVENT" "$CUR_VER" >> "$DRIFT_LOG" 2>/dev/null || true
fi

exit 0
