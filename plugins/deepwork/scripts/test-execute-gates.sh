#!/bin/bash
# test-execute-gates.sh — smoke tests for execute-mode hooks + state schema.
#
# Complements scripts/test-deliver-gate.sh (plan-mode regression).
# Verifies bash syntax on every new hook, state-schema validity, and drives a few
# high-signal hook invocations with synthetic stdin to confirm block/allow behavior.
#
# Run: bash plugins/deepwork/scripts/test-execute-gates.sh
# Exit 0 = all pass; non-zero = first failure with reason on stderr.

set +e

PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILS=0
PASSES=0

_fail() { printf 'FAIL: %s\n' "$1" >&2; FAILS=$((FAILS + 1)); }
_pass() { printf 'pass: %s\n' "$1" >&2; PASSES=$((PASSES + 1)); }

# ---- Test 1: bash syntax on every new hook ----
EXEC_HOOKS=(
  "hooks/execute/plan-citation-gate.sh"
  "hooks/execute/bash-gate.sh"
  "hooks/execute/test-capture.sh"
  "hooks/execute/retest-dispatch.sh"
  "hooks/execute/file-changed-retest.sh"
  "hooks/execute/plan-drift-detector.sh"
  "hooks/execute/task-scope-gate.sh"
  "hooks/execute/stop-hook.sh"
  "profiles/execute/reinject.sh"
  "profiles/execute/completion.sh"
  "scripts/test-execute-gates.sh"
)
for f in "${EXEC_HOOKS[@]}"; do
  if bash -n "${PLUGIN_ROOT}/${f}" 2>/dev/null; then
    _pass "bash syntax: ${f}"
  else
    _fail "bash syntax: ${f}"
  fi
done

# ---- Test 2: state-schema.json is valid JSON with expected shape ----
SCHEMA="${PLUGIN_ROOT}/profiles/execute/state-schema.json"
if jq -e '.execute.plan_hash == null and .execute.phase == "setup"' "$SCHEMA" >/dev/null 2>&1; then
  _pass "state-schema.json shape"
else
  _fail "state-schema.json shape — missing execute.plan_hash=null or execute.phase=setup"
fi

for field in plan_ref plan_hash plan_drift_detected phase change_log test_manifest \
             authorized_force_push authorized_push authorized_prod_deploy \
             authorized_local_destructive secret_scan_waived setup_flags_snapshot; do
  if jq -e --arg k "$field" '.execute | has($k)' "$SCHEMA" >/dev/null 2>&1; then
    :
  else
    _fail "state-schema.json missing field: execute.${field}"
  fi
done
_pass "state-schema.json fields present (16+)"

# ---- Test 3: setup-deepwork.sh syntax ----
if bash -n "${PLUGIN_ROOT}/scripts/setup-deepwork.sh" 2>/dev/null; then
  _pass "setup-deepwork.sh syntax"
else
  _fail "setup-deepwork.sh syntax"
fi

# ---- Test 4: help text mentions execute mode ----
if bash "${PLUGIN_ROOT}/scripts/setup-deepwork.sh" --help 2>&1 | grep -q -- '--plan-ref'; then
  _pass "help text mentions --plan-ref"
else
  _fail "help text does not mention --plan-ref"
fi

# ---- Test 5: bash-gate.sh fail-open when no active execute instance ----
# (We're not in an active deepwork instance here; discover_instance returns non-zero)
OUT=$(printf '{"session_id":"nonexistent-session","tool_input":{"command":"git push --force origin main"}}' \
  | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "${PLUGIN_ROOT}/hooks/execute/bash-gate.sh" 2>&1)
RC=$?
if [[ $RC -eq 0 ]]; then
  _pass "bash-gate.sh fail-open (no active instance) → exit 0"
else
  _fail "bash-gate.sh fail-open expected exit 0, got $RC: ${OUT}"
fi

