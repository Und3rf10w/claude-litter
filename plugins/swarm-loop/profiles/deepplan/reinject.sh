#!/bin/bash
# deepplan/reinject.sh — Re-inject prompt for deepplan refinement passes.

_PROFILE_LIB="$(dirname "${BASH_SOURCE[0]}")/../../scripts/profile-lib.sh"
source "$_PROFILE_LIB"

build_reinject_prompt() {
  REINJECT_PROMPT=""

  # Set conditional placeholders
  if [[ "$TEAMMATES_ISOLATION" == "worktree" ]]; then
    WORKTREE_NOTE='Add isolation: "worktree" to each Agent call. Teammates must commit changes before completing. Merge branches after each phase completes.'
  else
    WORKTREE_NOTE="Teammates share the main checkout."
  fi
  if [[ "${COMPACT_MODE:-false}" == "true" ]]; then
    COMPACT_NOTE="Run /compact first, then write"
  else
    COMPACT_NOTE="Write"
  fi

  local template
  template=$(cat "${PROFILE_DIR}/PROFILE.md" 2>/dev/null)
  if [[ -z "$template" ]]; then
    REINJECT_PROMPT="Deepplan pass ${NEXT_ITERATION:-$ITERATION}. Read state and log, continue."
    return 0
  fi

  local _iter="${NEXT_ITERATION:-$ITERATION}"
  local rendered
  rendered=$(ITERATION="$_iter" substitute_profile_template "$template")
  REINJECT_PROMPT="${rendered}${STUCK_MSG:-}${BUDGET_MSG:-}${STUCK_TIMEOUT_MSG:-}"
}
