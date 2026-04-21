#!/bin/bash
# approve-archive.sh — Archives a done deepwork session on APPROVE.
#
# Wired to Stop (fires every turn-end). Gates on phase=="done" so it no-ops
# on all turns except the one where the orchestrator just finalized DELIVER
# via APPROVE. Idempotent: after archive, discover_instance finds no state.json
# on subsequent Stops and exits cleanly.
#
# Why Stop (not PostToolUse:ExitPlanMode)? PostToolUse fires AFTER user approves
# but BEFORE tool_response reaches the orchestrator, so phase is still "deliver"
# at that moment — our gate would reject. Stop fires after the orchestrator
# transitions to "done" and halts, which is the correct window.

set +e
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
discover_instance "$SESSION_ID" 2>/dev/null || exit 0

PHASE=$(jq -r '.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
[[ "$PHASE" == "done" ]] || exit 0

mv "$STATE_FILE" "${INSTANCE_DIR}/state.archived.json" 2>/dev/null || exit 0

rm -f "${INSTANCE_DIR}/heartbeat.json" 2>/dev/null || true
rm -f "${INSTANCE_DIR}"/.idle-retry.* 2>/dev/null || true

printf '\n> ✅ approve-archive: session %s archived (phase=done)\n' "$INSTANCE_ID" \
  >> "$LOG_FILE" 2>/dev/null || true

# Settings teardown — no-ops if other active instances remain
bash "${_PLUGIN_ROOT}/scripts/settings-teardown.sh" "$PROJECT_ROOT" 2>/dev/null || true

exit 0
