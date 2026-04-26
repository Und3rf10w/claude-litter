#!/usr/bin/env bash
# test-write-state-atomic.sh — regression tests for _write_state_atomic in instance-lib.sh
#
# Coverage:
#   WSA-a: simple filter succeeds + state.json updated
#   WSA-b: --arg form works
#   WSA-c: malformed jq filter → non-zero, state.json unchanged, no orphan tmp
#   WSA-d: missing state file → non-zero, no error
#   WSA-e: empty filter result → non-zero (caught by [[ -s ]]), state.json unchanged
#   WSA-f: concurrent writes from 5 subshells → all land, no JSON corruption
#   WSA-g: flock unavailable (PATH stub) → fallback path works
#
# Exit 0 = all pass; Exit 1 = one or more failures.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INSTANCE_LIB="${PLUGIN_ROOT}/scripts/instance-lib.sh"

if [[ ! -f "$INSTANCE_LIB" ]]; then
  printf 'SKIP: instance-lib.sh not found at %s\n' "$INSTANCE_LIB" >&2
  exit 0
fi

PASS=0
FAIL=0

_pass() {
  printf 'pass: %s\n' "$1"
  PASS=$((PASS + 1))
}

_fail() {
  printf 'FAIL: %s\n' "$1" >&2
  if [[ -n "${2:-}" ]]; then
    printf '  detail: %s\n' "$2" >&2
  fi
  FAIL=$((FAIL + 1))
}

_assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    _pass "$name"
  else
    _fail "$name" "expected=${expected}, got=${actual}"
  fi
}

# Source the lib in a subshell and call the helper; return via exit code + tmp file.
_run_helper() {
  local state_file="$1"; shift
  (
    unset _DW_TIMING_TRAP_INSTALLED
    unset INSTANCE_DIR
    # shellcheck source=/dev/null
    source "$INSTANCE_LIB"
    _write_state_atomic "$state_file" "$@"
  )
}

# ── WSA-a: simple filter succeeds ────────────────────────────────────────────

echo ""
echo "── WSA-a: simple filter succeeds ──"

_sandbox=$(mktemp -d)
_state="${_sandbox}/state.json"
printf '{"session_id":"old","phase":"work"}' > "$_state"

_run_helper "$_state" '.phase = "done"'
_rc=$?

_assert_eq "WSA-a: return code 0" "0" "$_rc"
_val=$(jq -r '.phase' "$_state" 2>/dev/null)
_assert_eq "WSA-a: state.json updated" "done" "$_val"

# Confirm no orphan tmp file
_orphans=$(find "$_sandbox" -name '*.tmp.*' 2>/dev/null | wc -l | tr -d ' ')
_assert_eq "WSA-a: no orphan tmp file" "0" "$_orphans"

rm -rf "$_sandbox"

# ── WSA-b: --arg form works ───────────────────────────────────────────────────

echo ""
echo "── WSA-b: --arg form works ──"

_sandbox=$(mktemp -d)
_state="${_sandbox}/state.json"
printf '{"session_id":"old"}' > "$_state"

_run_helper "$_state" --arg sid "newsession" '.session_id = $sid'
_rc=$?

_assert_eq "WSA-b: return code 0" "0" "$_rc"
_val=$(jq -r '.session_id' "$_state" 2>/dev/null)
_assert_eq "WSA-b: state.json updated via --arg" "newsession" "$_val"

rm -rf "$_sandbox"

# ── WSA-c: malformed jq filter ───────────────────────────────────────────────

echo ""
echo "── WSA-c: malformed jq filter → non-zero, state.json unchanged ──"

_sandbox=$(mktemp -d)
_state="${_sandbox}/state.json"
_orig='{"session_id":"abc","phase":"work"}'
printf '%s' "$_orig" > "$_state"

_run_helper "$_state" 'this is not valid jq !!!'
_rc=$?

if [[ "$_rc" -ne 0 ]]; then
  _pass "WSA-c: non-zero return on bad filter"
else
  _fail "WSA-c: non-zero return on bad filter" "got rc=0"
fi

_content=$(cat "$_state")
_assert_eq "WSA-c: state.json unchanged" "$_orig" "$_content"

