#!/usr/bin/env bash
# test-integrity-always.sh — regression tests for hooks/integrity-always-gate.sh (W9 M1)
#
# Cases IA-a through IA-e verify the always-on event_head integrity gate.
# Exit 0 = all cases passed.
# Exit 1 = one or more cases failed.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GATE="${PLUGIN_ROOT}/hooks/integrity-always-gate.sh"

if [[ ! -f "$GATE" ]]; then
  printf 'SKIP: integrity-always-gate.sh not found at %s\n' "$GATE" >&2
  exit 0
fi

command -v jq >/dev/null 2>&1 || { printf 'SKIP: jq not found\n' >&2; exit 0; }

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

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

export CLAUDE_PROJECT_DIR="$SANDBOX"
INSTANCE_ID="ab12cd34"
INSTANCE_DIR="$SANDBOX/.claude/deepwork/$INSTANCE_ID"
mkdir -p "$INSTANCE_DIR"

SESSION_ID="test-ia-$(date +%s)"

STATE_FILE="${INSTANCE_DIR}/state.json" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{
  "session_id": "$SESSION_ID",
  "phase": "explore",
  "team_name": "test-team"
}
EOF

_run_gate() {
  local tool_name="${1:-Write}"
  local payload
  payload=$(jq -cn --arg sid "$SESSION_ID" --arg tn "$tool_name" '{session_id: $sid, hook_event_name: "PreToolUse", tool_name: $tn, tool_input: {}}')
  printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$GATE" >/dev/null 2>&1
  echo $?
}

# ── IA-a: No active instance → fail-open (exit 0) ──
echo ""
echo "── IA-a: No active instance → fail-open (exit 0) ──"
UNSET_SESSION="no-such-session-$(date +%s)"
payload=$(jq -cn --arg sid "$UNSET_SESSION" '{session_id: $sid, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {}}')
result=$(printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$GATE" >/dev/null 2>&1; echo $?)
_assert_exit "IA-a: no instance fail-open" "0" "$result"

# ── IA-b: Active instance, no event_head in state.json → pass (pre-W7 compat) ──
echo ""
echo "── IA-b: Active instance, no event_head → pass (exit 0) ──"
_assert_exit "IA-b: no event_head pass" "0" "$(_run_gate "Write")"

# ── IA-c: event_head present, events.jsonl missing → blocked (exit 2) ──
echo ""
echo "── IA-c: event_head present but events.jsonl absent → blocked (exit 2) ──"
STATE_FILE="${INSTANCE_DIR}/state.json"
# Inject a fake event_head without a corresponding events.jsonl
tmp="${STATE_FILE}.tmp.$$"
jq '.event_head = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef"' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
rm -f "${INSTANCE_DIR}/events.jsonl"
_assert_exit "IA-c: missing events.jsonl blocked" "2" "$(_run_gate "Write")"

# ── IA-d: event_head matches tail of events.jsonl → pass (exit 0) ──
echo ""
echo "── IA-d: Consistent event_head and events.jsonl → pass (exit 0) ──"
LAST_LINE='{"type":"test","id":"e1"}'
printf '%s\n' "$LAST_LINE" > "${INSTANCE_DIR}/events.jsonl"
if command -v sha256sum >/dev/null 2>&1; then
  CORRECT_HEAD=$(printf '%s\n' "$LAST_LINE" | sha256sum | cut -d' ' -f1)
else
  CORRECT_HEAD=$(printf '%s\n' "$LAST_LINE" | shasum -a 256 | cut -d' ' -f1)
fi
tmp="${STATE_FILE}.tmp.$$"
jq --arg h "$CORRECT_HEAD" '.event_head = $h' "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
_assert_exit "IA-d: matching event_head pass" "0" "$(_run_gate "Write")"

# ── IA-e: event_head mismatches tail of events.jsonl → blocked (exit 2) ──
echo ""
echo "── IA-e: Mismatched event_head vs events.jsonl tail → blocked (exit 2) ──"
printf '%s\n' '{"type":"tampered","id":"e2"}' >> "${INSTANCE_DIR}/events.jsonl"
# event_head still points to old line — now a mismatch
_assert_exit "IA-e: mismatched event_head blocked" "2" "$(_run_gate "Bash")"

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
