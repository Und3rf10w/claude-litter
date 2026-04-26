#!/usr/bin/env bash
# T11-scope-gate.sh — regression tests for hooks/execute/task-scope-gate.sh (W15 #27)
#
# TSG-a: no plan_ref in state → exit 0 (fail-open)
# TSG-b: task subject matches plan content → exit 0
# TSG-c: no match, advisory mode (default) → exit 0 + discovery appended
# TSG-d: no match, strict mode (scope_gate_strict=true) → exit 2
#
# Exit 0 = all cases passed
# Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${PLUGIN_ROOT}/hooks/execute/task-scope-gate.sh"
STATE_TRANSITION="${PLUGIN_ROOT}/scripts/state-transition.sh"

if [[ ! -f "$HOOK" ]]; then
  printf 'SKIP: task-scope-gate.sh not found at %s\n' "$HOOK" >&2
  exit 0
fi

PASS=0
FAIL=0
FAILED_CASES=()

_pass() { printf 'pass: %s\n' "$1"; PASS=$((PASS + 1)); }
_fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); FAILED_CASES+=("$1"); }

_assert_exit() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    _pass "${name} (exit=${actual})"
  else
    _fail "${name} — expected exit ${expected}, got ${actual}"
  fi
}

SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

SESSION_ID="tsg-session-$$"
INSTANCE_ID="aabbccdd"
INSTANCE_DIR="${SANDBOX}/.claude/deepwork/${INSTANCE_ID}"
mkdir -p "$INSTANCE_DIR"
STATE_FILE="${INSTANCE_DIR}/state.json"

# Bootstrap a minimal execute-mode state
"$STATE_TRANSITION" --state-file "$STATE_FILE" init \
  "{\"session_id\":\"${SESSION_ID}\",\"phase\":\"execute\",\"team_name\":\"tsg-team\",\"mode\":\"execute\"}" 2>/dev/null
"$STATE_TRANSITION" --state-file "$STATE_FILE" set_field '.execute.phase' '"write"' 2>/dev/null

# Write a minimal plan file for scope matching
PLAN_FILE="${SANDBOX}/plan.md"
cat > "$PLAN_FILE" <<'PLANEOF'
# Test Plan

## Gate 1: implement authentication middleware

- Add JWT validation to the request handler
- Write unit tests for token parsing
- Update the API documentation
PLANEOF

export CLAUDE_PROJECT_DIR="$SANDBOX"
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"

# ── TSG-a: no plan_ref → fail-open, exit 0 ───────────────────────────────────
echo ""
echo "── TSG-a: no plan_ref → fail-open, exit 0 ──"

# State has no plan_ref set — hook must exit 0 (fail-open; can't check without plan)
TSGA_RC=99
printf '{"session_id":"%s","task_id":"1","task_subject":"implement authentication middleware","task_description":"","team_name":"tsg-team"}' \
  "$SESSION_ID" | bash "$HOOK" 2>/dev/null
TSGA_RC=$?
_assert_exit "TSG-a: no plan_ref → exit 0" "0" "$TSGA_RC"

# ── TSG-b: task subject matches plan → exit 0 ────────────────────────────────
echo ""
echo "── TSG-b: task matches plan → exit 0 ──"

"$STATE_TRANSITION" --state-file "$STATE_FILE" set_field '.execute.plan_ref' "\"${PLAN_FILE}\"" 2>/dev/null

TSGB_RC=99
printf '{"session_id":"%s","task_id":"2","task_subject":"implement authentication middleware","task_description":"","team_name":"tsg-team"}' \
  "$SESSION_ID" | bash "$HOOK" 2>/dev/null
TSGB_RC=$?
_assert_exit "TSG-b: matching subject → exit 0" "0" "$TSGB_RC"

# ── TSG-c: no match, advisory mode → exit 0 + discovery appended ─────────────
echo ""
echo "── TSG-c: no match, advisory mode → exit 0 + discovery appended ──"

# Ensure scope_gate_strict is false (default)
"$STATE_TRANSITION" --state-file "$STATE_FILE" set_field '.execute.scope_gate_strict' 'false' 2>/dev/null

TSGC_STDERR=$(mktemp)
TSGC_RC=99
printf '{"session_id":"%s","task_id":"3","task_subject":"deploy kubernetes cluster","task_description":"","team_name":"tsg-team"}' \
  "$SESSION_ID" | bash "$HOOK" 2>"$TSGC_STDERR"
TSGC_RC=$?
_assert_exit "TSG-c: no match, advisory → exit 0" "0" "$TSGC_RC"

if grep -q 'WARNING\|scope-gate\|scope_gate\|scope' "$TSGC_STDERR" 2>/dev/null; then
  _pass "TSG-c: advisory warning emitted on stderr"
else
  _fail "TSG-c: expected advisory WARNING on stderr, got none"
fi

DISCOVERY_FILE="${INSTANCE_DIR}/discoveries.jsonl"
if [[ -f "$DISCOVERY_FILE" ]]; then
  TSGC_DISC_COUNT=$(grep -c '"type".*"scope-delta"' "$DISCOVERY_FILE" 2>/dev/null || echo "0")
  if [[ "$TSGC_DISC_COUNT" -ge 1 ]]; then
    _pass "TSG-c: discovery entry appended (count=${TSGC_DISC_COUNT})"
  else
    _fail "TSG-c: discovery file exists but no scope-delta entry found"
  fi
else
  _fail "TSG-c: discoveries.jsonl not created by advisory-mode scope miss"
fi
rm -f "$TSGC_STDERR"

# ── TSG-d: no match, strict mode → exit 2 ────────────────────────────────────
echo ""
echo "── TSG-d: no match, strict mode → exit 2 ──"

"$STATE_TRANSITION" --state-file "$STATE_FILE" set_field '.execute.scope_gate_strict' 'true' 2>/dev/null

TSGD_STDERR=$(mktemp)
TSGD_RC=99
printf '{"session_id":"%s","task_id":"4","task_subject":"deploy kubernetes cluster","task_description":"","team_name":"tsg-team"}' \
  "$SESSION_ID" | bash "$HOOK" 2>"$TSGD_STDERR"
TSGD_RC=$?
_assert_exit "TSG-d: no match, strict → exit 2" "2" "$TSGD_RC"

if grep -q 'BLOCKED\|scope-gate\|scope_gate\|scope' "$TSGD_STDERR" 2>/dev/null; then
  _pass "TSG-d: BLOCKED message emitted on stderr"
else
  _fail "TSG-d: expected BLOCKED message on stderr, got none"
fi
rm -f "$TSGD_STDERR"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "── Results: ${PASS} passed, ${FAIL} failed ──"
if (( FAIL > 0 )); then
  printf 'Failed cases:\n'
  for c in "${FAILED_CASES[@]}"; do
    printf '  - %s\n' "$c"
  done
  exit 1
fi
exit 0
