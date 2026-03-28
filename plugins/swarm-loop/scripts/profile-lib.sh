#!/bin/bash
# profile-lib.sh — shared profile library for swarm-loop scripts
# Sourced by setup-swarm-loop.sh, stop-hook.sh, and session-context.sh
# Do NOT add set -euo pipefail here; this file is sourced, not executed directly.

# load_profile <mode> <plugin_root>
# Sets globals: PROFILE_DIR (resolved path) and RESOLVED_MODE (resolved name).
# Falls back to "default" if the requested profile directory doesn't exist.
# Does NOT print to stdout — callers read RESOLVED_MODE directly.
load_profile() {
  local mode="$1" plugin_root="$2"
  local dir="${plugin_root}/profiles/${mode}"
  if [[ ! -d "$dir" ]]; then
    echo "swarm-loop: profile '${mode}' not found, falling back to 'default'" >&2
    mode="default"; dir="${plugin_root}/profiles/default"
  fi
  PROFILE_DIR="$dir"
  RESOLVED_MODE="$mode"
}

# substitute_profile_template <template_string>
# Replaces {{PLACEHOLDER}} tokens in a template string with env var values.
# Uses perl for multiline-safe substitution (sed is line-oriented and breaks
# on multiline goal/promise values). perl is already a swarm-loop dependency
# (used for promise extraction in stop-hook.sh).
# Requires these env vars to be set before calling:
#   GOAL_SAFE, PROMISE_SAFE, TEAM_NAME, ITERATION,
#   TEAMMATES_ISOLATION, TEAMMATES_MAX_COUNT,
#   WORKTREE_NOTE, COMPACT_NOTE, INSTANCE_DIR
# Outputs the substituted string to stdout.
substitute_profile_template() {
  local tmpl="$1"
  printf '%s' "$tmpl" | GOAL_SAFE="$GOAL_SAFE" PROMISE_SAFE="$PROMISE_SAFE" \
    TEAM_NAME="$TEAM_NAME" ITERATION="$ITERATION" \
    TEAMMATES_ISOLATION="$TEAMMATES_ISOLATION" TEAMMATES_MAX_COUNT="$TEAMMATES_MAX_COUNT" \
    WORKTREE_NOTE="$WORKTREE_NOTE" COMPACT_NOTE="$COMPACT_NOTE" \
    INSTANCE_DIR="$INSTANCE_DIR" \
    perl -0777 -pe '
      s/\{\{GOAL\}\}/$ENV{GOAL_SAFE}/g;
      s/\{\{PROMISE\}\}/$ENV{PROMISE_SAFE}/g;
      s/\{\{TEAM_NAME\}\}/$ENV{TEAM_NAME}/g;
      s/\{\{ITERATION\}\}/$ENV{ITERATION}/g;
      s/\{\{TEAMMATES_ISOLATION\}\}/$ENV{TEAMMATES_ISOLATION}/g;
      s/\{\{TEAMMATES_MAX_COUNT\}\}/$ENV{TEAMMATES_MAX_COUNT}/g;
      s/\{\{WORKTREE_NOTE\}\}/$ENV{WORKTREE_NOTE}/g;
      s/\{\{COMPACT_NOTE\}\}/$ENV{COMPACT_NOTE}/g;
      s/\{\{INSTANCE_DIR\}\}/$ENV{INSTANCE_DIR}/g;
    '
}
