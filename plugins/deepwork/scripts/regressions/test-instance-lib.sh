#!/usr/bin/env bash
# test-instance-lib.sh — regression tests for plugins/deepwork/scripts/instance-lib.sh.
#
# Tests the static fd convention introduced for F-B3 (W22):
#   T-B3-lock-nested:        nested _acquire_lock(events.jsonl.lock, state.json.lock)
#                            keeps both flocks held simultaneously (Linux only).
#   T-B1-events-lock-window: outer events.jsonl.lock survives a nested
#                            state.json.lock acquire (Linux only).
#
# Both tests require flock(1) and exit 0 (skip cleanly) on macOS where flock
# is unavailable. The fix to events-jsonl-lock.lock-window is verified by
# proving a peer process cannot acquire events.jsonl.lock during the inner
# state.json.lock window.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
LIB="${PLUGIN_ROOT}/scripts/instance-lib.sh"

if [[ ! -f "$LIB" ]]; then
  printf 'SKIP: instance-lib.sh not found at %s\n' "$LIB" >&2
  exit 0
fi

if ! command -v flock >/dev/null 2>&1; then
  printf 'SKIP: flock(1) not available — Linux-only tests; macOS uses mkdir-fallback (path-keyed; not affected by F-B3)\n' >&2
  exit 0
fi

PASS=0
FAIL=0

_pass() { printf 'pass: %s\n' "$1"; PASS=$((PASS + 1)); }
_fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

# ── T-B3-lock-nested ────────────────────────────────────────────────────────
SANDBOX=$(mktemp -d)
trap "rm -rf '$SANDBOX'" EXIT

EJ_LOCK="$SANDBOX/events.jsonl.lock"
SJ_LOCK="$SANDBOX/state.json.lock"

# shellcheck source=/dev/null
source "$LIB"

# Acquire outer lock
if ! _acquire_lock "$EJ_LOCK"; then
  _fail "T-B3-lock-nested: could not acquire events.jsonl.lock"
  exit 1
fi

# Acquire inner lock
if ! _acquire_lock "$SJ_LOCK"; then
  _fail "T-B3-lock-nested: could not acquire state.json.lock"
  _release_lock "$EJ_LOCK"
  exit 1
fi

# At this point both should be held. Probe from a peer process: try -n on each.
if flock -n -x "$EJ_LOCK" -c true 2>/dev/null; then
  _fail "T-B3-lock-nested: outer events.jsonl.lock was DROPPED after nested acquire (B1 regression)"
else
  _pass "T-B3-lock-nested: outer events.jsonl.lock remains held during nested state.json.lock"
fi

if flock -n -x "$SJ_LOCK" -c true 2>/dev/null; then
  _fail "T-B3-lock-nested: inner state.json.lock was not actually acquired"
else
  _pass "T-B3-lock-nested: inner state.json.lock is held"
fi

# Release inner; outer should still be held
_release_lock "$SJ_LOCK"
if flock -n -x "$SJ_LOCK" -c true 2>/dev/null; then
  _pass "T-B3-lock-nested: inner state.json.lock was released cleanly"
else
  _fail "T-B3-lock-nested: inner state.json.lock did not release"
fi

if flock -n -x "$EJ_LOCK" -c true 2>/dev/null; then
  _fail "T-B3-lock-nested: outer events.jsonl.lock was lost after inner release"
else
  _pass "T-B3-lock-nested: outer events.jsonl.lock still held after inner release"
fi

# Release outer
_release_lock "$EJ_LOCK"
if flock -n -x "$EJ_LOCK" -c true 2>/dev/null; then
  _pass "T-B3-lock-nested: outer events.jsonl.lock released cleanly"
else
  _fail "T-B3-lock-nested: outer events.jsonl.lock did not release"
fi

# ── T-B1-events-lock-window ────────────────────────────────────────────────
# Multi-process race using a writer-script invoked as a subprocess.
# A peer process attempting to acquire events.jsonl.lock during the
# nested state.json.lock window must block until the outer is released.

# Use canonical lock names so the case-statement in _acquire_lock matches
# them and dispatches to fd 200 / fd 201 respectively. A non-canonical
# name like "events2.jsonl.lock" would fall through to the default branch
# (fd 200 for both), defeating this test.
SANDBOX_B1=$(mktemp -d)
EJ_LOCK2="$SANDBOX_B1/events.jsonl.lock"
SJ_LOCK2="$SANDBOX_B1/state.json.lock"
WRITER_LOG="$SANDBOX/writer.log"
WRITER_READY="$SANDBOX/writer.ready"
WRITER_SCRIPT="$SANDBOX/writer.sh"

# Use a subshell — sources $LIB in the subshell, opens fd 200/201 in the
# subshell process, sleeps with locks held, then releases. Simpler and
# avoids the bash $script wrapper that may interact oddly with our $LIB.
(
  source "$LIB"
  _acquire_lock "$EJ_LOCK2" || { echo "writer: outer acquire failed" > "$WRITER_LOG"; exit 1; }
  _acquire_lock "$SJ_LOCK2" || { echo "writer: inner acquire failed" > "$WRITER_LOG"; exit 1; }
  : > "$WRITER_READY"
  echo "writer: holding both locks" > "$WRITER_LOG"
  sleep 1.0
  _release_lock "$SJ_LOCK2"
  _release_lock "$EJ_LOCK2"
  echo "writer: released both locks" >> "$WRITER_LOG"
) &
WRITER_PID=$!

_wait_i=0
while [[ ! -f "$WRITER_READY" && $_wait_i -lt 20 ]]; do
  sleep 0.1
  _wait_i=$((_wait_i + 1))
done

if [[ ! -f "$WRITER_READY" ]]; then
  _fail "T-B1-events-lock-window: writer never reached ready (log: $(cat "$WRITER_LOG" 2>/dev/null))"
  wait $WRITER_PID 2>/dev/null
else
  RACER_RC=0
  flock -n -x "$EJ_LOCK2" -c true 2>/dev/null || RACER_RC=$?
  wait $WRITER_PID 2>/dev/null
  if [[ "$RACER_RC" -ne 0 ]]; then
    _pass "T-B1-events-lock-window: racer correctly blocked"
  else
    _fail "T-B1-events-lock-window: racer ACQUIRED events.jsonl.lock during stamp window — B1 regression (writer-log: $(cat "$WRITER_LOG" 2>/dev/null))"
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────
printf 'test-instance-lib.sh: pass=%d fail=%d\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
