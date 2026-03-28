#!/bin/bash
# deepplan/completion.sh — Phase-based completion detection for the deepplan profile.
# Sourced by stop-hook.sh before the completion check.
#
# Inputs (env vars set by stop-hook.sh):
#   LAST_OUTPUT          — last assistant message text
#   COMPLETION_PROMISE   — normalized promise string (whitespace-collapsed)
#   STATE_FILE           — path to instance state.json
#   LOG_FILE             — path to instance log.md
#   STATE_JSON           — cached contents of STATE_FILE
#   ITERATION            — current iteration number (numeric)
#
# Outputs (set by this function):
#   COMPLETION_DETECTED      — "true" if promise matched (deepplan does not run a verify script)
#                              "false" otherwise
#   COMPLETION_BLOCK_REASON  — non-empty plain string (human-readable reason) if a phase
#                              requires re-injection. Do NOT set to a JSON object.
#
# Notes:
#   Unlike the default/async profiles, deepplan does NOT invoke verify-completion.sh.
#   Completion is declared when the orchestrator outputs the promise tag after ExitPlanMode
#   returns approved. Phase-specific logic handles the rejected/delivering/refining states.

check_completion() {
  COMPLETION_DETECTED="false"
  COMPLETION_BLOCK_REASON=""

  if [[ -z "$COMPLETION_PROMISE" ]] || [[ "$COMPLETION_PROMISE" == "null" ]]; then
    return 0
  fi

  # Check for promise tag (same as default)
  local promise_text
  promise_text=$(printf '%s' "$LAST_OUTPUT" \
    | perl -0777 -ne 'if (/<promise>(.*?)<\/promise>/s) { my $t = $1; $t =~ s/^\s+|\s+$//g; $t =~ s/\s+/ /g; print $t; }' 2>/dev/null || echo "")

  if [[ -n "$promise_text" ]] && [[ "$promise_text" == "$COMPLETION_PROMISE" ]]; then
    COMPLETION_DETECTED="true"
    return 0
  fi

  # Phase-specific logic
  local phase
  phase=$(printf '%s' "$STATE_JSON" | jq -r '.phase // "initial"')

  case "$phase" in
    delivering)
      # ExitPlanMode is blocking — allow idle
      # Dead session check handled by shared stop-hook sentinel timeout
      ;;
    rejected)
      # Only signal re-inject if sentinel was NOT written (missed sentinel case).
      # If sentinel exists, the shared stop-hook sentinel logic will handle it
      # with the full PROFILE.md re-inject prompt — much richer than a one-liner.
      if [[ ! -f "$SENTINEL" ]]; then
        COMPLETION_BLOCK_REASON="User rejected the plan. Re-read state for feedback and revise."
      fi
      ;;
    refining)
      # Orchestrator is actively working on phase 5 revision — allow idle
      ;;
    complete|error)
      # Terminal states — do nothing, let shared logic handle
      ;;
  esac
  return 0
}
