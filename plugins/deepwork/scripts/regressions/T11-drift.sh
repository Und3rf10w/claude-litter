#!/usr/bin/env bash
# T11-drift.sh — adversarial tests for hooks/state-drift-marker.sh (G-exec-4)
#
# Written BEFORE implementation to define the contract. Will SKIP if
# state-drift-marker.sh doesn't exist yet.
#
# Test strategy: exercise the 5 behavioral contracts from the mission brief:
#   (a) HOOK_EVENT_NAME=PreToolUse with Write target=state.json → snapshot created
#   (b) HOOK_EVENT_NAME=PostToolUse after phase change → log.md gets phase-transition line
#   (c) HOOK_EVENT_NAME=PostToolUse with no snapshot → no op, exits 0
#   (d) Write target not state.json → no op
#   (e) dedup: PostToolUse twice for same phase → only one log line
#
# Exit 0 = all ran cases passed
# Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${PLUGIN_ROOT}/hooks/state-drift-marker.sh"

if [[ ! -f "$HOOK" ]]; then
  printf 'SKIP: state-drift-marker.sh not found at %s — G-exec-4 not yet implemented\n' "$HOOK" >&2
  exit 0
fi

PASS=0
FAIL=0

_assert_exit() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf 'pass: %s (exit=%s)\n' "$name" "$actual"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected exit %s, got %s\n' "$name" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

_assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf 'pass: %s (found "%s")\n' "$name" "$needle"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — did not find "%s"\n' "$name" "$needle" >&2
    printf '  actual: %s\n' "$haystack" >&2
    FAIL=$((FAIL + 1))
  fi
}

_count_lines() {
  local needle="$1" haystack="$2"
  printf '%s' "$haystack" | grep -cF -- "$needle" 2>/dev/null || echo "0"
}

# ── Fixture setup ──
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

export CLAUDE_PROJECT_DIR="$SANDBOX"
INSTANCE_ID="ab12cd34"
INSTANCE_DIR="$SANDBOX/.claude/deepwork/$INSTANCE_ID"
mkdir -p "$INSTANCE_DIR"

SESSION_ID="test-session-$(date +%s)"

STATE_FILE="${INSTANCE_DIR}/state.json"
LOG_FILE="${INSTANCE_DIR}/log.md"
SNAPSHOT="${INSTANCE_DIR}/.state-snapshot"

STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{
  "session_id": "$SESSION_ID",
  "phase": "explore",
  "team_name": "test-team",
  "bar": [
    {"id": "G1", "verdict": null},
    {"id": "G2", "verdict": null}
  ]
}
EOF

printf '# Log\n\n' > "$LOG_FILE"

_run_hook() {
  local event="$1" tool_name="$2" file_path="$3"
  local payload
  payload=$(jq -cn \
    --arg sid "$SESSION_ID" \
    --arg hen "$event" \
    --arg tn  "$tool_name" \
    --arg fp  "$file_path" \
    '{session_id: $sid, hook_event_name: $hen, tool_name: $tn, tool_input: {file_path: $fp}}')
  printf '%s' "$payload" \
    | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "$HOOK" >/dev/null 2>&1
  echo $?
}

# ── (a) PreToolUse + Write targeting state.json → snapshot created ──
echo ""
echo "── T11-a: PreToolUse Write state.json → snapshot created ──"
rm -f "$SNAPSHOT"
_assert_exit "T11-a: exits 0" "0" "$(_run_hook "PreToolUse" "Write" "$STATE_FILE")"
if [[ -f "$SNAPSHOT" ]]; then
  printf 'pass: T11-a: snapshot created at %s\n' "$SNAPSHOT"
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-a: snapshot not created at %s\n' "$SNAPSHOT" >&2
  FAIL=$((FAIL + 1))
fi

# ── (b) PostToolUse after phase change → log.md gets phase-transition line ──
echo ""
echo "── T11-b: PostToolUse after phase change → log.md phase-transition line ──"

# Snapshot is already at "explore" phase (from T11-a)
# Now update state.json to "synthesize"
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" set_field .phase '"synthesize"'

_assert_exit "T11-b: exits 0" "0" "$(_run_hook "PostToolUse" "Write" "$STATE_FILE")"

LOG_CONTENT=$(cat "$LOG_FILE" 2>/dev/null)
if printf '%s' "$LOG_CONTENT" | grep -q 'phase-transition'; then
  printf 'pass: T11-b: phase-transition line in log.md\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-b: no phase-transition line in log.md\n' >&2
  printf '  log.md: %s\n' "$LOG_CONTENT" >&2
  FAIL=$((FAIL + 1))
fi

# Verify it mentions both old and new phase
_assert_contains "T11-b: log mentions 'explore'" "explore" "$LOG_CONTENT"
_assert_contains "T11-b: log mentions 'synthesize'" "synthesize" "$LOG_CONTENT"

# ── (c) PostToolUse with no snapshot → no op, exits 0 ──
echo ""
echo "── T11-c: PostToolUse with no snapshot → no op, exits 0 ──"
rm -f "$SNAPSHOT"
LOG_BEFORE=$(cat "$LOG_FILE")
_assert_exit "T11-c: exits 0" "0" "$(_run_hook "PostToolUse" "Write" "$STATE_FILE")"
LOG_AFTER=$(cat "$LOG_FILE")
if [[ "$LOG_BEFORE" == "$LOG_AFTER" ]]; then
  printf 'pass: T11-c: log.md unchanged when no snapshot\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-c: log.md was modified even with no snapshot\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── (d) Write target not state.json → no op ──