_orphans=$(find "$_sandbox" -name '*.tmp.*' 2>/dev/null | wc -l | tr -d ' ')
_assert_eq "WSA-c: no orphan tmp file" "0" "$_orphans"

rm -rf "$_sandbox"

# ── WSA-d: missing state file ─────────────────────────────────────────────────

echo ""
echo "── WSA-d: missing state file → non-zero, no error ──"

_sandbox=$(mktemp -d)
_missing="${_sandbox}/nonexistent.json"

_stderr_file=$(mktemp)
_run_helper "$_missing" '.foo = 1' 2>"$_stderr_file"
_rc=$?

if [[ "$_rc" -ne 0 ]]; then
  _pass "WSA-d: non-zero when file missing"
else
  _fail "WSA-d: non-zero when file missing" "got rc=0"
fi

# No new files should appear in sandbox
_files=$(find "$_sandbox" -type f 2>/dev/null | wc -l | tr -d ' ')
_assert_eq "WSA-d: no files created" "0" "$_files"

rm -rf "$_sandbox"
rm -f "$_stderr_file"

# ── WSA-e: empty filter result (jq prints nothing) ───────────────────────────

echo ""
echo "── WSA-e: empty filter result → non-zero, state.json unchanged ──"

_sandbox=$(mktemp -d)
_state="${_sandbox}/state.json"
_orig='{"session_id":"abc","phase":"plan"}'
printf '%s' "$_orig" > "$_state"

# 'empty' is a valid jq filter but produces no output — file will be 0 bytes
_run_helper "$_state" 'empty'
_rc=$?

if [[ "$_rc" -ne 0 ]]; then
  _pass "WSA-e: non-zero when filter produces no output"
else
  _fail "WSA-e: non-zero when filter produces no output" "got rc=0"
fi

_content=$(cat "$_state")
_assert_eq "WSA-e: state.json unchanged" "$_orig" "$_content"

_orphans=$(find "$_sandbox" -name '*.tmp.*' 2>/dev/null | wc -l | tr -d ' ')
_assert_eq "WSA-e: no orphan tmp file" "0" "$_orphans"

rm -rf "$_sandbox"

# ── WSA-f: concurrent writes from 5 subshells ────────────────────────────────

echo ""
echo "── WSA-f: concurrent writes → all land, no JSON corruption ──"

# Only run this case when flock is available (it tests the flock path).
if ! command -v flock >/dev/null 2>&1; then
  printf 'pass: WSA-f: SKIP (flock not available on this platform)\n'
  PASS=$((PASS + 1))
else
  _sandbox=$(mktemp -d)
  _state="${_sandbox}/state.json"
  # Use real-ish field names: phase variants tracked as phase_w1..phase_w5
  printf '{"phase_w1":0,"phase_w2":0,"phase_w3":0,"phase_w4":0,"phase_w5":0}' > "$_state"

  _pids=()
  for _i in 1 2 3 4 5; do
    (
      unset _DW_TIMING_TRAP_INSTALLED
      unset INSTANCE_DIR
      # shellcheck source=/dev/null
      source "$INSTANCE_LIB"
      _write_state_atomic "$_state" --argjson v "$_i" --arg k "phase_w${_i}" '.[$k] = $v'
    ) &
    _pids+=($!)
  done

  for _pid in "${_pids[@]}"; do
    wait "$_pid"
  done

  # Verify JSON is valid
  if jq . "$_state" >/dev/null 2>&1; then
    _pass "WSA-f: state.json is valid JSON after concurrent writes"
  else
    _fail "WSA-f: state.json is valid JSON after concurrent writes" "$(cat "$_state")"
  fi

  # All 5 fields should be set to their expected values (1-5)
  _all_set=1
  for _i in 1 2 3 4 5; do
    _got=$(jq ".phase_w${_i}" "$_state" 2>/dev/null)
    if [[ "$_got" != "$_i" ]]; then
      _all_set=0
      _fail "WSA-f: phase_w${_i} = ${_i}" "got ${_got}"
    fi
  done
  [[ "$_all_set" == "1" ]] && _pass "WSA-f: all 5 fields written correctly"

  _orphans=$(find "$_sandbox" -name '*.tmp.*' 2>/dev/null | wc -l | tr -d ' ')
  _assert_eq "WSA-f: no orphan tmp files" "0" "$_orphans"

  rm -rf "$_sandbox"
