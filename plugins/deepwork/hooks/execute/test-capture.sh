#!/bin/bash
# test-capture.sh — PostToolUse(Bash) and PostToolUseFailure(Bash) advisory test-result
# capture hook.
#
# This hook is exclusively a data capture hook — PostToolUse CANNOT block any future
# operation (cli_formatted_2.1.116.js:266053-266058: PostToolUse hookSpecificOutput has no
# permissionDecision field). The enforcement half of the test-evidence gate lives in
# plan-citation-gate.sh (PreToolUse Write|Edit) which reads test-results.jsonl before
# the next write.
#
# v2.1.118 tool response shape (W11 H6):
#   PostToolUse(Bash):         .tool_response.data.{stdout, stderr, interrupted}
#   PostToolUseFailure(Bash):  .error (string), .is_interrupt (bool) — no tool_response
#
# Async is a hooks.json config-time property ("async": true on the registration entry),
# NOT a stdout signal. Do not emit {"async":true} from this script.
#
# Test runner detection: regex match on tool_input.command for common runners.
# Pass/fail parsing: scan stdout for counts; fall back to exit_code / interrupted.
# Flaky detection: after each capture, check last 6 entries for same command with mixed
# pass/fail — if ≥3 entries with alternating exit_code, append to state.execute.flaky_tests[].
#
# Fail-open on any error — never block, never exit 2 from this hook.

set +e

command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

discover_instance "$SESSION_ID" 2>/dev/null || exit 0

