#!/usr/bin/env bash
# test-worktree-cd-warn.sh — regression tests for W18-e: worktree-cd-warn hook.
#
# WCD-a: write-class command with worktree path, no cd-prefix → WORKTREE-DISCIPLINE WARNING in stderr, exit 0
# WCD-b: write-class command with proper cd /abs/path/.claude/worktrees/<seg> && ... → no warning, exit 0
# WCD-c: read-only command (cat, ls) referencing worktree path → no warning, exit 0
# WCD-d: malformed JSON stdin → exit 0 (fail-open)
# WCD-e: command referencing wrong worktree segment in cd vs body → warning emitted
#
# Exit 0 = all pass; Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${PLUGIN_ROOT}/hooks/execute/worktree-cd-warn.sh"

PASS=0
FAIL=0

_pass() { printf 'pass: %s\n' "$1"; PASS=$((PASS + 1)); }
_fail() { printf 'FAIL: %s\n' "$1" >&2; FAIL=$((FAIL + 1)); }

_run_hook() {
  local cmd="$1"
  local payload
  payload=$(jq -cn --arg cmd "$cmd" '{tool_name: "Bash", hook_event_name: "PreToolUse", session_id: "test-session", tool_input: {command: $cmd}}')
  printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" 2>&1
  return $?
}

_run_hook_stderr() {
  local cmd="$1"
  local payload
  payload=$(jq -cn --arg cmd "$cmd" '{tool_name: "Bash", hook_event_name: "PreToolUse", session_id: "test-session", tool_input: {command: $cmd}}')
  printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" 2>&1 1>/dev/null
  return $?
}

_run_hook_exit() {
  local cmd="$1"
  local payload
  payload=$(jq -cn --arg cmd "$cmd" '{tool_name: "Bash", hook_event_name: "PreToolUse", session_id: "test-session", tool_input: {command: $cmd}}')
  printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" 2>/dev/null
  printf '%d' $?
}

# ── WCD-a: write-class cmd with worktree path, no cd-prefix → warning ─────────
echo ""
echo "── WCD-a: cp file .claude/worktrees/pair-1/dst — no cd-prefix → warning, exit 0 ──"
WCD_A_OUT=$(_run_hook "cp /tmp/myfile.txt /home/user/.claude/worktrees/pair-1/proposals/v1.md")
WCD_A_RC=$?
if [[ $WCD_A_RC -eq 0 ]]; then
  _pass "WCD-a: exit 0"
else
  _fail "WCD-a: expected exit 0, got $WCD_A_RC"
fi
if printf '%s' "$WCD_A_OUT" | grep -q "WORKTREE-DISCIPLINE WARNING"; then
  _pass "WCD-a: WORKTREE-DISCIPLINE WARNING in output"
else
  _fail "WCD-a: WORKTREE-DISCIPLINE WARNING not found in output: ${WCD_A_OUT}"
fi

# ── WCD-b: write-class cmd with proper cd-prefix → no warning ──────────────────
echo ""
echo "── WCD-b: cd /abs/path/.claude/worktrees/pair-1 && cp file dst → no warning, exit 0 ──"
WCD_B_OUT=$(_run_hook "cd /abs/path/.claude/worktrees/pair-1 && cp /tmp/myfile.txt proposals/v1.md")
WCD_B_RC=$?
if [[ $WCD_B_RC -eq 0 ]]; then
  _pass "WCD-b: exit 0"
else
  _fail "WCD-b: expected exit 0, got $WCD_B_RC"
fi
if printf '%s' "$WCD_B_OUT" | grep -q "WORKTREE-DISCIPLINE WARNING"; then
  _fail "WCD-b: unexpected WORKTREE-DISCIPLINE WARNING in output: ${WCD_B_OUT}"
else
  _pass "WCD-b: no warning emitted"
fi

# ── WCD-c: read-only command referencing worktree path → no warning ─────────────
echo ""
echo "── WCD-c: cat .claude/worktrees/pair-1/state.json → no warning, exit 0 ──"
WCD_C_OUT=$(_run_hook "cat /home/user/.claude/worktrees/pair-1/state.json")
WCD_C_RC=$?
if [[ $WCD_C_RC -eq 0 ]]; then
  _pass "WCD-c: exit 0"