echo ""
echo "── T11-d: Write to different file → no op, exits 0 ──"
OTHER_FILE="${INSTANCE_DIR}/findings.test.md"
# Create snapshot so PostToolUse would fire if it incorrectly matches
cp "$STATE_FILE" "$SNAPSHOT"
LOG_BEFORE=$(cat "$LOG_FILE")
_assert_exit "T11-d: exits 0 for non-state.json target" "0" "$(_run_hook "PreToolUse" "Write" "$OTHER_FILE")"
_assert_exit "T11-d: PostToolUse exits 0 for non-state.json" "0" "$(_run_hook "PostToolUse" "Write" "$OTHER_FILE")"
LOG_AFTER=$(cat "$LOG_FILE")
if [[ "$LOG_BEFORE" == "$LOG_AFTER" ]]; then
  printf 'pass: T11-d: log.md unchanged for non-state.json target\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-d: log.md modified for non-state.json target\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── (e) Dedup: PostToolUse twice for same phase → only one log line ──
echo ""
echo "── T11-e: PostToolUse twice for same phase → only one phase-transition entry ──"

# Reset state to a known phase
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" set_field .phase '"critique"'
# Create snapshot at same phase (no actual transition)
cp "$STATE_FILE" "$SNAPSHOT"
# Now change phase
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" set_field .phase '"deliver"'

# First PostToolUse → should log once
_run_hook "PostToolUse" "Write" "$STATE_FILE" >/dev/null 2>&1

# Recreate snapshot at same state (dedup scenario: same transition repeated)
cp "$STATE_FILE" "$SNAPSHOT"
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" set_field .phase '"deliver"'

# Second PostToolUse with identical transition
_run_hook "PostToolUse" "Write" "$STATE_FILE" >/dev/null 2>&1

LOG_CONTENT=$(cat "$LOG_FILE")
TRANSITION_COUNT=$(_count_lines "critique" "$LOG_CONTENT")
if [[ "$TRANSITION_COUNT" -le 1 ]]; then
  printf 'pass: T11-e: dedup — critique transition appears at most once (%s)\n' "$TRANSITION_COUNT"
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-e: dedup failed — critique transition appeared %s times in log.md\n' "$TRANSITION_COUNT" >&2
  FAIL=$((FAIL + 1))
fi

# ── (f) ADV: bar verdict change (no phase change) → verdict-change line in log.md ──
echo ""
echo "── T11-f (ADV): bar verdict change → verdict-change line in log.md ──"

# Reset to clean snapshot with G1=null
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" merge \
  '{"phase":"deliver","bar":[{"id":"G1","verdict":null},{"id":"G2","verdict":null}]}'
cp "$STATE_FILE" "$SNAPSHOT"

# Update G1 verdict to PASS
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" merge \
  '{"bar":[{"id":"G1","verdict":"PASS"},{"id":"G2","verdict":null}]}'

_assert_exit "T11-f: exits 0" "0" "$(_run_hook "PostToolUse" "Write" "$STATE_FILE")"

LOG_CONTENT=$(cat "$LOG_FILE")
if printf '%s' "$LOG_CONTENT" | grep -q 'bar-verdict\|G1\|PASS'; then
  printf 'pass: T11-f: bar-verdict change captured in log.md\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-f: bar-verdict change not captured (G1: null→PASS)\n' >&2
  printf '  log.md: %s\n' "$LOG_CONTENT" >&2
  FAIL=$((FAIL + 1))
fi

# ── (g) ADV: unknown event name → exits 0 gracefully ──
echo ""
echo "── T11-g (ADV): unknown HOOK_EVENT_NAME → exits 0 ──"
RC_G=$(printf '{"session_id":"%s","hook_event_name":"UnknownEvent","tool_name":"Write","tool_input":{"file_path":"%s"}}' \
  "$SESSION_ID" "$STATE_FILE" \
  | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$HOOK" >/dev/null 2>&1; echo $?)
_assert_exit "T11-g: unknown event exits 0" "0" "$RC_G"

# ── (h) ADV: /tmp not used for snapshots (snapshot must be in instance dir) ──
echo ""
echo "── T11-h (ADV): snapshot location is inside instance dir, not /tmp ──"
rm -f "$SNAPSHOT"
_run_hook "PreToolUse" "Write" "$STATE_FILE" >/dev/null 2>&1
# Snapshot should be in instance dir
if [[ -f "$SNAPSHOT" ]]; then
  printf 'pass: T11-h: snapshot at instance dir path %s\n' "$SNAPSHOT"
  PASS=$((PASS + 1))
else
  # Check if something landed in /tmp instead
  TMP_SNAPS=$(ls /tmp/dw-* 2>/dev/null | head -5)
  printf 'FAIL: T11-h: snapshot not found at %s\n' "$SNAPSHOT" >&2
  if [[ -n "$TMP_SNAPS" ]]; then
    printf '  Found in /tmp instead: %s\n' "$TMP_SNAPS" >&2
  fi
  FAIL=$((FAIL + 1))
fi

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