# Only active execute instances
EXEC_PHASE=$(jq -r '.execute.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
[[ -n "$EXEC_PHASE" ]] || exit 0

COMMAND=$(printf '%s' "$INPUT" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
[[ -n "$COMMAND" ]] || exit 0

# Detect test runner commands
if ! printf '%s' "$COMMAND" | grep -qE '^[[:space:]]*(npm[[:space:]]+test|pytest|uv[[:space:]]+run[[:space:]]+pytest|go[[:space:]]+test|cargo[[:space:]]+test|jest|mocha|vitest|yarn[[:space:]]+test|bun[[:space:]]+test)'; then
  exit 0
fi

# Extract stdout/stderr/exit_code from v2.1.118 response shapes:
#   PostToolUse:        .tool_response.data.{stdout,stderr,interrupted}
#   PostToolUseFailure: .error, .is_interrupt (no tool_response)
if [[ "$HOOK_EVENT_NAME" == "PostToolUseFailure" ]]; then
  STDOUT=""
  STDERR=$(printf '%s' "$INPUT" | jq -r '.error // ""' 2>/dev/null || echo "")
  IS_INTERRUPT=$(printf '%s' "$INPUT" | jq -r '.is_interrupt // false' 2>/dev/null || echo "false")
  if [[ "$IS_INTERRUPT" == "true" ]]; then
    EXIT_CODE=130
  else
    EXIT_CODE=1
  fi
else
  STDOUT=$(printf '%s' "$INPUT" | jq -r '.tool_response.data.stdout // ""' 2>/dev/null || echo "")
  STDERR=$(printf '%s' "$INPUT" | jq -r '.tool_response.data.stderr // ""' 2>/dev/null || echo "")
  INTERRUPTED=$(printf '%s' "$INPUT" | jq -r '.tool_response.data.interrupted // false' 2>/dev/null || echo "false")
  if [[ "$INTERRUPTED" == "true" ]]; then
    EXIT_CODE=130
  else
    EXIT_CODE=0
  fi
fi
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Read change_id from pending-change.json
CHANGE_ID=$(jq -r '.change_id // ""' "${INSTANCE_DIR}/pending-change.json" 2>/dev/null || echo "")

# Parse pass/fail counts from stdout
PASSED_COUNT=0
FAILED_COUNT=0
DURATION_MS=0

# pytest: "X passed, Y failed" or "X passed"
if printf '%s' "$STDOUT" | grep -qE '[0-9]+ passed'; then
  PASSED_COUNT=$(printf '%s' "$STDOUT" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+' || echo "0")
fi
if printf '%s' "$STDOUT" | grep -qE '[0-9]+ failed'; then
  FAILED_COUNT=$(printf '%s' "$STDOUT" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+' || echo "0")
fi

# go test: "ok" or "FAIL"
if printf '%s' "$COMMAND" | grep -qE 'go[[:space:]]+test' && [[ "$PASSED_COUNT" -eq 0 ]]; then
  if printf '%s' "$STDOUT" | grep -qE '^ok[[:space:]]'; then
    PASSED_COUNT=1
  elif printf '%s' "$STDOUT" | grep -qE '^FAIL[[:space:]]'; then
    FAILED_COUNT=1
  fi
fi

# jest/vitest: "X passed, Y failed" or similar
if printf '%s' "$STDOUT" | grep -qE 'Tests?:[[:space:]]*[0-9]+ passed'; then
  _p=$(printf '%s' "$STDOUT" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+' || echo "0")
  [[ "$_p" -gt "$PASSED_COUNT" ]] && PASSED_COUNT=$_p
fi
if printf '%s' "$STDOUT" | grep -qE 'Tests?:[[:space:]]*[0-9]+ failed'; then
  _f=$(printf '%s' "$STDOUT" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+' || echo "0")
  [[ "$_f" -gt "$FAILED_COUNT" ]] && FAILED_COUNT=$_f
fi

# Extract duration if available (pytest timing: "Xm Y.YYs")
if printf '%s' "$STDOUT" | grep -qE '[0-9]+\.[0-9]+s'; then
  _dur=$(printf '%s' "$STDOUT" | grep -oE '[0-9]+\.[0-9]+s' | tail -1 | tr -d 's' || echo "")
  if [[ -n "$_dur" ]]; then
    DURATION_MS=$(printf '%.0f' "$(echo "$_dur * 1000" | bc 2>/dev/null || echo "0")" 2>/dev/null || echo "0")
  fi
fi

# Tail of stdout/stderr for debugging (last 20 lines each)
STDOUT_TAIL=$(printf '%s' "$STDOUT" | tail -20 | head -c 2000)
STDERR_TAIL=$(printf '%s' "$STDERR" | tail -10 | head -c 1000)

# Write entry to test-results.jsonl (append-only via shell >> which is O_APPEND)
TEST_RESULTS="${INSTANCE_DIR}/test-results.jsonl"
ENTRY=$(jq -n \
  --arg ts "$TS" \
  --arg cmd "$COMMAND" \
  --argjson exit_code "$EXIT_CODE" \
  --argjson passed "$PASSED_COUNT" \
  --argjson failed "$FAILED_COUNT" \
  --argjson dur "$DURATION_MS" \
  --arg change_id "$CHANGE_ID" \
  --arg stdout_tail "$STDOUT_TAIL" \
  --arg stderr_tail "$STDERR_TAIL" \
  '{
    timestamp: $ts,
    command: $cmd,
    exit_code: $exit_code,
    passed_count: $passed,
    failed_count: $failed,
    flaky_suspected: false,
    duration_ms: $dur,
    change_id: $change_id,
    covering_files: [],
    stdout_tail: $stdout_tail,
    stderr_tail: $stderr_tail
  }' 2>/dev/null)

if [[ -n "$ENTRY" ]]; then
  printf '%s\n' "$ENTRY" >> "$TEST_RESULTS"
fi

# --- Flaky detection: scan last 6 entries for same command with mixed pass/fail ---
if [[ -f "$TEST_RESULTS" ]] && [[ -s "$TEST_RESULTS" ]]; then
  FLAKY_CMD=$(jq -rs --arg cmd "$COMMAND" '
    map(select(.command == $cmd)) |
    .[-6:] |
    if length >= 3 then
      (map(.exit_code == 0) | unique | length) as $unique_results |
      if $unique_results > 1 then
        # Mixed results — check for >=3 entries with alternation
        (map(.exit_code) | length) as $n |
        if $n >= 3 then $cmd else null end
      else null end
    else null end
  ' "$TEST_RESULTS" 2>/dev/null || echo "null")

  if [[ -n "$FLAKY_CMD" ]] && [[ "$FLAKY_CMD" != "null" ]]; then
    # Append to state.execute.flaky_tests[] via state-transition.sh (deduplicates)
    STATE_FILE="$STATE_FILE" bash "${_PLUGIN_ROOT}/scripts/state-transition.sh" \
      flaky_test_append --cmd "$FLAKY_CMD" 2>/dev/null || true

    # Update flaky_suspected flag on the entry just written
    if [[ -n "$ENTRY" ]] && [[ -f "$TEST_RESULTS" ]]; then
      _TMP_RESULTS="${TEST_RESULTS}.tmp.$$"
      # Replace the last line with flaky_suspected:true
      jq -rs --arg cmd "$COMMAND" --arg ts "$TS" '
        . as $entries |
        $entries | (length - 1) as $last_idx |
        $entries[$last_idx:] | .[0] |
        if .command == $cmd and .timestamp == $ts then
          .flaky_suspected = true
        else . end
      ' "$TEST_RESULTS" > /dev/null 2>/dev/null || true
      # Simpler approach: rewrite last line
      _LAST_LINE=$(tail -1 "$TEST_RESULTS")
      _UPDATED=$(printf '%s' "$_LAST_LINE" | jq '.flaky_suspected = true' 2>/dev/null || echo "$_LAST_LINE")
      if [[ -n "$_UPDATED" ]] && [[ "$_UPDATED" != "$_LAST_LINE" ]]; then
        head -n -1 "$TEST_RESULTS" > "${TEST_RESULTS}.tmp.$$" 2>/dev/null
        printf '%s\n' "$_UPDATED" >> "${TEST_RESULTS}.tmp.$$"
        mv "${TEST_RESULTS}.tmp.$$" "$TEST_RESULTS" 2>/dev/null || rm -f "${TEST_RESULTS}.tmp.$$"
      fi
    fi
  fi
fi

exit 0
