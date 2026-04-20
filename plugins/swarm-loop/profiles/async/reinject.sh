#!/bin/bash
# reinject.sh — build the orchestrator re-inject prompt for the async profile
# Sourced contract: sets global REINJECT_PROMPT (no stdout output).
# Available env vars: GOAL_SAFE, PROMISE_SAFE, TEAM_NAME, NEXT_ITERATION (or ITERATION),
#   TEAMMATES_ISOLATION, TEAMMATES_MAX_COUNT, COMPACT_MODE,
#   STUCK_MSG, BUDGET_MSG, STUCK_TIMEOUT_MSG, PROFILE_DIR

source "$(dirname "${BASH_SOURCE[0]}")/../../scripts/profile-lib.sh"

build_reinject_prompt() {
  _build_standard_reinject_prompt \
    'Use isolation: "worktree" for each Agent call. Record worktree branch names for later merge.' \
    "Async swarm"
}
