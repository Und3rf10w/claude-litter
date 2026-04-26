#!/usr/bin/env bash
# T10-pre-compact.sh — adversarial tests for hooks/pre-compact.sh (G-exec-3)
#
# Written BEFORE implementation to define the contract. Will initially SKIP
# if pre-compact.sh doesn't exist yet.
#
# Test strategy: exercise the four behavioral contracts from the plan:
#   (a) valid session stdin → state.json.last_updated stamped + log.md line appended
#   (b) subagent agent_id → exits 0, no writes
#   (c) session_id with no discoverable instance → exits 0, no writes
#   (d) stdout emits compact instructions pointing at state.json + log.md + instance dir
#
# Exit 0 = all ran cases passed
# Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${PLUGIN_ROOT}/hooks/pre-compact.sh"

if [[ ! -f "$HOOK" ]]; then
  printf 'SKIP: pre-compact.sh not found at %s — G-exec-3 not yet implemented\n' "$HOOK" >&2
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

_assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if ! printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf 'pass: %s (absent "%s")\n' "$name" "$needle"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — unexpectedly found "%s"\n' "$name" "$needle" >&2
    FAIL=$((FAIL + 1))
  fi
}

# ── Fixture setup ──
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

export CLAUDE_PROJECT_DIR="$SANDBOX"
INSTANCE_ID="ab12cd34"
INSTANCE_DIR="$SANDBOX/.claude/deepwork/$INSTANCE_ID"
mkdir -p "$INSTANCE_DIR"

SESSION_ID="test-session-$(date +%s)"

STATE_FILE="$INSTANCE_DIR/state.json" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{
  "session_id": "$SESSION_ID",
  "phase": "explore",
  "team_name": "test-team",
  "frontmatter_schema_version": "1"
}
EOF

printf '# Log\n\n## [2026-01-01] Session started\n' > "$INSTANCE_DIR/log.md"

_build_payload() {
  local session_id="$1" agent_id="${2:-}"
  if [[ -n "$agent_id" ]]; then
    jq -cn --arg sid "$session_id" --arg aid "$agent_id" \
      '{session_id: $sid, agent_id: $aid}'
  else
    jq -cn --arg sid "$session_id" \
      '{session_id: $sid}'
  fi
}

# ── (a) Valid session stdin → state.json.last_updated stamped + log.md line appended ──
echo ""
echo "── T10-a: valid session → stamps last_updated + appends log.md ──"

PAYLOAD_VALID=$(_build_payload "$SESSION_ID")
STDOUT_A=$(printf '%s' "$PAYLOAD_VALID" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_CODE_SESSION_ID="$SESSION_ID" bash "$HOOK" 2>/dev/null)
RC_A=$?
_assert_exit "T10-a: exit 0 on valid session" "0" "$RC_A"

# Check state.json.last_updated was stamped
LAST_UPDATED=$(jq -r '.last_updated // ""' "$INSTANCE_DIR/state.json" 2>/dev/null)
if [[ -n "$LAST_UPDATED" ]]; then
  printf 'pass: T10-a: last_updated stamped (%s)\n' "$LAST_UPDATED"
  PASS=$((PASS + 1))
else
  printf 'FAIL: T10-a: last_updated not written to state.json\n' >&2
  FAIL=$((FAIL + 1))
fi

# Check log.md was appended with a PreCompact line
LOG_CONTENT=$(cat "$INSTANCE_DIR/log.md" 2>/dev/null)
if printf '%s' "$LOG_CONTENT" | grep -q 'PreCompact'; then
  printf 'pass: T10-a: log.md contains PreCompact entry\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T10-a: log.md missing PreCompact entry\n' >&2
  printf '  log.md content: %s\n' "$LOG_CONTENT" >&2
  FAIL=$((FAIL + 1))
fi

# ── (b) Subagent (agent_id present) → exits 0, no writes ──
echo ""
echo "── T10-b: subagent agent_id → exits 0, no writes ──"

