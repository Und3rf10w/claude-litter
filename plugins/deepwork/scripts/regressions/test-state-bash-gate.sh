#!/usr/bin/env bash
# test-state-bash-gate.sh — regression tests for W8 H2: state-bash-gate hook.
#
# SBG-a: `bash -c 'echo {} > state.json'`           → blocked (exit 2)
# SBG-b: `cp /tmp/x.json state.json`                → blocked (exit 2)
# SBG-c: `bash scripts/state-transition.sh phase_advance --to synthesize` → allowed (exit 0)
# SBG-d: command not touching state.json            → allowed (exit 0)
# SBG-e: `grep state.json README.md` (no redirect)  → allowed (exit 0)
# SBG-f: `echo line >> events.jsonl`                → blocked (exit 2)
# SBG-g: `echo {} > pending-change.json`            → blocked (exit 2)
# SBG-h: `mv /tmp/x.jsonl incidents.jsonl`          → blocked (exit 2)
# SBG-i: `bash .../test-capture.sh`                 → allowed (exit 0)
# SBG-j: `echo {} > override-tokens.json`           → blocked (exit 2)
# SBG-k: `tee hook-timing.jsonl`                    → blocked (exit 2)
# SBG-l: pending-change.json write emits EXIT_PENDING_CHANGE_DIRECT_WRITE error
# SBG-design-1: design-mode instance (no .execute) blocks state.json write (W21 #2)
# SBG-design-2: no active instance → gate exits 0 (fail-open per active-instance guard)
# SBG-m: bash state-transition.sh; > state.json   (semicolon)   → blocked (exit 2) (W22)
# SBG-n: bash state-transition.sh && > state.json (and-list)    → blocked (exit 2) (W22)
# SBG-o: bash state-transition.sh `... > state.json` (backtick) → blocked (exit 2) (W22)
# SBG-p: bash state-transition.sh $(... > state.json) (dollar)  → blocked (exit 2) (W22)
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

# ── Shared sandbox: active instance so discover_instance() resolves ──
# W20-h added an active-instance guard (fail-open when no instance active).
# Post-W21 #2: guard fires for any active instance regardless of mode (design or
# execute). See SBG-design-1/2 below for the cross-mode coverage cases.
SBG_SANDBOX=$(mktemp -d)
SBG_SESSION="sbg-test-$$-${RANDOM}"
SBG_INST_DIR="${SBG_SANDBOX}/.claude/deepwork/deadbeef"
mkdir -p "$SBG_INST_DIR"
printf '{"session_id":"%s","phase":"execute","execute":{"phase":"execute"}}\n' "$SBG_SESSION" \
  > "${SBG_INST_DIR}/state.json"
export CLAUDE_PROJECT_DIR="$SBG_SANDBOX"
export CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT"
trap 'rm -rf "$SBG_SANDBOX"' EXIT

_run_gate() {
  local cmd="$1"
  local payload
  payload=$(jq -cn --arg cmd "$cmd" --arg sid "$SBG_SESSION" \
    '{tool_name: "Bash", session_id: $sid, tool_input: {command: $cmd}}')
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
EOF" --arg sid "$SBG_SESSION" '{tool_name:"Bash",session_id:$sid,tool_input:{command:$cmd}}')" \
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

# ── SBG-design-1: design-mode instance blocks state.json redirect (W21 #2) ──
# State has top-level .phase but NO .execute subobject. Pre-W21 the EXEC_PHASE
# guard would exit 0 here, leaving design-mode audit-trail unprotected.
echo ""
echo "── SBG-design-1: design-mode instance — echo > state.json blocked ──"
SBG_DESIGN_SESSION="sbg-design-$$-${RANDOM}"
SBG_DESIGN_INST_DIR="${SBG_SANDBOX}/.claude/deepwork/decafbad"
mkdir -p "$SBG_DESIGN_INST_DIR"
printf '{"session_id":"%s","phase":"explore"}\n' "$SBG_DESIGN_SESSION" \
  > "${SBG_DESIGN_INST_DIR}/state.json"
SBG_DESIGN_PAYLOAD=$(jq -cn --arg cmd "echo {} > state.json" --arg sid "$SBG_DESIGN_SESSION" \
  '{tool_name:"Bash",session_id:$sid,tool_input:{command:$cmd}}')
SBG_DESIGN_RC=$(printf '%s' "$SBG_DESIGN_PAYLOAD" | bash "$GATE" 2>/dev/null; printf '%d' $?)
_assert_exit "SBG-design-1" "2" "$SBG_DESIGN_RC"

# ── SBG-design-2: no active instance → gate exits 0 (active-instance guard) ──
echo ""
echo "── SBG-design-2: no active instance — gate fails open ──"
SBG_GHOST_PAYLOAD=$(jq -cn --arg cmd "echo {} > state.json" --arg sid "ghost-session-no-such-inst" \
  '{tool_name:"Bash",session_id:$sid,tool_input:{command:$cmd}}')
SBG_GHOST_RC=$(printf '%s' "$SBG_GHOST_PAYLOAD" | bash "$GATE" 2>/dev/null; printf '%d' $?)
_assert_exit "SBG-design-2" "0" "$SBG_GHOST_RC"

# ── SBG-m..p: allowlist compound-command bypass vectors (W20-h fix, W22 tests) ──
# W20-h's token-scan extension blocks any command that matches the allowlist
# (bash state-transition.sh) AND ALSO contains a protected-file write pattern
# anywhere else in the command. These 4 tests lock in the 4 confirmed bypass
# vectors so a regression to the simpler regex-only allowlist would fail.
echo ""
echo "── SBG-m: allowlist + semicolon → blocked (exit 2) ──"
RC=$(_run_gate "bash scripts/state-transition.sh init -; > state.json")
_assert_exit "SBG-m" "2" "$RC"

echo ""
echo "── SBG-n: allowlist + and-list → blocked (exit 2) ──"
RC=$(_run_gate "bash scripts/state-transition.sh init - && > state.json")
_assert_exit "SBG-n" "2" "$RC"

echo ""
echo "── SBG-o: allowlist + backtick subshell → blocked (exit 2) ──"
RC=$(_run_gate 'bash scripts/state-transition.sh init - `echo > state.json`')
_assert_exit "SBG-o" "2" "$RC"

echo ""
echo "── SBG-p: allowlist + dollar-paren subshell → blocked (exit 2) ──"
RC=$(_run_gate 'bash scripts/state-transition.sh init - $(echo > state.json)')
_assert_exit "SBG-p" "2" "$RC"

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "── Results: ${PASS} passed, ${FAIL} failed ──"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
