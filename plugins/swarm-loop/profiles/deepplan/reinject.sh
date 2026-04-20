#!/bin/bash
# deepplan/reinject.sh — Re-inject prompt for deepplan refinement passes.

_PROFILE_LIB="$(dirname "${BASH_SOURCE[0]}")/../../scripts/profile-lib.sh"
source "$_PROFILE_LIB"

build_reinject_prompt() {
  REINJECT_PROMPT=""

  local _iter="${NEXT_ITERATION:-$ITERATION}"

  if [[ "${COMPACT_MODE:-false}" == "true" ]]; then
    # Compact mode: SessionStart(compact) hook already re-injected full context.
    # Use a minimal prompt to avoid double-injection token waste.
    REINJECT_PROMPT="Deepplan pass ${_iter}. Context was compacted and re-injected by SessionStart hook. Read ${INSTANCE_DIR}/state.json and ${INSTANCE_DIR}/log.md, then continue the deepplan cycle. Write ${INSTANCE_DIR}/next-iteration (empty content) when ready for next pass.${STUCK_MSG:-}${BUDGET_MSG:-}${MIN_ITER_MSG:-}${STUCK_TIMEOUT_MSG:-}"
    return
  fi

  local template
  template=$(cat "${PROFILE_DIR}/PROFILE.md" 2>/dev/null)
  if [[ -z "$template" ]]; then
    REINJECT_PROMPT="Deepplan pass ${_iter}. Read state and log, continue."
    return
  fi

  local rendered
  rendered=$(ITERATION="$_iter" substitute_profile_template "$template")
  REINJECT_PROMPT="${rendered}${STUCK_MSG:-}${BUDGET_MSG:-}${MIN_ITER_MSG:-}${STUCK_TIMEOUT_MSG:-}"
}
