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

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

discover_instance "$SESSION_ID" 2>/dev/null || exit 0

PHASE=$(jq -r '.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
EXEC_PHASE=$(jq -r '.execute.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
if [[ "$PHASE" != "done" ]]; then
  # Also archive execute sessions that halted with a valid halt_reason object
  [[ "$EXEC_PHASE" == "halt" ]] || exit 0
  _HALT_VALID=$(jq -r 'if (.halt_reason | type == "object") and ((.halt_reason.summary // "") | length > 0) then "yes" else "no" end' "$STATE_FILE" 2>/dev/null || echo "no")
  [[ "$_HALT_VALID" == "yes" ]] || exit 0
fi

mv "$STATE_FILE" "${INSTANCE_DIR}/state.archived.json" 2>/dev/null || exit 0
mv "${INSTANCE_DIR}/events.jsonl" "${INSTANCE_DIR}/events.archived.jsonl" 2>/dev/null || true

rm -f "${INSTANCE_DIR}/heartbeat.json" 2>/dev/null || true
rm -f "${INSTANCE_DIR}"/.idle-retry.* 2>/dev/null || true

printf '\n> ✅ approve-archive: session %s archived (phase=done)\n' "$INSTANCE_ID" \
  >> "$LOG_FILE" 2>/dev/null || true

# W14: synchronous wiki-log-append trigger. The FileChanged(.claude/deepwork) watcher
# may miss the state.archived.json addition on some installations; calling directly
# here guarantees the wiki entry regardless of chokidar directory-watcher availability.
# Construct a synthetic FileChanged input for the archived state file.
_archived_state="${INSTANCE_DIR}/state.archived.json"
if [[ -f "$_archived_state" ]]; then
  jq -cn --arg sid "${SESSION_ID:-}" --arg fp "$_archived_state" \
    '{hook_event_name:"FileChanged",session_id:$sid,file_path:$fp,event:"add"}' \
    | bash "${_PLUGIN_ROOT}/hooks/wiki-log-append.sh" 2>/dev/null || true
fi

# Settings teardown — pass INSTANCE_ID so only this instance's hooks are removed
bash "${_PLUGIN_ROOT}/scripts/settings-teardown.sh" "$PROJECT_ROOT" "$INSTANCE_ID" 2>/dev/null || true

exit 0
