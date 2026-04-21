#!/bin/bash
# instance-lib.sh — Instance discovery for multi-instance swarm-loop support
#
# Provides discover_instance() which finds the active swarm-loop instance
# for a given session ID by globbing state files and matching session_id.
#
# Usage: source this file, then call discover_instance [session_id]
#   - If session_id argument is omitted, falls back to $CLAUDE_CODE_SESSION_ID
#   - On success (return 0), sets globals:
#       INSTANCE_ID, INSTANCE_DIR, STATE_FILE, LOG_FILE, SENTINEL, HEARTBEAT_FILE, PROJECT_ROOT
#   - On failure (return 1), no globals are set
#
# Also provides discover_instance_by_team_name() for hooks that fire on teammate
# sessions (e.g., TeammateIdle) where only team_name is available, not session_id.
# Handles worktree teammates via git-common-dir fallback.

# Requires jq — caller should verify before sourcing if needed

discover_instance() {
  local hook_session="${1:-${CLAUDE_CODE_SESSION_ID:-}}"
  [[ -n "$hook_session" ]] || return 1
  local _f _sid _id _dir _project_root

  # Resolve project root — CLAUDE_PROJECT_DIR is the canonical source (set by Claude Code
  # for all hook types). Fall back to pwd -P for non-hook contexts (e.g., test harness).
  _project_root="${CLAUDE_PROJECT_DIR:-$(pwd -P)}"

  for _f in "${_project_root}/.claude/swarm-loop"/*/state.json; do
    # Guard: glob returned literal pattern (no matches)
    [[ -f "$_f" ]] || continue

    # Symlink guard — reject symlinked state files
    [[ -L "$_f" ]] && continue

    # Symlink guard — reject symlinked instance directories (prevents path traversal
    # via .claude/swarm-loop/a1b2c3d4 -> /evil/path where state.json is a regular file)
    _dir="$(dirname "$_f")"
    [[ -L "$_dir" ]] && continue

    _sid=$(jq -r '.session_id // ""' "$_f" 2>/dev/null) || continue

    # Backfill placeholder session IDs (generated when CLAUDE_CODE_SESSION_ID
    # was unavailable at setup time — prefix "swarm-")
    # RACE NOTE: Two parallel hooks can both reach this branch simultaneously.
    # Both will write the same value (hook_session), so the race is benign —
    # the last writer wins but the result is identical either way.
    if [[ "$_sid" == swarm-* ]] && [[ -n "$hook_session" ]]; then
      jq --arg sid "$hook_session" '.session_id = $sid' "$_f" > "${_f}.tmp.$$" \
        && mv "${_f}.tmp.$$" "$_f" || { rm -f "${_f}.tmp.$$"; continue; }
      _sid="$hook_session"
    fi

    # M1 (Proposal D): accept SID rotation from /clear. V1_ at cli:477629 rotates
    # m_.sessionId before firing SessionStart("clear"), so hooks after /clear see
    # a fresh session_id. The supervisor creates clear-in-flight to signal this is
    # an intentional rotation (vs a concurrent resume of an old SID). Migrate
    # state.json atomically and consume the marker.
    #
    # The marker content is the claude-pid the supervisor was launched with.
    # Hooks run as direct children of claude, so $PPID in a hook equals that
    # same claude-pid. Gating on PID match prevents a concurrent session's hook
    # (running under a DIFFERENT claude process) from mis-migrating this
    # instance's state.json while our /clear is in flight.
    if [[ "$_sid" != "$hook_session" ]] && [[ -f "${_dir}/clear-in-flight" ]]; then
      _marker_pid=$(<"${_dir}/clear-in-flight" 2>/dev/null)
      if [[ -n "$_marker_pid" ]] && [[ "$_marker_pid" == "$PPID" ]]; then
        jq --arg sid "$hook_session" '.session_id = $sid' "$_f" > "${_f}.tmp.$$" \
          && mv "${_f}.tmp.$$" "$_f" || { rm -f "${_f}.tmp.$$"; continue; }
        _sid="$hook_session"
        rm -f "${_dir}/clear-in-flight"
      fi
    fi

    [[ "$_sid" == "$hook_session" ]] || continue

    # Extract instance ID from the directory name
    _id="$(basename "$_dir")"

    # Validate instance ID is exactly 8 hex chars (prevents path traversal)
    [[ "$_id" =~ ^[0-9a-f]{8}$ ]] || continue

    INSTANCE_ID="$_id"
    INSTANCE_DIR="$_dir"
    STATE_FILE="${_dir}/state.json"
    LOG_FILE="${_dir}/log.md"
    SENTINEL="${_dir}/next-iteration"
    HEARTBEAT_FILE="${_dir}/heartbeat.json"
    PROJECT_ROOT="$_project_root"
    return 0
  done

  return 1
}

# discover_instance_by_team_name — find instance by team_name (for teammate-session hooks)
#
# TeammateIdle fires in the teammate's process, not the orchestrator's, so the hook
# only has team_name from the hook input — not the orchestrator's session_id.
#
# Handles worktree teammates where CLAUDE_PROJECT_DIR points to the worktree, not the
# original repo root. Resolution order:
#   1. CLAUDE_PROJECT_DIR directly (non-worktree teammates)
#   2. git rev-parse --show-toplevel (teammates that cd'd)
#   3. git rev-parse --git-common-dir → dirname (worktree → main repo)
#
# On success (return 0), sets same globals as discover_instance + PROJECT_ROOT.
# On failure (return 1), no globals are set.
discover_instance_by_team_name() {
  local team_name="${1:-}"
  [[ -n "$team_name" ]] || return 1
  local _f _tname _id _dir _project_root="" _candidate

  # Step 1: Try CLAUDE_PROJECT_DIR directly
  _candidate="${CLAUDE_PROJECT_DIR:-$(pwd -P)}"
  if [[ -d "${_candidate}/.claude/swarm-loop" ]]; then
    _project_root="$_candidate"
  else
    # Step 2: Try git toplevel (covers teammates that cd'd to a subdirectory)
    _candidate=$(git -C "${CLAUDE_PROJECT_DIR:-$(pwd -P)}" rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$_candidate" ]] && [[ -d "${_candidate}/.claude/swarm-loop" ]]; then
      _project_root="$_candidate"
    else
      # Step 3: Try git common dir (worktree → main repo)
      # --path-format=absolute requires git 2.31+; fall back to plain --git-common-dir
      local _git_common
      _git_common=$(git -C "${CLAUDE_PROJECT_DIR:-$(pwd -P)}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null \
        || git -C "${CLAUDE_PROJECT_DIR:-$(pwd -P)}" rev-parse --git-common-dir 2>/dev/null \
        || echo "")
      if [[ -n "$_git_common" ]]; then
        # If relative path (older git, non-worktree returns ".git"), resolve to absolute
        if [[ "$_git_common" != /* ]]; then
          _git_common=$(cd "${CLAUDE_PROJECT_DIR:-$(pwd -P)}" && cd "$_git_common" 2>/dev/null && pwd) || _git_common=""
        fi
        if [[ -n "$_git_common" ]]; then
          _candidate="$(dirname "$_git_common")"
          # Validate candidate is an absolute path before accepting
          [[ "$_candidate" == /* ]] && [[ -d "${_candidate}/.claude/swarm-loop" ]] && _project_root="$_candidate"
        fi
      fi
    fi
  fi
  [[ -n "$_project_root" ]] || return 1

  for _f in "${_project_root}/.claude/swarm-loop"/*/state.json; do
    [[ -f "$_f" ]] || continue
    [[ -L "$_f" ]] && continue

    _dir="$(dirname "$_f")"
    [[ -L "$_dir" ]] && continue

    _id="$(basename "$_dir")"
    [[ "$_id" =~ ^[0-9a-f]{8}$ ]] || continue

    _tname=$(jq -r '.team_name // ""' "$_f" 2>/dev/null) || continue
    [[ "$_tname" == "$team_name" ]] || continue

    INSTANCE_ID="$_id"
    INSTANCE_DIR="$_dir"
    STATE_FILE="${_dir}/state.json"
    LOG_FILE="${_dir}/log.md"
    SENTINEL="${_dir}/next-iteration"
    HEARTBEAT_FILE="${_dir}/heartbeat.json"
    PROJECT_ROOT="$_project_root"
    return 0
  done

  return 1
}