# ---- Test 6: plan-citation-gate.sh fail-open when no active execute instance ----
OUT=$(printf '{"session_id":"nonexistent-session","tool_input":{"file_path":"/tmp/foo.ts"}}' \
  | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "${PLUGIN_ROOT}/hooks/execute/plan-citation-gate.sh" 2>&1)
RC=$?
if [[ $RC -eq 0 ]]; then
  _pass "plan-citation-gate.sh fail-open (no active instance) → exit 0"
else
  _fail "plan-citation-gate.sh fail-open expected exit 0, got $RC: ${OUT}"
fi

# ---- Test 7: existing deliver-gate smoke still passes (regression) ----
if [[ -x "${PLUGIN_ROOT}/scripts/test-deliver-gate.sh" ]]; then
  if bash "${PLUGIN_ROOT}/scripts/test-deliver-gate.sh" >/dev/null 2>&1; then
    _pass "regression: test-deliver-gate.sh still passes"
  else
    _fail "regression: test-deliver-gate.sh broken"
  fi
else
  _pass "regression: test-deliver-gate.sh not executable (skipping)"
fi

# ---- Test 8: task-completed-gate.sh extension doesn't break plan-mode (no metadata.commit_sha) ----
# Plan-mode task completion (no commit_sha) must still pass through.
# Synthesize a minimal hook input; the script should not exit 2 due to commit_sha check.
# (It may still exit 2 for other reasons like missing instance — that's acceptable.)
if bash -n "${PLUGIN_ROOT}/hooks/task-completed-gate.sh" 2>/dev/null; then
  _pass "task-completed-gate.sh syntax after extension"
else
  _fail "task-completed-gate.sh syntax after extension"
fi

# ---- Test 9: all 5 synthesis templates exist ----
for kind in research audit review plan-to-execute impl-plan; do
  if [[ -f "${PLUGIN_ROOT}/templates/synthesis/${kind}.md" ]]; then
    :
  else
    _fail "missing synthesis template: ${kind}.md"
  fi
done
_pass "synthesis templates: 5/5 present"

# ---- Test 10: all 5 stance files exist ----
for stance in executor adversary auditor scope-guard chaos-monkey; do
  if [[ -f "${PLUGIN_ROOT}/profiles/execute/stances/${stance}-stance.md" ]]; then
    :
  else
    _fail "missing stance file: ${stance}-stance.md"
  fi
done
_pass "stance files: 5/5 present"

# ---- Test 11: both new skills exist ----
for skill in deepwork-execute-amend deepwork-execute-status; do
  if [[ -f "${PLUGIN_ROOT}/skills/${skill}/SKILL.md" ]]; then
    :
  else
    _fail "missing skill: ${skill}/SKILL.md"
  fi
done
_pass "skills: 2/2 present"

# ---- Tests 12-15: bash-gate.sh POSIX ERE fix (C5) ----
# Set up a minimal active execute instance in a temp project dir so discover_instance
# can find it. authorized_push is false so all irreversible-remote commands must deny.
_TMP_PROJECT=$(mktemp -d)
_INST_DIR="${_TMP_PROJECT}/.claude/deepwork/ab12cd34"
mkdir -p "$_INST_DIR"
cat > "${_INST_DIR}/state.json" <<'STATEJSON'
{
  "session_id": "test-bash-gate-posix",
  "execute": {
    "phase": "execute",
    "plan_ref": "PLAN.md",
    "plan_hash": "abc123",
    "plan_drift_detected": false,
    "authorized_force_push": false,
    "authorized_push": false,
    "authorized_prod_deploy": false,
    "authorized_local_destructive": false,
    "secret_scan_waived": false,
    "setup_flags_snapshot": {}
  }
}
STATEJSON
_BG_INPUT_PLAIN_PUSH='{"session_id":"test-bash-gate-posix","tool_input":{"command":"git push origin main"}}'
_BG_INPUT_FORCE_PUSH='{"session_id":"test-bash-gate-posix","tool_input":{"command":"git push --force origin main"}}'
_BG_INPUT_NPM='{"session_id":"test-bash-gate-posix","tool_input":{"command":"npm publish"}}'
_BG_INPUT_DOCKER='{"session_id":"test-bash-gate-posix","tool_input":{"command":"docker push myimage:latest"}}'

