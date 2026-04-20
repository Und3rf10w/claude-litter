#!/bin/bash
# default/reinject.sh — Builds the SessionStart re-inject prompt for the default profile.
#
# Sourced by hooks/session-context.sh. Expects these env vars to be set by the caller:
#   STATE_FILE      — path to instance state.json
#   INSTANCE_DIR    — absolute path to instance directory
#   GOAL            — goal text (sanitized)
#   TEAM_NAME       — team name
#   PHASE           — current phase (scope|explore|synthesize|critique|refine|deliver|done)
#
# Sources profile-lib.sh for render_* helpers and substitute_profile_template.
# Sets global REINJECT_PROMPT with the rendered output.

build_reinject_prompt() {
  # For post-/clear and post-/compact re-injection, we don't re-render the full
  # PROFILE.md — the transcript has limited/no room for a 5000-token meta-prompt
  # right after a clear/compact. Instead, emit a minimal orchestrator-identity
  # prompt that points at disk-backed state (state.json + log.md) and the full
  # PROFILE.md / references on disk. The orchestrator re-reads what it needs.
  #
  # This aligns with principles 4 (anchors) and 10 (disk-backed state of record):
  # state.json + log.md are authoritative; the re-inject just reminds the
  # orchestrator where to look.

  local anchors_list bar_status
  anchors_list=$(render_anchors "$STATE_FILE")
  bar_status=$(jq -r '
    if (.bar // []) | length == 0 then
      "(not yet populated)"
    else
      (.bar[] | "- \(.id): \(.verdict // "pending")")
    end
  ' "$STATE_FILE" 2>/dev/null)
  [[ -z "$bar_status" ]] && bar_status="(not yet populated)"

  REINJECT_PROMPT="You are the DEEPWORK ORCHESTRATOR for team \"${TEAM_NAME}\".

GOAL: ${GOAL}

Prior transcript was compacted or cleared. state.json + log.md at ${INSTANCE_DIR} are authoritative.

CURRENT PHASE: ${PHASE}

Bar status:
${bar_status}

Anchors:
${anchors_list}

Re-orient by reading:
1. ${INSTANCE_DIR}/state.json — full structured state (phase, role_definitions, bar, guardrails, empirical_unknowns)
2. ${INSTANCE_DIR}/log.md — narrative history
3. \${CLAUDE_PLUGIN_ROOT}/profiles/default/PROFILE.md — full orchestrator prompt if you need the phase-pipeline detail
4. \${CLAUDE_PLUGIN_ROOT}/references/ — tool reference, archetype taxonomy, role stances, etc.

Then continue the phase pipeline from the current phase. Do not restart SCOPE if state already has role_definitions. Do not re-call TeamCreate — the team persists across clears.

If the team is mid-EXPLORE, check TaskList to see which gates are still open. If mid-CRITIQUE, re-read proposals/<latest>.md and critique.*.md. Proceed from where the state says we are."
}
