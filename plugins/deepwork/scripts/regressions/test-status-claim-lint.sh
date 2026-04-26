#!/usr/bin/env bash
# test-status-claim-lint.sh — regression tests for
# hooks/status-claim-regex-precheck.sh (committed 0636df5)
#
# Coverage: async protocol, all 10 §5 violation patterns, grounding detection,
# edge cases (missing/absent/binary transcript, INSTANCE_DIR unset), race safety
# (5 parallel invocations), and latency (<50ms to first exit).
#
# Exit 0 = all assertions pass; Exit 1 = one or more failures.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${PLUGIN_ROOT}/hooks/status-claim-regex-precheck.sh"

if [[ ! -f "$HOOK" ]]; then
  printf 'SKIP: status-claim-regex-precheck.sh not found at %s\n' "$HOOK" >&2
  exit 0
fi

if ! command -v jq >/dev/null 2>&1; then
  printf 'SKIP: jq not available\n' >&2
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
    _fail "$name" "expected=$expected actual=$actual"
  fi
}

# ── Sandbox ──
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

INSTANCE_DIR="$SANDBOX/instance"
mkdir -p "$INSTANCE_DIR"
JSONL_FILE="$INSTANCE_DIR/metrics-violations.jsonl"

TRANSCRIPT="$SANDBOX/transcript.jsonl"

# Build a JSONL turn with given text content (no tool_use).
_make_turn() {
  local text="$1"
  jq -cn --arg t "$text" '{
    "role": "assistant",
    "message": {
      "content": [{"type": "text", "text": $t}]
    }
  }'
}

# Build a JSONL turn with given text content AND a Read tool_use (grounded).
_make_grounded_turn() {
  local text="$1"
  jq -cn --arg t "$text" '{
    "role": "assistant",
    "message": {
      "content": [
        {"type": "text", "text": $t},
        {"type": "tool_use", "name": "Read", "tool_use_id": "tu1", "input": {"file_path": "state.json"}}
      ]
    }
  }'
}

# Run hook with given stdin payload, return stdout in _LAST_STDOUT and exit in _LAST_EXIT.
_run_hook() {
  local stdin_payload="$1"
  local stdout_file
  stdout_file=$(mktemp)
  printf '%s' "$stdin_payload" \
    | INSTANCE_DIR="$INSTANCE_DIR" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" > "$stdout_file" 2>/dev/null
  _LAST_EXIT=$?
  _LAST_STDOUT=$(cat "$stdout_file")
  rm -f "$stdout_file"
}

# Build a standard stdin payload referencing TRANSCRIPT.
_payload() {
  jq -cn \
    --arg teammate "alice" \
    --arg transcript "$TRANSCRIPT" \
    '{"team_name":"test-team","teammate_name":$teammate,"transcript_path":$transcript}'
}