else
  _fail "WCD-c: expected exit 0, got $WCD_C_RC"
fi
if printf '%s' "$WCD_C_OUT" | grep -q "WORKTREE-DISCIPLINE WARNING"; then
  _fail "WCD-c: unexpected warning for read-only command: ${WCD_C_OUT}"
else
  _pass "WCD-c: no warning for read-only command"
fi

# ls is also read-only
echo ""
echo "── WCD-c2: ls .claude/worktrees/w1/ → no warning, exit 0 ──"
WCD_C2_OUT=$(_run_hook "ls /home/user/.claude/worktrees/w1/")
WCD_C2_RC=$?
if [[ $WCD_C2_RC -eq 0 ]]; then
  _pass "WCD-c2: exit 0"
else
  _fail "WCD-c2: expected exit 0, got $WCD_C2_RC"
fi
if printf '%s' "$WCD_C2_OUT" | grep -q "WORKTREE-DISCIPLINE WARNING"; then
  _fail "WCD-c2: unexpected warning for ls command: ${WCD_C2_OUT}"
else
  _pass "WCD-c2: no warning for ls command"
fi

# ── WCD-d: malformed JSON stdin → exit 0 (fail-open) ────────────────────────────
echo ""
echo "── WCD-d: malformed JSON → fail-open exit 0 ──"
WCD_D_RC=$(printf 'not valid json {{{' | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$HOOK" 2>/dev/null; printf '%d' $?)
if [[ $WCD_D_RC -eq 0 ]]; then
  _pass "WCD-d: malformed JSON → exit 0"
else
  _fail "WCD-d: expected exit 0 on malformed JSON, got $WCD_D_RC"
fi

# ── WCD-e: cd prefix targets wrong segment → warning emitted ───────────────────
echo ""
echo "── WCD-e: cd .claude/worktrees/wrong-seg && write to pair-1 → warning ──"
WCD_E_OUT=$(_run_hook "cd /home/user/.claude/worktrees/wrong-seg && cp /tmp/f.md /home/user/.claude/worktrees/pair-1/proposals/v1.md")
WCD_E_RC=$?
if [[ $WCD_E_RC -eq 0 ]]; then
  _pass "WCD-e: exit 0"
else
  _fail "WCD-e: expected exit 0, got $WCD_E_RC"
fi
if printf '%s' "$WCD_E_OUT" | grep -q "WORKTREE-DISCIPLINE WARNING"; then
  _pass "WCD-e: WORKTREE-DISCIPLINE WARNING emitted for wrong-segment cd"
else
  _fail "WCD-e: WORKTREE-DISCIPLINE WARNING not found when cd targets wrong segment: ${WCD_E_OUT}"
fi

# ── WCD-f: redirect write into worktree → warning ──────────────────────────────
echo ""
echo "── WCD-f: echo content > .claude/worktrees/w2/file.md → warning, exit 0 ──"
WCD_F_OUT=$(_run_hook "echo 'hello' > /home/user/.claude/worktrees/w2/file.md")
WCD_F_RC=$?
if [[ $WCD_F_RC -eq 0 ]]; then
  _pass "WCD-f: exit 0"
else
  _fail "WCD-f: expected exit 0, got $WCD_F_RC"
fi
if printf '%s' "$WCD_F_OUT" | grep -q "WORKTREE-DISCIPLINE WARNING"; then
  _pass "WCD-f: WORKTREE-DISCIPLINE WARNING for redirect write"
else
  _fail "WCD-f: WORKTREE-DISCIPLINE WARNING not found for redirect write: ${WCD_F_OUT}"
fi

# ── WCD-g: cd with trailing slash → no spurious warning (H1 fix) ──────────────
echo ""
echo "── WCD-g: cd /abs/.../w1/ && cp src dst (trailing slash) → no warning, exit 0 ──"
WCD_G_OUT=$(_run_hook "cd /home/user/.claude/worktrees/w1/ && cp /tmp/src.md proposals/v1.md")
WCD_G_RC=$?
if [[ $WCD_G_RC -eq 0 ]]; then
  _pass "WCD-g: exit 0"
else
  _fail "WCD-g: expected exit 0, got $WCD_G_RC"
fi
if printf '%s' "$WCD_G_OUT" | grep -q "WORKTREE-DISCIPLINE WARNING"; then
  _fail "WCD-g: spurious WORKTREE-DISCIPLINE WARNING for trailing-slash cd: ${WCD_G_OUT}"
else
  _pass "WCD-g: no spurious warning for trailing-slash cd"
fi

# ── WCD-h: git -C <worktree> with no cd prefix → warning emitted (H2 fix) ────
echo ""
echo "── WCD-h: git -C /abs/.../w1 commit -m msg (no trailing slash, no cd) → warning, exit 0 ──"
WCD_H_OUT=$(_run_hook "git -C /home/user/.claude/worktrees/w1 commit -m 'wip'")
WCD_H_RC=$?
if [[ $WCD_H_RC -eq 0 ]]; then
  _pass "WCD-h: exit 0"
else
  _fail "WCD-h: expected exit 0, got $WCD_H_RC"
fi
if printf '%s' "$WCD_H_OUT" | grep -q "WORKTREE-DISCIPLINE WARNING"; then
  _pass "WCD-h: WORKTREE-DISCIPLINE WARNING emitted for git -C without cd-prefix"
else
  _fail "WCD-h: WORKTREE-DISCIPLINE WARNING not found for git -C pattern: ${WCD_H_OUT}"
fi

# ── WCD-i: tee into worktree path → warning emitted (L2) ──────────────────────
echo ""
echo "── WCD-i: echo data | tee /abs/.../w1/file → warning, exit 0 ──"
WCD_I_OUT=$(_run_hook "echo data | tee /home/user/.claude/worktrees/w1/file.md")
WCD_I_RC=$?
if [[ $WCD_I_RC -eq 0 ]]; then
  _pass "WCD-i: exit 0"
else
  _fail "WCD-i: expected exit 0, got $WCD_I_RC"
fi
if printf '%s' "$WCD_I_OUT" | grep -q "WORKTREE-DISCIPLINE WARNING"; then
  _pass "WCD-i: WORKTREE-DISCIPLINE WARNING emitted for tee write"
else
  _fail "WCD-i: WORKTREE-DISCIPLINE WARNING not found for tee pattern: ${WCD_I_OUT}"
fi

# ── WCD-j: subshell (cd /abs/.../w1 && cp src dst) — WONTFIX, no warning ─────
# When cp uses a relative destination (`proposals/v1.md`) inside a subshell, the
# write target has no worktree path literal in it. The segment extractor finds
# nothing and the hook exits early (fail-open). This is a known single-command-
# analysis limitation: the hook cannot trace relative paths through a cd-in-
# subshell across a single command string. WONTFIX — document and assert exit 0.
echo ""
echo "── WCD-j: (cd /abs/.../w1 && cp src dst) subshell with relative dst — no warning (WONTFIX: relative path in subshell), exit 0 ──"
WCD_J_OUT=$(_run_hook "(cd /home/user/.claude/worktrees/w1 && cp /tmp/src.md proposals/v1.md)")
WCD_J_RC=$?
if [[ $WCD_J_RC -eq 0 ]]; then
  _pass "WCD-j: exit 0"
else
  _fail "WCD-j: expected exit 0, got $WCD_J_RC"
fi
# WONTFIX: relative write target inside subshell is undetectable — no warning expected
if printf '%s' "$WCD_J_OUT" | grep -q "WORKTREE-DISCIPLINE WARNING"; then
  _fail "WCD-j: unexpected warning — write target was relative (proposals/v1.md) with no worktree path: ${WCD_J_OUT}"
else
  _pass "WCD-j: no warning (WONTFIX: relative-path write in subshell is undetectable)"
fi

# ── Summary ──────────────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────"
echo "── Results: ${PASS} passed, ${FAIL} failed ──"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
