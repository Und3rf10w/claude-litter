#!/bin/bash
# file-changed-retest.sh — FileChanged(src/**) secondary advisory retest trigger.
#
# Fires on filesystem-level change events in src/** (chokidar glob, resolved to
# $cwd/src/** at registration time per cli_formatted_2.1.116.js:269399-269416).
# There is a 500ms awaitWriteFinish stabilityThreshold debounce before the hook fires
# (cli_formatted_2.1.116.js:269417 chokidar options). This means batch edits coalesce
# into a single hook fire — one test run at the end of the batch, which is desirable.
#
# Advisory only — FileChanged hooks cannot block. Results written to test-results.jsonl.
#
# Async: asyncTimeout=30000ms explicitly overrides the 15000ms CC default
# (cli_formatted_2.1.116.js:264193: `let Y = q.asyncTimeout || 15000`). Once backgrounded
# after the async handshake, async stdout is discarded (cli_formatted_2.1.116.js:565249-565328)
# — all results must go to disk.
#
# stdin fields: file_path (changed file), event (add/change/unlink)
# Fail-open on any error.

set +e

command -v jq >/dev/null 2>&1 || exit 0

# Emit async handshake with explicit 30s timeout override
printf '{"async": true, "asyncTimeout": 30000}\n'

INPUT=$(cat)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
discover_instance "$SESSION_ID" 2>/dev/null || exit 0

# Only active execute instances
EXEC_PHASE=$(jq -r '.execute.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
[[ -n "$EXEC_PHASE" ]] || exit 0

FILE_PATH=$(printf '%s' "$INPUT" | jq -r '.file_path // ""' 2>/dev/null || echo "")
EVENT=$(printf '%s' "$INPUT" | jq -r '.event // ""' 2>/dev/null || echo "")

[[ -n "$FILE_PATH" ]] || exit 0
# Only retest on add/change; unlink means the file is gone
[[ "$EVENT" == "unlink" ]] && exit 0

# Look up covering test from test_manifest[]
TEST_CMD=$(jq -r --arg fp "$FILE_PATH" '
  .execute.test_manifest // [] |
  map(select(.source_file == $fp)) |
  if length > 0 then .[0].test_command else "" end
' "$STATE_FILE" 2>/dev/null || echo "")

[[ -n "$TEST_CMD" ]] || exit 0

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START_NS=$(date +%s%N 2>/dev/null || echo "0")
CHANGE_ID=$(jq -r '.change_id // ""' "${INSTANCE_DIR}/pending-change.json" 2>/dev/null || echo "")
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PROJECT_ROOT}"
TEST_RESULTS="${INSTANCE_DIR}/test-results.jsonl"

# Run the covering test
TEST_STDOUT=$(cd "$PROJECT_DIR" && eval "$TEST_CMD" 2>&1)
TEST_EXIT=$?
END_NS=$(date +%s%N 2>/dev/null || echo "0")

DURATION_MS=0
if [[ "$START_NS" != "0" ]] && [[ "$END_NS" != "0" ]]; then
  DURATION_MS=$(( (END_NS - START_NS) / 1000000 ))
fi

PASSED_COUNT=0
FAILED_COUNT=0
if printf '%s' "$TEST_STDOUT" | grep -qE '[0-9]+ passed'; then
  PASSED_COUNT=$(printf '%s' "$TEST_STDOUT" | grep -oE '[0-9]+ passed' | head -1 | grep -oE '[0-9]+' || echo "0")
fi
if printf '%s' "$TEST_STDOUT" | grep -qE '[0-9]+ failed'; then
  FAILED_COUNT=$(printf '%s' "$TEST_STDOUT" | grep -oE '[0-9]+ failed' | head -1 | grep -oE '[0-9]+' || echo "0")
fi

STDOUT_TAIL=$(printf '%s' "$TEST_STDOUT" | tail -20 | head -c 2000)

ENTRY=$(jq -n \
  --arg ts "$TS" \
  --arg cmd "$TEST_CMD" \
  --argjson exit_code "$TEST_EXIT" \
  --argjson passed "$PASSED_COUNT" \
  --argjson failed "$FAILED_COUNT" \
  --argjson dur "$DURATION_MS" \
  --arg change_id "$CHANGE_ID" \
  --arg file_path "$FILE_PATH" \
  --arg event "$EVENT" \
  --arg stdout_tail "$STDOUT_TAIL" \
  '{
    timestamp: $ts,
    command: $cmd,
    exit_code: $exit_code,
    passed_count: $passed,
    failed_count: $failed,
    flaky_suspected: false,
    duration_ms: $dur,
    change_id: $change_id,
    covering_files: [$file_path],
    trigger: ("FileChanged:" + $event),
    stdout_tail: $stdout_tail,
    stderr_tail: ""
  }' 2>/dev/null)

if [[ -n "$ENTRY" ]]; then
  if command -v flock >/dev/null 2>&1; then
    (flock -x 200; printf '%s\n' "$ENTRY" >> "$TEST_RESULTS") 200>"${TEST_RESULTS}.lock" 2>/dev/null || \
      printf '%s\n' "$ENTRY" >> "$TEST_RESULTS"
  else
    printf '%s\n' "$ENTRY" >> "$TEST_RESULTS"
  fi
fi

exit 0
