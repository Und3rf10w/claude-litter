#!/usr/bin/env bash
# test-batch-gate.sh — regression tests for batch-gate.sh (W3-b PostToolBatch consolidation)
#
# BG-a: no active instance → exits 0 (fail-open)
# BG-b: batch_gate_enabled=false in state.json → exits 0, log.md unchanged
# BG-c: Write to state.json with phase change → phase-transition marker appended to log.md
# BG-d: Write to state.json with bar verdict change → bar-verdict marker appended to log.md
#
# Exit 0 = all pass; Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
BATCH_GATE="${PLUGIN_ROOT}/hooks/batch-gate.sh"
STATE_TRANSITION="${PLUGIN_ROOT}/scripts/state-transition.sh"

if [[ ! -x "$BATCH_GATE" ]]; then
  printf 'SKIP: batch-gate.sh not found or not executable at %s\n' "$BATCH_GATE" >&2
  exit 0
fi

PASS=0
FAIL=0

_pass() { printf 'pass: %s\n' "$1"; PASS=$((PASS + 1)); }
_fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

_assert_exit() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    _pass "${name} (exit=${actual})"
  else
    _fail "${name} — expected exit ${expected}, got ${actual}"
  fi
}

_assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    _pass "${name}"
  else
    _fail "${name} — did not find \"${needle}\""
  fi
}

_assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if ! printf '%s' "$haystack" | grep -qF -- "$needle"; then
    _pass "${name}"
  else
    _fail "${name} — unexpectedly found \"${needle}\""
  fi
}

SANDBOX=$(mktemp -d)
SANDBOX="$(cd "$SANDBOX" && pwd -P)"
trap 'rm -rf "$SANDBOX"' EXIT

# ── BG-a: no active instance → exits 0 (fail-open) ───────────────────────────
echo ""
echo "── BG-a: no active instance → exits 0 (fail-open) ──"

BG_A_INPUT='{"session_id":"bg-a-no-instance","tool_calls":[]}'
BG_A_RC=0
printf '%s' "$BG_A_INPUT" | \
  CLAUDE_PROJECT_DIR="$SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  bash "$BATCH_GATE" >/dev/null 2>&1 || BG_A_RC=$?
_assert_exit "BG-a: no instance exits 0" "0" "$BG_A_RC"

# ── BG-b: batch_gate_enabled=false → exits 0, no side effects ────────────────
echo ""
echo "── BG-b: batch_gate_enabled=false → exits 0 without processing ──"

BGA_INSTANCE_DIR="${SANDBOX}/.claude/deepwork/b9c8d7e6"
mkdir -p "$BGA_INSTANCE_DIR"
BGA_STATE="${BGA_INSTANCE_DIR}/state.json"
BGA_LOG="${BGA_INSTANCE_DIR}/log.md"
BGA_SID="bg-b-session-$(date +%s)"

"$STATE_TRANSITION" --state-file "$BGA_STATE" init \
  "{\"session_id\":\"${BGA_SID}\",\"phase\":\"scope\",\"team_name\":\"bg-b-team\",\"batch_gate_enabled\":false}" 2>/dev/null
printf '# log\n' > "$BGA_LOG"

BGA_BEFORE=$(cat "$BGA_LOG")
BGA_TOOL_CALLS=$(printf '[{"tool_name":"Write","tool_input":{"file_path":"%s"}}]' "$BGA_STATE")
BGA_INPUT=$(printf '{"session_id":"%s","tool_calls":%s}' "$BGA_SID" "$BGA_TOOL_CALLS")

BGA_RC=0
printf '%s' "$BGA_INPUT" | \
  CLAUDE_PROJECT_DIR="$SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  bash "$BATCH_GATE" >/dev/null 2>&1 || BGA_RC=$?
_assert_exit "BG-b: batch_gate_enabled=false exits 0" "0" "$BGA_RC"

BGA_AFTER=$(cat "$BGA_LOG")
if [[ "$BGA_BEFORE" == "$BGA_AFTER" ]]; then
  _pass "BG-b: log.md unchanged when batch_gate_enabled=false"
else
  _fail "BG-b: log.md modified despite batch_gate_enabled=false"
fi

# ── BG-c: Write to state.json with phase change → phase-transition in log.md ──
echo ""
echo "── BG-c: Write to state.json with phase change → phase-transition marker in log.md ──"

