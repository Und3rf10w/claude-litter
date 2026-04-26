#!/usr/bin/env bash
# test-state-bash-gate.sh — regression tests for W8 H2: state-bash-gate hook.
#
# SBG-a: `bash -c 'echo {} > state.json'`           → blocked (exit 2)
# SBG-b: `cp /tmp/x.json state.json`                → blocked (exit 2)
# SBG-c: `bash scripts/state-transition.sh phase_advance --to synthesize` → allowed (exit 0)
# SBG-d: command not touching state.json            → allowed (exit 0)
# SBG-e: `grep state.json README.md` (no redirect)  → allowed (exit 0)
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

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "── Results: ${PASS} passed, ${FAIL} failed ──"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