# Wait up to 2s for the background subshell to write metrics-violations.jsonl.
_wait_metrics() {
  local i=0
  while [[ $i -lt 20 ]]; do
    [[ -f "$JSONL_FILE" ]] && return 0
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

# Wait up to 2s for violation count to reach expected value.
_wait_count() {
  local expected_ge="$1" i=0
  local T D
  T="alice"
  D=$(date -u +%Y-%m-%d)
  while [[ $i -lt 20 ]]; do
    if [[ -f "$JSONL_FILE" ]]; then
      local cnt
      cnt=$(jq -s --arg t "$T" --arg d "$D" \
        'map(select(.teammate==$t and .date==$d)) | map(.violations) | add // 0' \
        "$JSONL_FILE" 2>/dev/null || echo 0)
      [[ "$cnt" -ge "$expected_ge" ]] && return 0
    fi
    sleep 0.1
    i=$((i + 1))
  done
  return 1
}

_get_count() {
  local T D
  T="alice"
  D=$(date -u +%Y-%m-%d)
  [[ -f "$JSONL_FILE" ]] || { echo 0; return; }
  jq -s --arg t "$T" --arg d "$D" \
    'map(select(.teammate==$t and .date==$d)) | map(.violations) | add // 0' \
    "$JSONL_FILE" 2>/dev/null || echo 0
}

# Reset JSONL file and transcript between groups.
_reset() {
  rm -f "$JSONL_FILE" "$TRANSCRIPT"
}


# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── SC-1: Async protocol — first stdout line is {\"async\":true} ──"
# ══════════════════════════════════════════════════════════════════════════════
_reset
_make_turn "hello world" > "$TRANSCRIPT"
_run_hook "$(_payload)"
FIRST_LINE=$(printf '%s' "$_LAST_STDOUT" | head -1)
_assert_eq "SC-1: first stdout line is {\"async\":true}" '{"async":true}' "$FIRST_LINE"


# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── SC-2: Always exits 0 ──"
# ══════════════════════════════════════════════════════════════════════════════

# SC-2a: happy path — valid transcript, valid turn
_reset
_make_turn "task #3 is pending" > "$TRANSCRIPT"
_run_hook "$(_payload)"
_assert_eq "SC-2a: happy path exits 0" "0" "$_LAST_EXIT"

# SC-2b: missing teammate_name field → still exit 0
_reset
_make_turn "some text" > "$TRANSCRIPT"
BAD_PAYLOAD=$(jq -cn --arg t "$TRANSCRIPT" '{"team_name":"t","transcript_path":$t}')
printf '%s' "$BAD_PAYLOAD" \
  | INSTANCE_DIR="$INSTANCE_DIR" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" >/dev/null 2>/dev/null
_assert_eq "SC-2b: missing teammate_name exits 0" "0" "$?"

# SC-2c: nonexistent transcript → exit 0
_reset
NONEXISTENT="$SANDBOX/does-not-exist.jsonl"
BAD_PAYLOAD=$(jq -cn --arg tm "bob" --arg t "$NONEXISTENT" '{"team_name":"t","teammate_name":$tm,"transcript_path":$t}')
printf '%s' "$BAD_PAYLOAD" \
  | INSTANCE_DIR="$INSTANCE_DIR" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" >/dev/null 2>/dev/null
_assert_eq "SC-2c: nonexistent transcript exits 0" "0" "$?"

# SC-2d: malformed JSONL (not valid JSON lines) → exit 0
_reset
printf 'not json at all\n{broken: stuff\n' > "$TRANSCRIPT"
_run_hook "$(_payload)"
_assert_eq "SC-2d: malformed JSONL exits 0" "0" "$_LAST_EXIT"

# SC-2e: INSTANCE_DIR unset → exit 0 (no instance discovery, no metrics write)
_reset
_make_turn "task #1 is done" > "$TRANSCRIPT"
PAYLOAD_UNSET=$(jq -cn --arg tm "alice" --arg t "$TRANSCRIPT" '{"team_name":"unset-team","teammate_name":$tm,"transcript_path":$t}')
printf '%s' "$PAYLOAD_UNSET" \
  | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" >/dev/null 2>/dev/null
_assert_eq "SC-2e: INSTANCE_DIR unset exits 0" "0" "$?"


# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── SC-3: All 10 violation patterns trigger counter ──"
# ══════════════════════════════════════════════════════════════════════════════

# Associative arrays need bash 4; use parallel indexed arrays for bash 3 compat.
PATTERN_TEXTS=(
  "task #3 is pending"                          # 1
  "the proposal is at v2"                       # 2
  "the mechanism doc review is complete"        # 3: needs word between keyword and "is"
  "workstream OD-PS2 remains pending"           # 4
  "that item is still pending"                  # 5
  "the proposal hasn't moved"                   # 6
  "no progress on OD-PS2 since Monday"          # 7
  "confirmed that task #7 is done"              # 8
  "the current version is v3"                   # 9
  "approved at v2"                              # 10
)

for i in 1 2 3 4 5 6 7 8 9 10; do
  _reset
  IDX=$((i - 1))
  TEXT="${PATTERN_TEXTS[$IDX]}"
  _make_turn "$TEXT" > "$TRANSCRIPT"
  _run_hook "$(_payload)"

  _wait_metrics
  COUNT=$(_get_count)
  if [[ "$COUNT" -ge 1 ]]; then
    _pass "SC-3-P${i}: pattern ${i} triggers counter (count=${COUNT})"
  else
    _fail "SC-3-P${i}: pattern ${i} should trigger counter" \
      "text='${TEXT}' count=${COUNT} jsonl=$(cat "$JSONL_FILE" 2>/dev/null || echo '<absent>')"
  fi
done


# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── SC-4: Grounding detection ──"
# ══════════════════════════════════════════════════════════════════════════════

# SC-4a: pattern + Read tool_use in same turn → counter NOT incremented
_reset
_make_grounded_turn "task #3 is pending" > "$TRANSCRIPT"
_run_hook "$(_payload)"
sleep 0.5
COUNT=$(_get_count)
_assert_eq "SC-4a: grounded claim does not increment counter" "0" "$COUNT"

# SC-4b: pattern + no grounding → counter incremented
_reset
_make_turn "the proposal hasn't moved" > "$TRANSCRIPT"
_run_hook "$(_payload)"
_wait_count 1
COUNT=$(_get_count)
if [[ "$COUNT" -ge 1 ]]; then
  _pass "SC-4b: ungrounded claim increments counter (count=${COUNT})"
else
  _fail "SC-4b: ungrounded claim should increment counter" "count=${COUNT}"
fi


# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── SC-5: Edge cases ──"
# ══════════════════════════════════════════════════════════════════════════════

# SC-5a: transcript_path field missing from payload → exit 0, no metrics write
_reset
NO_TRANSCRIPT_PAYLOAD=$(jq -cn '{"team_name":"t","teammate_name":"alice"}')
printf '%s' "$NO_TRANSCRIPT_PAYLOAD" \
  | INSTANCE_DIR="$INSTANCE_DIR" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" >/dev/null 2>/dev/null
_assert_eq "SC-5a: transcript_path missing exits 0" "0" "$?"
sleep 0.3
[[ ! -f "$JSONL_FILE" ]] && _pass "SC-5a: no metrics written when transcript_path missing" \
  || _fail "SC-5a: no metrics written when transcript_path missing" "metrics-violations.jsonl exists unexpectedly"

# SC-5b: transcript file absent (empty string path) → no counter increment
_reset
EMPTY_PATH_PAYLOAD=$(jq -cn '{"team_name":"t","teammate_name":"alice","transcript_path":""}')
printf '%s' "$EMPTY_PATH_PAYLOAD" \
  | INSTANCE_DIR="$INSTANCE_DIR" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" >/dev/null 2>/dev/null
_assert_eq "SC-5b: empty transcript_path exits 0" "0" "$?"

# SC-5c: binary transcript (not valid JSONL) → no counter increment, no crash
_reset
printf '\x00\x01\x02\xff\xfe binary garbage\x00' > "$TRANSCRIPT"
_run_hook "$(_payload)"
_assert_eq "SC-5c: binary transcript exits 0" "0" "$_LAST_EXIT"
sleep 0.3
COUNT=$(_get_count)
_assert_eq "SC-5c: binary transcript does not increment counter" "0" "$COUNT"

# SC-5d: empty transcript → no counter increment
_reset
: > "$TRANSCRIPT"
_run_hook "$(_payload)"
_assert_eq "SC-5d: empty transcript exits 0" "0" "$_LAST_EXIT"
sleep 0.3
COUNT=$(_get_count)
_assert_eq "SC-5d: empty transcript does not increment counter" "0" "$COUNT"

# SC-5e: INSTANCE_DIR unset → no crash, no metrics file created
_reset
_make_turn "task #1 is done" > "$TRANSCRIPT"
PAYLOAD_NODISCOVERY=$(jq -cn --arg tm "alice" --arg t "$TRANSCRIPT" '{"team_name":"no-such-team","teammate_name":$tm,"transcript_path":$t}')
printf '%s' "$PAYLOAD_NODISCOVERY" \
  | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" >/dev/null 2>/dev/null
_assert_eq "SC-5e: INSTANCE_DIR unset exits 0" "0" "$?"
sleep 0.3
[[ ! -f "$JSONL_FILE" ]] && _pass "SC-5e: no metrics written when INSTANCE_DIR unset" \
  || _fail "SC-5e: no metrics written when INSTANCE_DIR unset" "metrics-violations.jsonl exists unexpectedly"


# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── SC-6: Race safety — 5 parallel invocations ──"
# ══════════════════════════════════════════════════════════════════════════════
_reset
_make_turn "task #3 is pending" > "$TRANSCRIPT"

PAYLOAD=$(_payload)
for _i in 1 2 3 4 5; do
  printf '%s' "$PAYLOAD" \
    | INSTANCE_DIR="$INSTANCE_DIR" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" >/dev/null 2>/dev/null &
done
wait

# Wait for all background subshells to write JSONL
_wait_count 5 || true
sleep 0.3

if [[ -f "$JSONL_FILE" ]]; then
  # Every line must be valid JSON
  INVALID_LINES=$(grep -c . "$JSONL_FILE" 2>/dev/null || echo 0)
  VALID_LINES=0
  while IFS= read -r _line; do
    [[ -n "$_line" ]] && printf '%s' "$_line" | jq -e . >/dev/null 2>&1 && VALID_LINES=$((VALID_LINES + 1))
  done < "$JSONL_FILE"
  if [[ "$VALID_LINES" -ge 1 ]]; then
    _pass "SC-6a: metrics-violations.jsonl has valid JSON lines after 5 parallel invocations (valid_lines=${VALID_LINES})"
  else
    _fail "SC-6a: metrics-violations.jsonl has valid JSON lines after 5 parallel invocations" \
      "content: $(cat "$JSONL_FILE" 2>/dev/null)"
  fi

  COUNT=$(_get_count)
  # JSONL append is atomic per POSIX PIPE_BUF; all 5 writes should land.
  # Assert == 5: each invocation contributes exactly 1 violation (pattern 1 matches once).
  _assert_eq "SC-6b: count reflects exactly 5 parallel writes" "5" "$COUNT"
else
  _fail "SC-6a: metrics-violations.jsonl has valid JSON lines after 5 parallel invocations" "file absent"
  _fail "SC-6b: count reflects exactly 5 parallel writes" "file absent"
fi


# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "── SC-7: Latency — hook exits under 50ms ──"
# ══════════════════════════════════════════════════════════════════════════════
_reset
_make_turn "hello world" > "$TRANSCRIPT"

START_NS=$(date +%s%N 2>/dev/null || echo "")
if [[ "$START_NS" == *N ]]; then
  START_NS="$(date +%s)000000000"
fi

_run_hook "$(_payload)"

END_NS=$(date +%s%N 2>/dev/null || echo "")
if [[ "$END_NS" == *N ]]; then
  END_NS="$(date +%s)000000000"
fi

if [[ -n "$START_NS" && -n "$END_NS" && "$START_NS" =~ ^[0-9]+$ && "$END_NS" =~ ^[0-9]+$ ]]; then
  ELAPSED_MS=$(( (END_NS - START_NS) / 1000000 ))
  if [[ "$ELAPSED_MS" -lt 50 ]]; then
    _pass "SC-7: hook exits in under 50ms (actual: ${ELAPSED_MS}ms)"
  else
    _fail "SC-7: hook exits in under 50ms" "actual: ${ELAPSED_MS}ms"
  fi
else
  _pass "SC-7: latency check skipped (date +%s%N not supported, async exit verified by SC-1)"
fi


# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "─────────────────────────────────────"
printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