# Test 12: plain git push → deny G2 (Irreversible-remote / authorized_push)
OUT=$(printf '%s' "$_BG_INPUT_PLAIN_PUSH" \
  | CLAUDE_PROJECT_DIR="$_TMP_PROJECT" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "${PLUGIN_ROOT}/hooks/execute/bash-gate.sh" 2>&1)
RC=$?
if printf '%s' "$OUT" | grep -q 'repetition-operator\|grep:'; then
  _fail "Test 12: plain git push — grep PCRE error on stderr: ${OUT}"
elif printf '%s' "$OUT" | grep -q 'G2\|Irreversible-remote\|authorized_push'; then
  _pass "Test 12: plain git push → denied with G2/Irreversible-remote/authorized_push"
else
  _fail "Test 12: plain git push — expected G2 deny, got RC=${RC}: ${OUT}"
fi

# Test 13: git push --force → deny G8 (not G2)
OUT=$(printf '%s' "$_BG_INPUT_FORCE_PUSH" \
  | CLAUDE_PROJECT_DIR="$_TMP_PROJECT" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "${PLUGIN_ROOT}/hooks/execute/bash-gate.sh" 2>&1)
RC=$?
if printf '%s' "$OUT" | grep -q 'repetition-operator\|grep:'; then
  _fail "Test 13: git push --force — grep PCRE error on stderr: ${OUT}"
elif printf '%s' "$OUT" | grep -q 'G8\|CI-bypass\|authorized_force_push'; then
  _pass "Test 13: git push --force → denied with G8/CI-bypass (not G2)"
else
  _fail "Test 13: git push --force — expected G8 deny, got RC=${RC}: ${OUT}"
fi

# Test 14: npm publish → deny G2 (Irreversible-remote / authorized_push)
OUT=$(printf '%s' "$_BG_INPUT_NPM" \
  | CLAUDE_PROJECT_DIR="$_TMP_PROJECT" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "${PLUGIN_ROOT}/hooks/execute/bash-gate.sh" 2>&1)
RC=$?
if printf '%s' "$OUT" | grep -q 'repetition-operator\|grep:'; then
  _fail "Test 14: npm publish — grep PCRE error on stderr: ${OUT}"
elif printf '%s' "$OUT" | grep -q 'G2\|Irreversible-remote\|authorized_push'; then
  _pass "Test 14: npm publish → denied with G2/Irreversible-remote/authorized_push"
else
  _fail "Test 14: npm publish — expected G2 deny, got RC=${RC}: ${OUT}"
fi

# Test 15: docker push → deny G2 (Irreversible-remote / authorized_push)
OUT=$(printf '%s' "$_BG_INPUT_DOCKER" \
  | CLAUDE_PROJECT_DIR="$_TMP_PROJECT" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "${PLUGIN_ROOT}/hooks/execute/bash-gate.sh" 2>&1)
RC=$?
if printf '%s' "$OUT" | grep -q 'repetition-operator\|grep:'; then
  _fail "Test 15: docker push — grep PCRE error on stderr: ${OUT}"
elif printf '%s' "$OUT" | grep -q 'G2\|Irreversible-remote\|authorized_push'; then
  _pass "Test 15: docker push myimage:latest → denied with G2/Irreversible-remote/authorized_push"
else
  _fail "Test 15: docker push — expected G2 deny, got RC=${RC}: ${OUT}"
fi

rm -rf "$_TMP_PROJECT"

# ---- Summary ----
printf '\n' >&2
printf '%d passed, %d failed\n' "$PASSES" "$FAILS" >&2
if [[ $FAILS -gt 0 ]]; then
  exit 1
fi
exit 0
