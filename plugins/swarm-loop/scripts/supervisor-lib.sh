# shellcheck shell=bash
# supervisor-lib.sh — sourceable helpers for the TTY /clear supervisor.
#
# The supervisor is lazy-launched from stop-hook.sh on the first iteration
# boundary where clear_on_iteration=true. Skill-startup (setup-swarm-loop.sh)
# can't launch it directly because it runs via claude's Bash tool — its $PPID
# is the Bash-tool shell, not claude. Hooks run as direct children of claude,
# so $PPID == claude's PID, which is what the supervisor needs for its
# liveness probe.

# _ensure_supervisor_running <claude_pid>
#
# Idempotent. If a live supervisor is already tracked in
# $INSTANCE_DIR/supervisor.pid, return 0. Otherwise detect the terminal,
# acquire a pane-lock, and spawn a new supervisor. Returns 1 if the
# terminal is unsupported or if another instance owns the pane.
#
# Requires the caller to have INSTANCE_DIR set and _PLUGIN_ROOT available
# (both standard for swarm-loop hook scripts).
_ensure_supervisor_running() {
  local claude_pid="${1:-$PPID}"
  [ -n "$claude_pid" ] || return 1
  [ -n "${INSTANCE_DIR:-}" ] || return 1
  [ -n "${_PLUGIN_ROOT:-}" ] || return 1

  # Fast path: supervisor already running.
  if [ -f "$INSTANCE_DIR/supervisor.pid" ]; then
    local existing_pid
    existing_pid=$(<"$INSTANCE_DIR/supervisor.pid")
    if [ -n "$existing_pid" ] && kill -0 "$existing_pid" 2>/dev/null; then
      return 0
    fi
    # Stale pid file — clean up before retrying.
    rm -f "$INSTANCE_DIR/supervisor.pid"
  fi

  # Detect terminal handle. send-text.sh prints "none" if unsupported.
  # shellcheck source=send-text.sh
  source "$_PLUGIN_ROOT/scripts/send-text.sh"
  local handle
  handle=$(detect_pane_handle)
  if [ "$handle" = "none" ]; then
    return 1
  fi

  # Acquire pane-lock. Atomic mkdir: first caller wins; others bail.
  # Slug is handle-derived so two swarm-loop instances in the SAME pane
  # collide, but two instances in different panes coexist.
  local handle_slug lock_dir lock_path
  handle_slug=$(printf '%s' "$handle" | tr -c 'a-zA-Z0-9' '_' | cut -c1-48)
  lock_dir="$HOME/.claude/swarm-loop/.pane-lock"
  mkdir -p "$lock_dir" 2>/dev/null || true
  lock_path="$lock_dir/${handle_slug}.lock"
  if ! mkdir "$lock_path" 2>/dev/null; then
    # Another instance owns this pane. Check if it's a stale lock (no live
    # supervisor). If so, take it over; otherwise bail.
    local owner_pid_file="$lock_path/owner.pid"
    if [ -f "$owner_pid_file" ]; then
      local owner_pid
      owner_pid=$(<"$owner_pid_file")
      if [ -n "$owner_pid" ] && kill -0 "$owner_pid" 2>/dev/null; then
        return 1
      fi
    fi
    # Stale — try to take over by rmdir + mkdir.
    rm -f "$owner_pid_file" 2>/dev/null || true
    rmdir "$lock_path" 2>/dev/null || true
    mkdir "$lock_path" 2>/dev/null || return 1
  fi

  # Persist handle + lock identity so the supervisor can find them.
  printf '%s\n' "$handle" > "$INSTANCE_DIR/pane-handle"
  printf '%s\n' "${handle_slug}.lock" > "$INSTANCE_DIR/pane-lock-name"

  # Launch detached. nohup + </dev/null + disown keeps the supervisor
  # alive across skill-script exit; it self-exits when claude dies.
  nohup "$_PLUGIN_ROOT/scripts/supervisor.sh" \
    --instance-dir "$INSTANCE_DIR" \
    --claude-pid "$claude_pid" \
    > "$INSTANCE_DIR/supervisor.log" 2>&1 </dev/null &
  local sup_pid=$!
  disown "$sup_pid" 2>/dev/null || true
  printf '%d\n' "$sup_pid" > "$INSTANCE_DIR/supervisor.pid"
  # Record owner pid inside the lock dir so stale-takeover above works.
  printf '%d\n' "$sup_pid" > "$lock_path/owner.pid" 2>/dev/null || true

  return 0
}