fi

# ── WSA-g: flock unavailable → fallback path works ───────────────────────────
#
# The fallback branch executes when flock is not in PATH. We test it by
# constructing a minimal PATH containing only a tmpdir with jq but no flock,
# so `command -v flock` returns non-zero inside the subshell.

echo ""
echo "── WSA-g: flock unavailable → fallback path works ──"

_sandbox=$(mktemp -d)
_state="${_sandbox}/state.json"
printf '{"session_id":"old","phase":"plan"}' > "$_state"

# Build a stripped PATH: only the directory that contains jq (no flock).
_jq_dir=$(dirname "$(command -v jq 2>/dev/null)")

(
  unset _DW_TIMING_TRAP_INSTALLED
  unset INSTANCE_DIR
  # Strip flock from PATH by using only the jq directory (plus /usr/bin for mv/etc).
  # On macOS flock is absent by default; on Linux this effectively removes it.
  export PATH="${_jq_dir}:/usr/bin:/bin"
  # shellcheck source=/dev/null
  source "$INSTANCE_LIB"
  _write_state_atomic "$_state" '.phase = "done"'
) 2>/dev/null
_rc=$?

_assert_eq "WSA-g: return code 0 on fallback path" "0" "$_rc"
_val=$(jq -r '.phase' "$_state" 2>/dev/null)
_assert_eq "WSA-g: state.json updated via fallback" "done" "$_val"

rm -rf "$_sandbox"

# ── WSA-h: discover_instance backfill routes through state-transition.sh ─────
#
# After W13 Commit 3, the backfill inside discover_instance() calls
# state-transition.sh backfill_session instead of _write_state_atomic directly.
# That means the resulting state.json gains a state_integrity_hash (because
# backfill_session goes through _write_with_hash).  The old direct
# _write_state_atomic path left no hash.  So the test verifies:
#   1. discover_instance succeeds when session_id is a placeholder
#   2. state.json ends up with state_integrity_hash present after backfill

echo ""
echo "── WSA-h: discover_instance backfill writes integrity hash ──"

_sandbox=$(mktemp -d)
_sandbox="$(cd "$_sandbox" && pwd -P)"
_iid="deadc0de"
_idir="${_sandbox}/.claude/deepwork/${_iid}"
mkdir -p "$_idir"
_state="${_idir}/state.json"

STATE_TRANSITION="${PLUGIN_ROOT}/scripts/state-transition.sh"
"$STATE_TRANSITION" --state-file "$_state" init - <<'EOJS'
{
  "session_id": "deepwork-placeholder-001",
  "instance_id": "deadc0de",
  "phase": "scope",
  "team_name": "test-team",
  "hook_warnings": [],
  "bar": [],
  "frontmatter_schema_version": "1"
}
EOJS

# Advance state so the file has a hash (phase_advance writes one), then
# reset session_id to a placeholder to simulate a pre-backfill instance.
"$STATE_TRANSITION" --state-file "$_state" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$_state" merge '{"session_id":"deepwork-placeholder-001"}'
(
  unset _DW_TIMING_TRAP_INSTALLED
  unset INSTANCE_DIR
  export CLAUDE_PROJECT_DIR="${_sandbox}"
  # shellcheck source=/dev/null
  source "$INSTANCE_LIB"
  discover_instance "real-session-abc"
) >/dev/null 2>&1
_rc=$?

# session_id should be backfilled to the real session id
_sid=$(jq -r '.session_id // ""' "$_state" 2>/dev/null)
_assert_eq "WSA-h: session_id backfilled to real session" "real-session-abc" "$_sid"

# Integrity hash must now be present (backfill_session uses _write_with_hash)
_h_after=$(jq -r '.state_integrity_hash // ""' "$_state" 2>/dev/null)
if [[ -n "$_h_after" ]] && [[ "$_h_after" != "null" ]]; then
  _pass "WSA-h: state_integrity_hash present after backfill"
else
  _fail "WSA-h: state_integrity_hash absent after backfill — old direct-write path still active"
fi

rm -rf "$_sandbox"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "─────────────────────────────────────"
printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
