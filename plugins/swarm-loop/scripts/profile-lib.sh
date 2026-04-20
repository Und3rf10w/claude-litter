#!/bin/bash
# profile-lib.sh — shared profile library for swarm-loop scripts
# Sourced by setup-swarm-loop.sh, stop-hook.sh, session-context.sh, and profile reinject.sh files
# Do NOT add set -euo pipefail here; this file is sourced, not executed directly.

# load_profile <mode> <plugin_root>
# Sets globals: PROFILE_DIR (resolved path) and RESOLVED_MODE (resolved name).
# Falls back to "default" if the requested profile directory doesn't exist.
# Does NOT print to stdout — callers read RESOLVED_MODE directly.
load_profile() {
  local mode="$1" plugin_root="$2"
  [[ -n "$mode" ]] || { echo "swarm-loop: load_profile: mode argument is required" >&2; return 1; }
  [[ -n "$plugin_root" ]] || { echo "swarm-loop: load_profile: plugin_root argument is required" >&2; return 1; }
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

# _build_standard_reinject_prompt [worktree_note_text] [compact_prompt_type]
# Builds REINJECT_PROMPT using the standard swarm-loop pattern.
# Sets global REINJECT_PROMPT (no stdout output).
# $1: text for WORKTREE_NOTE when isolation=worktree (optional)
# $2: label used in compact mode prompt, e.g. "Swarm loop" (optional)
_build_standard_reinject_prompt() {
  local _default_worktree_note='Add isolation: "worktree" to each Agent call. Teammates must commit changes before completing. You must merge branches in VERIFY step.'
  local worktree_note_text="${1:-$_default_worktree_note}"
  local compact_prompt_type="${2:-Swarm loop}"

  # Normalize iteration variable — stop-hook uses NEXT_ITERATION, session-context uses ITERATION
  local iteration="${NEXT_ITERATION:-${ITERATION:-1}}"

  # Build WORKTREE_NOTE — injected into {{WORKTREE_NOTE}} in the template
  WORKTREE_NOTE=""
  if [[ "${TEAMMATES_ISOLATION:-shared}" == "worktree" ]]; then
    WORKTREE_NOTE="$worktree_note_text"
  fi

  # Build COMPACT_NOTE — injected into {{COMPACT_NOTE}} in the template.
  # Only applies in compact_on_iteration mode; clear_on_iteration is invisible to
  # the orchestrator (the supervisor drives /clear, not the orchestrator itself).
  COMPACT_NOTE=""
  if [[ "${COMPACT_MODE:-false}" == "true" ]]; then
    COMPACT_NOTE="
     If compact_on_iteration is enabled in state, run /compact BEFORE writing the sentinel."
  fi

  if [[ "${COMPACT_MODE:-false}" == "true" ]] || [[ "${CLEAR_MODE:-false}" == "true" ]]; then
    # Minimal-reinject mode: either compact_on_iteration (SessionStart(compact) re-injected
    # a summarized transcript) or clear_on_iteration (SessionStart(clear) re-injected
    # into an empty transcript). In both cases state.json + log.md are the authoritative
    # source of iteration progress; the minimal prompt just points the orchestrator
    # at disk-backed truth and tells it to continue.
    REINJECT_PROMPT="${compact_prompt_type} iteration ${iteration}. Prior transcript was compacted or cleared; read ${INSTANCE_DIR}/state.json and ${INSTANCE_DIR}/log.md for full context, then continue the orchestration cycle. Write ${INSTANCE_DIR}/next-iteration (empty content) when ready for next iteration.${STUCK_MSG:-}${BUDGET_MSG:-}${MIN_ITER_MSG:-}${STUCK_TIMEOUT_MSG:-}"
  else
    # Standard mode: read PROFILE.md, substitute placeholders, append runtime messages
    local tmpl
    tmpl="$(cat "${PROFILE_DIR}/PROFILE.md")"

    # substitute_profile_template reads WORKTREE_NOTE, COMPACT_NOTE, ITERATION from globals.
    local rendered
    rendered=$(ITERATION="$iteration" substitute_profile_template "$tmpl")

    REINJECT_PROMPT="${rendered}${STUCK_MSG:-}${BUDGET_MSG:-}${MIN_ITER_MSG:-}${STUCK_TIMEOUT_MSG:-}"
  fi
}
