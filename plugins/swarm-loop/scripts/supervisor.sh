#!/usr/bin/env bash
# supervisor.sh — detached background process that injects /clear into claude's
# TTY at swarm-loop iteration boundaries.
#
# Lifecycle:
#   - Launched by stop-hook.sh on first iteration boundary when clear_on_iteration=true.
#   - Polls $INSTANCE_DIR/clear-requested at ${SWARM_SUPERVISOR_POLL_MS:-250}ms.
#   - On marker present: creates $INSTANCE_DIR/clear-in-flight, removes clear-requested,
#     and calls send_text_to_pane with $'\x15/clear\r'. The \x15 (Ctrl-U) wipes any
#     stale input buffer before /clear dispatches. See Proposal D v3-final.
#   - discover_instance (in instance-lib.sh) consumes clear-in-flight and migrates
#     state.json.session_id to the new SID that V1_ rotated to (cli:477629).
#   - Self-exits when the host claude process dies (kill -0 / ps probe).
#
# Guardrails:
#   - Never sends signals to the host claude (only kill -0 for liveness).
#   - Pane-lock via $HOME/.claude/swarm-loop/.pane-lock/<handle-slug>.lock prevents
#     two supervisors in the same pane.
#   - On send-text failure, writes $INSTANCE_DIR/supervisor-error.log and exits.
#     Next stop-hook detects the log and degrades cleanly.

set -u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=send-text.sh
source "$SCRIPT_DIR/send-text.sh"

INSTANCE_DIR=""
CLAUDE_PID=""
while [ $# -gt 0 ]; do
  case "$1" in
    --instance-dir) INSTANCE_DIR="$2"; shift 2 ;;
    --claude-pid)   CLAUDE_PID="$2";   shift 2 ;;
    *)              shift ;;
  esac
done

if [ -z "$INSTANCE_DIR" ] || [ -z "$CLAUDE_PID" ]; then
  echo "supervisor.sh: --instance-dir and --claude-pid are required" >&2
  exit 64
fi

if [ ! -f "$INSTANCE_DIR/pane-handle" ]; then
  echo "supervisor.sh: missing $INSTANCE_DIR/pane-handle" >&2
  exit 64
fi

HANDLE=$(<"$INSTANCE_DIR/pane-handle")

# Zombie-safe liveness probe. kill -0 alone returns success for zombies on Linux;
# we want to exit if the host claude has terminated regardless of reap state.
process_live() {
  kill -0 "$1" 2>/dev/null || return 1
  local stat
  stat=$(ps -p "$1" -o stat= 2>/dev/null | awk '{print $1}')
  case "$stat" in
    Z*) return 1 ;;
    "") return 1 ;;
    *)  return 0 ;;
  esac
}

cleanup() {
  if [ -f "$INSTANCE_DIR/pane-lock-name" ]; then
    local lock_name
    lock_name=$(<"$INSTANCE_DIR/pane-lock-name")
    rmdir "$HOME/.claude/swarm-loop/.pane-lock/$lock_name" 2>/dev/null || true
  fi
  # Defence against orphaned in-flight marker if we exit mid-clear.
  rm -f "$INSTANCE_DIR/clear-in-flight" 2>/dev/null || true
}
trap cleanup EXIT

POLL_MS=${SWARM_SUPERVISOR_POLL_MS:-250}
_sleep() { perl -e "select undef, undef, undef, $1/1000"; }

while process_live "$CLAUDE_PID"; do
  if [ -f "$INSTANCE_DIR/clear-requested" ]; then
    # Create in-flight marker BEFORE removing the request, so discover_instance
    # can distinguish a legitimate SID rotation (marker present) from a
    # concurrent resume of the old SID (marker absent).
    touch "$INSTANCE_DIR/clear-in-flight"
    rm -f "$INSTANCE_DIR/clear-requested"
    send_text_to_pane "$HANDLE" $'\x15/clear\r'
    rc=$?
    if [ $rc -ne 0 ]; then
      {
        date -u '+%Y-%m-%dT%H:%M:%SZ'
        printf 'send-text failed: handle=%s rc=%d\n' "$HANDLE" "$rc"
      } >> "$INSTANCE_DIR/supervisor-error.log"
      rm -f "$INSTANCE_DIR/clear-in-flight"
      break
    fi
  fi
  _sleep "$POLL_MS"
done

exit 0