BGC_INSTANCE_DIR="${SANDBOX}/.claude/deepwork/1a2b3c4d"
mkdir -p "$BGC_INSTANCE_DIR"
BGC_STATE="${BGC_INSTANCE_DIR}/state.json"
BGC_SNAPSHOT="${BGC_INSTANCE_DIR}/.state-snapshot"
BGC_LOG="${BGC_INSTANCE_DIR}/log.md"
BGC_SID="bg-c-session-$(date +%s)"

"$STATE_TRANSITION" --state-file "$BGC_STATE" init \
  "{\"session_id\":\"${BGC_SID}\",\"phase\":\"scope\",\"team_name\":\"bg-c-team\"}" 2>/dev/null
printf '# log\n' > "$BGC_LOG"

# Create snapshot with old phase (scope)
cp "$BGC_STATE" "$BGC_SNAPSHOT"

# Advance state to explore (simulates state-transition.sh write)
"$STATE_TRANSITION" --state-file "$BGC_STATE" phase_advance --to "explore" 2>/dev/null

BGC_TOOL_CALLS=$(printf '[{"tool_name":"Write","tool_input":{"file_path":"%s"}}]' "$BGC_STATE")
BGC_INPUT=$(printf '{"session_id":"%s","tool_calls":%s}' "$BGC_SID" "$BGC_TOOL_CALLS")

BGC_RC=0
printf '%s' "$BGC_INPUT" | \
  CLAUDE_PROJECT_DIR="$SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  bash "$BATCH_GATE" >/dev/null 2>&1 || BGC_RC=$?
_assert_exit "BG-c: exits 0 with phase transition" "0" "$BGC_RC"

BGC_LOG_CONTENT=$(cat "$BGC_LOG" 2>/dev/null)
_assert_contains "BG-c: phase-transition marker in log.md" "phase-transition" "$BGC_LOG_CONTENT"
_assert_contains "BG-c: scope → explore in log.md" "scope → explore" "$BGC_LOG_CONTENT"

if [[ ! -f "$BGC_SNAPSHOT" ]]; then
  _pass "BG-c: .state-snapshot removed after processing"
else
  _fail "BG-c: .state-snapshot still present after processing"
fi

# ── BG-d: Write to state.json with bar verdict change → bar-verdict in log.md ──
echo ""
echo "── BG-d: bar verdict change → bar-verdict marker in log.md ──"

BGD_INSTANCE_DIR="${SANDBOX}/.claude/deepwork/5e6f7a8b"
mkdir -p "$BGD_INSTANCE_DIR"
BGD_STATE="${BGD_INSTANCE_DIR}/state.json"
BGD_SNAPSHOT="${BGD_INSTANCE_DIR}/.state-snapshot"
BGD_LOG="${BGD_INSTANCE_DIR}/log.md"
BGD_SID="bg-d-session-$(date +%s)"

"$STATE_TRANSITION" --state-file "$BGD_STATE" init \
  "{\"session_id\":\"${BGD_SID}\",\"phase\":\"scope\",\"team_name\":\"bg-d-team\",\"bar\":[{\"id\":\"B1\",\"criterion\":\"test\",\"verdict\":null}]}" 2>/dev/null
printf '# log\n' > "$BGD_LOG"

# Snapshot the current state (bar[0].verdict = null)
cp "$BGD_STATE" "$BGD_SNAPSHOT"

# Merge a verdict update into state.json
"$STATE_TRANSITION" --state-file "$BGD_STATE" merge \
  '{"bar":[{"id":"B1","criterion":"test","verdict":"APPROVED"}]}' 2>/dev/null

BGD_TOOL_CALLS=$(printf '[{"tool_name":"Write","tool_input":{"file_path":"%s"}}]' "$BGD_STATE")
BGD_INPUT=$(printf '{"session_id":"%s","tool_calls":%s}' "$BGD_SID" "$BGD_TOOL_CALLS")

BGD_RC=0
printf '%s' "$BGD_INPUT" | \
  CLAUDE_PROJECT_DIR="$SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
  bash "$BATCH_GATE" >/dev/null 2>&1 || BGD_RC=$?
_assert_exit "BG-d: exits 0 with bar verdict change" "0" "$BGD_RC"

BGD_LOG_CONTENT=$(cat "$BGD_LOG" 2>/dev/null)
_assert_contains "BG-d: bar-verdict marker in log.md" "bar-verdict" "$BGD_LOG_CONTENT"
_assert_contains "BG-d: B1 in bar-verdict marker" "B1" "$BGD_LOG_CONTENT"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "── Results: ${PASS} passed, ${FAIL} failed ──"
[[ $FAIL -eq 0 ]] || exit 1