# Reset state for clean write detection
BEFORE_MTIME=$(stat -f '%m' "$INSTANCE_DIR/state.json" 2>/dev/null || stat -c '%Y' "$INSTANCE_DIR/state.json" 2>/dev/null)

# Wait a moment to detect mtime change
sleep 1

PAYLOAD_SUBAGENT=$(_build_payload "$SESSION_ID" "subagent-12345")
RC_B=$(printf '%s' "$PAYLOAD_SUBAGENT" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_CODE_SESSION_ID="$SESSION_ID" bash "$HOOK" >/dev/null 2>&1; echo $?)
_assert_exit "T10-b: subagent exits 0" "0" "$RC_B"

AFTER_MTIME=$(stat -f '%m' "$INSTANCE_DIR/state.json" 2>/dev/null || stat -c '%Y' "$INSTANCE_DIR/state.json" 2>/dev/null)
if [[ "$BEFORE_MTIME" == "$AFTER_MTIME" ]]; then
  printf 'pass: T10-b: state.json not modified for subagent\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T10-b: state.json was modified for subagent — must not write\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── (c) Session ID with no discoverable instance → exits 0, no writes ──
echo ""
echo "── T10-c: unknown session_id → exits 0, no writes ──"

UNKNOWN_SESSION="no-such-session-$(date +%s)"
PAYLOAD_UNKNOWN=$(_build_payload "$UNKNOWN_SESSION")
RC_C=$(printf '%s' "$PAYLOAD_UNKNOWN" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_CODE_SESSION_ID="$UNKNOWN_SESSION" bash "$HOOK" >/dev/null 2>&1; echo $?)
_assert_exit "T10-c: unknown session exits 0" "0" "$RC_C"

# ── (d) Stdout emits compact instructions pointing at state.json + log.md + instance dir ──
echo ""
echo "── T10-d: stdout compact instructions mention state.json, log.md, instance dir ──"

STDOUT_D=$(printf '%s' "$PAYLOAD_VALID" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_CODE_SESSION_ID="$SESSION_ID" bash "$HOOK" 2>/dev/null)
_assert_contains "T10-d: stdout mentions state.json" "state.json" "$STDOUT_D"
_assert_contains "T10-d: stdout mentions log.md" "log.md" "$STDOUT_D"
_assert_contains "T10-d: stdout mentions instance dir" "$INSTANCE_DIR" "$STDOUT_D"

# ── (e) ADV: pre-compact fires on non-deepwork session → exits 0 gracefully ──
# The hook is registered in hooks.json (session-agnostic). Must not crash when
# no deepwork session is active (empty CLAUDE_PROJECT_DIR or no instance dir).
echo ""
echo "── T10-e (ADV): non-deepwork session → exits 0 gracefully ──"
EMPTY_SANDBOX=$(mktemp -d)
RC_E=$(printf '{"session_id":"orphan-session"}' \
  | CLAUDE_PROJECT_DIR="$EMPTY_SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_CODE_SESSION_ID="orphan-session" \
    bash "$HOOK" >/dev/null 2>&1; echo $?)
rm -rf "$EMPTY_SANDBOX"
_assert_exit "T10-e: non-deepwork session exits 0" "0" "$RC_E"

# ── (f) ADV: double-fire idempotency — run twice on same session ──
# Second invocation must not corrupt state.json or duplicate log.md lines in
# a way that breaks downstream consumers. last_updated should be updated (later
# timestamp), and log.md should get a second PreCompact entry OR be idempotent.
echo ""
echo "── T10-f (ADV): double-fire idempotency ──"
RC_F=$(printf '%s' "$PAYLOAD_VALID" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" CLAUDE_CODE_SESSION_ID="$SESSION_ID" bash "$HOOK" >/dev/null 2>&1; echo $?)
_assert_exit "T10-f: second fire exits 0" "0" "$RC_F"
# state.json must still be valid JSON
if jq -e . "$INSTANCE_DIR/state.json" >/dev/null 2>&1; then
  printf 'pass: T10-f: state.json still valid JSON after double-fire\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T10-f: state.json corrupted after double-fire\n' >&2
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
