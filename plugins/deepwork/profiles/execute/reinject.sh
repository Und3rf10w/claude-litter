#!/bin/bash
# execute/reinject.sh — Builds the SessionStart re-inject prompt for the execute profile.
#
# Sourced by hooks/execute/session-start.sh. Expects these env vars to be set by the caller:
#   STATE_FILE      — path to instance state.json
#   INSTANCE_DIR    — absolute path to instance directory
#   GOAL            — goal text (sanitized)
#   TEAM_NAME       — team name
#   PHASE           — current execute phase (setup|write|verify|critique|refine|land|halt|halting)
#
# Sources profile-lib.sh for render_* helpers and substitute_profile_template.
# Sets global REINJECT_PROMPT with the rendered output.

# Source profile-lib from the same plugin root
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../../.." && pwd 2>/dev/null)" || PLUGIN_ROOT=""
[[ -f "${PLUGIN_ROOT}/scripts/profile-lib.sh" ]] && source "${PLUGIN_ROOT}/scripts/profile-lib.sh"

build_reinject_prompt() {
  # For post-/clear and post-/compact re-injection, emit a minimal orchestrator-identity
  # prompt that re-anchors execute mode context from disk-backed state. Mirrors
  # default/reinject.sh pattern but surfaces execute-specific state fields.

  local execute_phase plan_ref plan_hash drift_flag bar_status change_log_summary

  execute_phase=$(jq -r '.execute.phase // "unknown"' "$STATE_FILE" 2>/dev/null)
  [[ -z "$execute_phase" ]] && execute_phase="unknown"

  plan_ref=$(jq -r '.execute.plan_ref // "(not set)"' "$STATE_FILE" 2>/dev/null)
  plan_hash=$(jq -r '.execute.plan_hash // "(not set)"' "$STATE_FILE" 2>/dev/null)
  drift_flag=$(jq -r 'if .execute.plan_drift_detected then "DETECTED — re-verdict required before proceeding" else "none" end' "$STATE_FILE" 2>/dev/null)
  [[ -z "$drift_flag" ]] && drift_flag="none"

  bar_status=$(jq -r '
    if (.bar // []) | length == 0 then
      "(not yet populated)"
    else
      (.bar[] | "- \(.id): \(.verdict // "pending")")
    end
  ' "$STATE_FILE" 2>/dev/null)
  [[ -z "$bar_status" ]] && bar_status="(not yet populated)"

  # Last 3 change_log entries for context
  change_log_summary=$(jq -r '
    (.execute.change_log // []) as $cl
    | if ($cl | length) == 0 then
        "(no changes yet)"
      else
        ($cl | last(limit(3; .[])) | "- \(.id): \(.plan_section // "null") → files: \(.files_touched // [] | join(", ")) [verdict: \(.critic_verdict // "pending")]")
      end
  ' "$STATE_FILE" 2>/dev/null)
  [[ -z "$change_log_summary" ]] && change_log_summary="(no changes yet)"

  REINJECT_PROMPT="You are the DEEPWORK ORCHESTRATOR (EXECUTE MODE) for team \"${TEAM_NAME}\".

GOAL: ${GOAL}

Prior transcript was compacted or cleared. state.json + log.md at ${INSTANCE_DIR} are authoritative.

EXECUTE PHASE: ${execute_phase}
PLAN REF: ${plan_ref}
PLAN HASH: ${plan_hash}
PLAN DRIFT: ${drift_flag}

Bar status:
${bar_status}

Recent change_log (last 3):
${change_log_summary}

Re-orient by reading:
1. ${INSTANCE_DIR}/state.json — full structured state, especially state.execute.* fields
2. ${INSTANCE_DIR}/log.md — narrative history
3. ${PLUGIN_ROOT}/profiles/execute/PROFILE.md — full execute orchestrator prompt (phase pipeline)
4. ${PLUGIN_ROOT}/references/ — tool reference, critic-stance.md, etc.
5. ${INSTANCE_DIR}/discoveries.jsonl — any pending unresolved discoveries

Then continue the execute phase pipeline from the current phase. Do not restart SETUP if plan_hash is already set. Do not re-spawn the team — it persists across clears. Do not re-create gate tasks that already exist.

If execute_phase is 'write': check TaskList for the current gate's tasks. Resume executor on the pending gate.
If execute_phase is 'verify': check env_attestations[] for completion; resume auditor if incomplete.
If execute_phase is 'critique': send CRITIC the current gate context to resume verdicting.
If plan_drift_detected is DETECTED: do not advance any gate — resolve drift via /deepwork-execute-amend first.
If execute_phase is 'halt' or 'halting': read log.md for the halt reason; do not restart execution."
}

# build_resume_prompt — recovery checklist injected when trigger=resume in execute mode.
build_resume_prompt() {
  local execute_phase plan_ref drift_flag bar_status
  execute_phase=$(jq -r '.execute.phase // "unknown"' "$STATE_FILE" 2>/dev/null)
  [[ -z "$execute_phase" ]] && execute_phase="unknown"
  plan_ref=$(jq -r '.execute.plan_ref // "(not set)"' "$STATE_FILE" 2>/dev/null)
  drift_flag=$(jq -r 'if .execute.plan_drift_detected then "DETECTED" else "none" end' "$STATE_FILE" 2>/dev/null)
  [[ -z "$drift_flag" ]] && drift_flag="none"
  bar_status=$(jq -r '
    if (.bar // []) | length == 0 then
      "(not yet populated)"
    else
      (.bar[] | "- \(.id): \(.verdict // "pending")")
    end
  ' "$STATE_FILE" 2>/dev/null)
  [[ -z "$bar_status" ]] && bar_status="(not yet populated)"

  REINJECT_PROMPT="You are the DEEPWORK ORCHESTRATOR (EXECUTE MODE) for team \"${TEAM_NAME}\".

SESSION RESUMED — run this recovery checklist before continuing:

1. Read ${INSTANCE_DIR}/state.json — verify execute.phase, plan_ref, plan_hash, and drift status.
2. Run TaskList — verify which executor tasks are open/in-progress.
   - If the executor team appears gone, run TeamCreate to spawn a new team. Do NOT
     assume the prior team persists after a resume — it may have been lost on disconnect.
   - If no team_name is set in state.json, run /deepwork --mode execute to reinitialize.
3. Read ${INSTANCE_DIR}/log.md — review the last 20 lines for context on where execution stopped.
4. Read ${INSTANCE_DIR}/discoveries.jsonl — check for any unresolved scope-delta discoveries.
5. Reconcile: if execute.phase reports an active gate but TaskList shows no gate tasks,
   re-seed the gate from the plan at ${plan_ref}.

GOAL: ${GOAL}
EXECUTE PHASE: ${execute_phase}
PLAN REF: ${plan_ref}
PLAN DRIFT: ${drift_flag}

Bar status:
${bar_status}

After completing the checklist, continue the execute phase pipeline from execute.phase=${execute_phase}.
If plan_drift_detected is DETECTED, resolve via /deepwork-execute-amend before advancing.
If the prior team is gone, create a NEW team and re-assign the current gate's tasks."
}
