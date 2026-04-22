#!/bin/bash
# test-deliver-gate.sh — smoke test for FIX-7 deliver-gate.sh.
#
# 3 fixtures:
#   1. Plan WITHOUT "Residual unknowns" → gate rejects (exit 2)
#   2. Plan WITH "Residual unknowns" AND only v1.md (null delta is OK for v1) → gate allows (exit 0)
#   3. Plan WITH "Residual unknowns" AND v2-final.md with null delta_from_prior → gate rejects (exit 2)
#   4. Bonus: plan with Residual unknowns AND v2 with populated delta → gate allows

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOOK="${SCRIPT_DIR}/../hooks/deliver-gate.sh"

if [[ ! -f "$HOOK" ]]; then
  echo "FAIL: hook not found at $HOOK" >&2
  exit 1
fi

PASS=0
FAIL=0

# Setup: create a sandbox CLAUDE_PROJECT_DIR with an active deepwork instance
SANDBOX=$(mktemp -d)
export CLAUDE_PROJECT_DIR="$SANDBOX"
INSTANCE_ID="deadbeef"
INSTANCE_DIR="$SANDBOX/.claude/deepwork/$INSTANCE_ID"
mkdir -p "$INSTANCE_DIR/proposals"

# Fake session ID and state.json
SESSION_ID="session-$(date +%s)"
cat > "$INSTANCE_DIR/state.json" <<EOF
{"session_id": "$SESSION_ID", "phase": "deliver", "team_name": "test-team"}
EOF

_assert_exit() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf '✔ %s (exit=%s)\n' "$name" "$actual"
    PASS=$((PASS + 1))
  else
    printf '✘ %s — expected exit %s, got %s\n' "$name" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

_run_gate() {
  local plan_text="$1"
  local payload
  payload=$(jq -cn --arg sid "$SESSION_ID" --arg plan "$plan_text" \
    '{session_id: $sid, tool_name: "ExitPlanMode", tool_input: {plan: $plan}}')
  echo "$payload" | bash "$HOOK" >/dev/null 2>&1
  echo $?
}

_run_gate_stderr() {
  local plan_text="$1"
  local _tmpfile
  _tmpfile=$(mktemp)
  local payload
  payload=$(jq -cn --arg sid "$SESSION_ID" --arg plan "$plan_text" \
    '{session_id: $sid, tool_name: "ExitPlanMode", tool_input: {plan: $plan}}')
  echo "$payload" | bash "$HOOK" >/dev/null 2>"$_tmpfile"
  local _exit=$?
  cat "$_tmpfile"
  rm -f "$_tmpfile"
  return $_exit
}

_assert_stderr_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -q -- "$needle"; then
    printf '✔ %s (stderr matched "%s")\n' "$name" "$needle"
    PASS=$((PASS + 1))
  else
    printf '✘ %s — stderr did not contain "%s"\n' "$name" "$needle" >&2
    printf '  actual: %s\n' "$haystack" >&2
    FAIL=$((FAIL + 1))
  fi
}

# ────────────────────────────────────────────────────────────
# Fixture 1: plan without "Residual unknowns" → reject (exit 2)
echo ""
echo "── Fixture 1: missing Residual unknowns ──"
rm -f "$INSTANCE_DIR/proposals/"v*.md
PLAN1="# My Plan

Summary of changes.

## Changes

- FIX-1
- FIX-2"
_assert_exit "rejects plan missing 'Residual unknowns'" "2" "$(_run_gate "$PLAN1")"

# ────────────────────────────────────────────────────────────
# Fixture 2: plan with Residual unknowns + only v1.md (null delta OK) → allow
echo ""
echo "── Fixture 2: Residual unknowns present + v1.md ──"
cat > "$INSTANCE_DIR/proposals/v1.md" <<'EOF'
---
version: "v1"
delta_from_prior: null
---

# v1 proposal

Body.
EOF
PLAN2="# My Plan

## Residual unknowns

1. Thing A — defer to v1.1."
_assert_exit "allows plan with Residual unknowns + v1 null delta" "0" "$(_run_gate "$PLAN2")"

# ────────────────────────────────────────────────────────────
# Fixture 3: plan with Residual unknowns + v2 with null delta → reject
echo ""
echo "── Fixture 3: v2 with null delta ──"
cat > "$INSTANCE_DIR/proposals/v2.md" <<'EOF'
---
version: "v2"
delta_from_prior: null
---

# v2 proposal

Body.
EOF
PLAN3="$PLAN2"
_assert_exit "rejects plan when v2 has null delta_from_prior" "2" "$(_run_gate "$PLAN3")"

# ────────────────────────────────────────────────────────────
# Fixture 4: v2 with populated delta → allow
echo ""
echo "── Fixture 4: v2 with populated delta ──"
cat > "$INSTANCE_DIR/proposals/v2.md" <<'EOF'
---
version: "v2"
delta_from_prior: |
  - Added FIX-7 deliver-gate
  - Added FIX-8 owner-from-file
---

# v2 proposal

Body.
EOF
_assert_exit "allows plan when v2 has populated delta" "0" "$(_run_gate "$PLAN3")"

# ────────────────────────────────────────────────────────────
# Fixture 5: v3-final with populated delta → allow
echo ""
echo "── Fixture 5: v3-final with block-scalar delta ──"
cat > "$INSTANCE_DIR/proposals/v3-final.md" <<'EOF'
---
version: "v3-final"
delta_from_prior: |
  v2 → v3-final correction.
---

# v3-final
EOF
_assert_exit "allows plan when v3-final has populated delta" "0" "$(_run_gate "$PLAN3")"

# ────────────────────────────────────────────────────────────
# Fixture 6: 5-hash "Residual unknowns" heading → reject (exit 2 + stderr)
echo ""
echo "── Fixture 6: 5-hash Residual unknowns boundary ──"
rm -f "$INSTANCE_DIR/proposals/"v*.md
PLAN6="# My Plan

## Changes

- FIX-9

##### Residual unknowns

- None identified."
_assert_exit "rejects plan with h5 'Residual unknowns' (outside #{1,4})" "2" "$(_run_gate "$PLAN6")"
_assert_stderr_contains "Fixture 6 stderr mentions BLOCKED" "BLOCKED: ExitPlanMode plan is missing" "$(_run_gate_stderr "$PLAN6")"

# Cleanup
rm -rf "$SANDBOX"

# ────────────────────────────────────────────────────────────
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
