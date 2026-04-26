#!/bin/bash
# stop-hook.sh — Stop event re-injection sentinel for execute mode.
#
# Parallel to plugins/swarm-loop/hooks/stop-hook.sh sentinel pattern
# (swarm-loop/hooks/stop-hook.sh:606-609). Fires on every Stop event.
#
# Re-injection via {"decision": "block", "reason": "...", "systemMessage": "..."} is
# STILL VALID for Stop hooks — NOT deprecated (unlike PreToolUse where decision:"block"
# is deprecated per cli_formatted_2.1.116.js:632082). Stop re-injection uses
# decision:"block" as confirmed in mechanism.hooks-engineer.md §1 Hook 8 and per
# swarm-loop/hooks/stop-hook.sh:225-226 reference.
#
# Logic:
#   1. Discover active execute instance; fail-open if none.
#   2. Only re-inject when phase is write|verify|refine AND there is unfinished work
#      (change_log entries without "verdict":"completed").
#   3. If all change_log entries have verdicts, allow stop (exit 0).
#   4. If a "done" sentinel file exists at ${INSTANCE_DIR}/execute-done.sentinel,
#      consume it and allow stop — execute mode completed.
#   5. Otherwise re-inject with current phase and change_log summary.
#
# Fail-open: phases outside write|verify|refine (e.g., setup) pass through.
# stop_hook_active guard prevents consecutive re-injection loops (same pattern as
# swarm-loop stop-hook to avoid starving teammate message delivery).

set +e

command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

discover_instance "$SESSION_ID" 2>/dev/null || exit 0

# Only active execute instances (state.execute.phase must exist)
EXEC_PHASE=$(jq -r '.execute.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
[[ -n "$EXEC_PHASE" ]] || exit 0

# Only re-inject during active execution phases
case "$EXEC_PHASE" in
  write|verify|refine) ;;
  *) exit 0 ;;
esac

# Done sentinel: execute mode declared completion
DONE_SENTINEL="${INSTANCE_DIR}/execute-done.sentinel"
if [[ -f "$DONE_SENTINEL" ]]; then
  rm -f "$DONE_SENTINEL"
  exit 0
fi

# stop_hook_active guard: if the hook already blocked on the previous turn, allow idle.
# Prevents the re-injection loop from firing twice consecutively before EXECUTOR can act.
STOP_HOOK_ACTIVE=$(printf '%s' "$INPUT" | jq -r '.stop_hook_active // false' 2>/dev/null || echo "false")
if [[ "$STOP_HOOK_ACTIVE" == "true" ]]; then
  exit 0
fi

# Check for unfinished work: change_log entries not yet APPROVED and merged
CHANGE_LOG=$(jq '.execute.change_log // []' "$STATE_FILE" 2>/dev/null || echo "[]")
UNFINISHED_COUNT=$(printf '%s' "$CHANGE_LOG" | jq '[.[] | select(.critic_verdict != "APPROVED" or .merged_at == null)] | length' 2>/dev/null || echo "0")

if [[ "$UNFINISHED_COUNT" == "0" ]]; then
  # All change_log entries have verdicts — allow stop
  exit 0
fi

PLAN_REF=$(jq -r '.execute.plan_ref // ""' "$STATE_FILE" 2>/dev/null || echo "")
PLAN_DRIFT=$(jq -r '.execute.plan_drift_detected // false' "$STATE_FILE" 2>/dev/null || echo "false")

# Build re-injection prompt
DRIFT_WARN=""
if [[ "$PLAN_DRIFT" == "true" ]]; then
  DRIFT_WARN="

WARNING: plan drift detected — the plan file at ${PLAN_REF} has been modified since execute mode started. Review the changes before continuing."
fi

UNFINISHED_SUMMARY=$(printf '%s' "$CHANGE_LOG" | jq -r '
  [.[] | select(.critic_verdict != "APPROVED" or .merged_at == null) | "  - " + (.id // .change_id // "?") + ": " + (.description // "no description")] |
  join("\n")
' 2>/dev/null || echo "  (unable to read change_log)")

REINJECT_REASON="EXECUTE MODE — CONTINUE PHASE: ${EXEC_PHASE}

Unfinished changes (${UNFINISHED_COUNT} without verdict):
${UNFINISHED_SUMMARY}
${DRIFT_WARN}
Continue executing the plan. For each unfinished change_log entry:
  1. Verify the change is correctly implemented
  2. Run covering tests and confirm they pass
  3. Update the change_log entry with verdict: \"completed\"
Once all changes have verdicts, write ${INSTANCE_DIR}/execute-done.sentinel to signal completion."

jq -n \
  --arg reason "$REINJECT_REASON" \
  --arg msg "EXECUTE MODE | phase=${EXEC_PHASE} | ${UNFINISHED_COUNT} change(s) unverified" \
  '{"decision": "block", "reason": $reason, "systemMessage": $msg}'

exit 0
