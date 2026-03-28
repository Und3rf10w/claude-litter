#!/bin/bash
# reinject.sh — build the orchestrator re-inject prompt for the async profile
# Sourced contract: sets global REINJECT_PROMPT (no stdout output).
# Available env vars: GOAL_SAFE, PROMISE_SAFE, TEAM_NAME, NEXT_ITERATION (or ITERATION),
#   TEAMMATES_ISOLATION, TEAMMATES_MAX_COUNT, COMPACT_MODE,
#   STUCK_MSG, BUDGET_MSG, STUCK_TIMEOUT_MSG, PROFILE_DIR

source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/profile-lib.sh"

build_reinject_prompt() {
  # Normalize iteration variable — stop-hook uses NEXT_ITERATION, session-context uses ITERATION
  local iteration="${NEXT_ITERATION:-${ITERATION:-1}}"

  # Build WORKTREE_NOTE — injected into {{WORKTREE_NOTE}} in the template
  WORKTREE_NOTE=""
  if [[ "${TEAMMATES_ISOLATION:-shared}" == "worktree" ]]; then
    WORKTREE_NOTE='Use isolation: "worktree" for each Agent call. Record worktree branch names for later merge.'
  else
    WORKTREE_NOTE="Agents share the main checkout. Partition file ownership carefully."
  fi

  # Build COMPACT_NOTE — injected into {{COMPACT_NOTE}} in the template
  COMPACT_NOTE=""
  if [[ "${COMPACT_MODE:-false}" == "true" ]]; then
    COMPACT_NOTE="Run /compact first, then write"
  else
    COMPACT_NOTE="Write"
  fi

  if [[ "${COMPACT_MODE:-false}" == "true" ]]; then
    # Compact mode: SessionStart(compact) hook already re-injected full context.
    # Use a minimal prompt to avoid double-injection token waste.
    REINJECT_PROMPT="Async swarm iteration ${iteration}. Context was compacted and re-injected by SessionStart hook. Read .claude/swarm-loop.local.state.json and .claude/swarm-loop.local.log.md, then continue the async orchestration cycle. Write .claude/swarm-loop.local.next-iteration (empty content) when ready for next iteration.${STUCK_MSG:-}${BUDGET_MSG:-}${STUCK_TIMEOUT_MSG:-}"
  else
    # Standard mode: read PROFILE.md, substitute placeholders, append runtime messages
    local tmpl
    tmpl="$(cat "${PROFILE_DIR}/PROFILE.md")"

    # substitute_profile_template reads WORKTREE_NOTE, COMPACT_NOTE, ITERATION from globals.
    local rendered
    rendered=$(ITERATION="$iteration" substitute_profile_template "$tmpl")

    REINJECT_PROMPT="${rendered}${STUCK_MSG:-}${BUDGET_MSG:-}${STUCK_TIMEOUT_MSG:-}"
  fi
}
