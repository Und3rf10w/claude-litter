#!/usr/bin/env bash
# test-state-bash-gate.sh — regression tests for W8 H2: state-bash-gate hook.
#
# SBG-a: `bash -c 'echo {} > state.json'`           → blocked (exit 2)
# SBG-b: `cp /tmp/x.json state.json`                → blocked (exit 2)
# SBG-c: `bash scripts/state-transition.sh phase_advance --to synthesize` → allowed (exit 0)
# SBG-d: command not touching state.json            → allowed (exit 0)
# SBG-e: `grep state.json README.md` (no redirect)  → allowed (exit 0)
# SBG-l: pending-change.json write emits EXIT_PENDING_CHANGE_DIRECT_WRITE error
#
# Exit 0 = all pass; Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GATE="${PLUGIN_ROOT}/hooks/state-bash-gate.sh"

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

_run_gate() {
  local cmd="$1"
  local payload
  payload=$(jq -cn --arg cmd "$cmd" '{tool_name: "Bash", tool_input: {command: $cmd}}')
  printf '%s' "$payload" | bash "$GATE" 2>/dev/null
  printf '%d' $?
}

# ── SBG-a: redirect write → blocked ─────────────────────────────────────────
echo ""
echo "── SBG-a: echo {} > state.json → blocked ──"
RC=$(_run_gate "bash -c 'echo {} > state.json'")
_assert_exit "SBG-a" "2" "$RC"

# ── SBG-b: cp overwrite → blocked ───────────────────────────────────────────
echo ""
echo "── SBG-b: cp /tmp/x.json state.json → blocked ──"
RC=$(_run_gate "cp /tmp/x.json state.json")
_assert_exit "SBG-b" "2" "$RC"

# ── SBG-c: state-transition.sh invocation → allowed ─────────────────────────
echo ""
echo "── SBG-c: bash scripts/state-transition.sh phase_advance → allowed ──"
RC=$(_run_gate "bash scripts/state-transition.sh phase_advance --to synthesize")
_assert_exit "SBG-c" "0" "$RC"

# ── SBG-d: unrelated command → allowed ──────────────────────────────────────
echo ""
echo "── SBG-d: unrelated command (ls -la) → allowed ──"
RC=$(_run_gate "ls -la")
_assert_exit "SBG-d" "0" "$RC"

# ── SBG-e: mention of state.json in string, no redirect → allowed ────────────
echo ""
echo "── SBG-e: grep state.json README.md (no redirect) → allowed ──"
RC=$(_run_gate "grep state.json README.md")
_assert_exit "SBG-e" "0" "$RC"

# ── SBG-f: events.jsonl redirect → blocked ──────────────────────────────────
echo ""
echo "── SBG-f: echo line >> events.jsonl → blocked ──"
RC=$(_run_gate "echo '{\"event_type\":\"x\"}' >> events.jsonl")
_assert_exit "SBG-f" "2" "$RC"

# ── SBG-g: pending-change.json redirect → blocked ───────────────────────────
echo ""
echo "── SBG-g: echo {} > pending-change.json → blocked ──"
RC=$(_run_gate "echo '{}' > pending-change.json")
_assert_exit "SBG-g" "2" "$RC"

# ── SBG-h: incidents.jsonl mv → blocked ─────────────────────────────────────
echo ""
echo "── SBG-h: mv /tmp/x.jsonl incidents.jsonl → blocked ──"
RC=$(_run_gate "mv /tmp/x.jsonl incidents.jsonl")
_assert_exit "SBG-h" "2" "$RC"

# ── SBG-i: test-results.jsonl — test-capture.sh writer → allowed ────────────
echo ""
echo "── SBG-i: bash .../test-capture.sh → allowed ──"
RC=$(_run_gate "bash /path/to/plugins/deepwork/hooks/execute/test-capture.sh")
_assert_exit "SBG-i" "0" "$RC"

# ── SBG-j: override-tokens.json redirect → blocked ──────────────────────────
echo ""
echo "── SBG-j: echo {} > override-tokens.json → blocked ──"
RC=$(_run_gate "echo '{}' > override-tokens.json")
_assert_exit "SBG-j" "2" "$RC"

# ── SBG-k: hook-timing.jsonl tee → blocked ──────────────────────────────────
echo ""
echo "── SBG-k: tee hook-timing.jsonl → blocked ──"
RC=$(_run_gate "echo '{}' | tee hook-timing.jsonl")
_assert_exit "SBG-k" "2" "$RC"

# ── SBG-l: pending-change.json write emits discriminated error ───────────────
echo ""
echo "── SBG-l: cat > pending-change.json emits EXIT_PENDING_CHANGE_DIRECT_WRITE ──"
SBG_L_ERR=$(printf '%s' \
  "$(jq -cn --arg cmd "cat > .claude/deepwork/abc/pending-change.json <<EOF
{}
EOF" '{tool_name:"Bash",tool_input:{command:$cmd}}')" \
  | bash "$GATE" 2>&1)
SBG_L_RC=$?
_assert_exit "SBG-l: blocked (exit 2)" "2" "$SBG_L_RC"
if printf '%s' "$SBG_L_ERR" | grep -q "EXIT_PENDING_CHANGE_DIRECT_WRITE"; then
  _pass "SBG-l: EXIT_PENDING_CHANGE_DIRECT_WRITE in stderr"
else
  _fail "SBG-l: EXIT_PENDING_CHANGE_DIRECT_WRITE not found in stderr: ${SBG_L_ERR}"
fi
if printf '%s' "$SBG_L_ERR" | grep -q "pending_change_set"; then
  _pass "SBG-l: pending_change_set instruction present in stderr"
else
  _fail "SBG-l: pending_change_set instruction missing from stderr: ${SBG_L_ERR}"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "── Results: ${PASS} passed, ${FAIL} failed ──"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
