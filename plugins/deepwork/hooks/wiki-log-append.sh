#!/bin/bash
# wiki-log-append.sh — Append a dated log entry to .claude/deepwork/DEEPWORK_WIKI.md
# whenever a new state.archived.json appears.
#
# Wired to FileChanged watching .claude/deepwork/. Filters on event=="add" and
# file_path ending in state.archived.json. Idempotent via grep -Fq on "(id=<id>"
# dedup key. Bootstraps DEEPWORK_WIKI.md with a skeleton if missing.
#
# Log line format:
#   ## [YYYY-MM-DD] archived | <goal-trunc-80> (id=<8-hex>, approved)
#   ## [YYYY-MM-DD] archived | <goal-trunc-80> (id=<8-hex>, cancelled (phase=<X>))

set +e
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
EVENT=$(printf '%s' "$INPUT" | jq -r '.event // ""' 2>/dev/null || echo "")
FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.file_path // ""' 2>/dev/null || echo "")

[[ "$EVENT" == "add" ]] || exit 0
[[ "$FILE_PATH" == *state.archived.json ]] || exit 0
[[ -f "$FILE_PATH" ]] || exit 0

PHASE=$(jq -r '.phase // ""' "$FILE_PATH" 2>/dev/null || echo "")
GOAL=$(jq -r '.goal // ""' "$FILE_PATH" 2>/dev/null || echo "")

INSTANCE_DIR="$(dirname "$FILE_PATH")"
INSTANCE_ID="$(basename "$INSTANCE_DIR")"

# Validate 8-hex instance id (path-traversal guard)
[[ "$INSTANCE_ID" =~ ^[0-9a-f]{8}$ ]] || exit 0

PROJECT_ROOT="$(dirname "$(dirname "$(dirname "$INSTANCE_DIR")")")"
WIKI_DIR="${PROJECT_ROOT}/.claude/deepwork"
WIKI_FILE="${WIKI_DIR}/DEEPWORK_WIKI.md"

# Dedup: skip if this session id is already logged
if [[ -f "$WIKI_FILE" ]] && grep -Fq "(id=${INSTANCE_ID}" "$WIKI_FILE" 2>/dev/null; then
  exit 0
fi

TODAY=$(date -u +%Y-%m-%d)
GOAL_TRUNC=$(printf '%s' "$GOAL" | head -c 80)

if [[ "$PHASE" == "done" ]]; then
  OUTCOME="approved"
else
  OUTCOME="cancelled (phase=${PHASE:-unknown})"
fi

LOG_LINE="## [${TODAY}] archived | ${GOAL_TRUNC} (id=${INSTANCE_ID}, ${OUTCOME})"

# Bootstrap skeleton if missing
if [[ ! -f "$WIKI_FILE" ]]; then
  mkdir -p "$WIKI_DIR" 2>/dev/null || true
  cat > "$WIKI_FILE" <<'EOF' 2>/dev/null || exit 0
# Deepwork Wiki

<!-- AUTO-MANAGED. Run /deepwork-wiki to regenerate synthesis sections. -->

## Overview

_No synthesis yet. Run `/deepwork-wiki` to populate._

## Session Index

_No sessions yet._

## Cross-refs

_No cross-refs yet._

# Log

_Append-only. Managed by wiki-log-append.sh hook. Do not edit manually._

EOF
fi

# Ensure # Log heading exists (defensive for hand-edited files)
if ! grep -qF "# Log" "$WIKI_FILE" 2>/dev/null; then
  printf '\n# Log\n\n' >> "$WIKI_FILE" 2>/dev/null || true
fi

printf '%s\n' "$LOG_LINE" >> "$WIKI_FILE" 2>/dev/null || true

# Debug log to the instance's log.md (matches incident-detector.sh:110 pattern)
printf '\n> ✅ wiki-log: appended entry for %s (%s)\n' "$INSTANCE_ID" "$OUTCOME" \
  >> "${INSTANCE_DIR}/log.md" 2>/dev/null || true

exit 0
