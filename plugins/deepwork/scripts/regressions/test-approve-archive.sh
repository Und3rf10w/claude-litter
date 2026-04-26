#!/usr/bin/env bash
# test-approve-archive.sh — regression tests for hooks/approve-archive.sh dual-path:
#   ARC-1: phase=done → archives state.json to state.archived.json
#   ARC-2: execute.phase=halt + halt_reason set → archives
#   ARC-3: execute.phase=halt, NO halt_reason → does NOT archive
#
# Exit 0 = all pass; Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${PLUGIN_ROOT}/hooks/approve-archive.sh"

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

# ── Fixture helpers ──

_make_sandbox() {
  local sb
  sb=$(mktemp -d)
  # Instance ID must be exactly 8 hex chars (instance-lib.sh:233 validation)
  local inst_id
  inst_id=$(printf '%08x' "$(date +%s)")
  local inst_dir="${sb}/.claude/deepwork/${inst_id}"
  mkdir -p "$inst_dir"
  printf '%s %s' "$sb" "$inst_id"
}

_write_state() {
  local state_file="$1"
  local json="$2"
  printf '%s\n' "$json" > "$state_file"
}

_run_hook() {
  local session_id="$1"
  local sandbox="$2"
  printf '{"session_id":"%s"}' "$session_id" \
    | CLAUDE_PROJECT_DIR="$sandbox" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "$HOOK" 2>&1
  echo $?
}

# ── ARC-1: phase=done → archives to state.archived.json ──
echo ""
echo "── ARC-1: phase=done → archives to state.archived.json ──"

read -r SANDBOX1 INST_ID1 <<< "$(_make_sandbox)"
trap 'rm -rf "$SANDBOX1"' EXIT
INST_DIR1="${SANDBOX1}/.claude/deepwork/${INST_ID1}"
SESSION1="arc1-$(date +%s)"

_write_state "${INST_DIR1}/state.json" \
  "{\"session_id\":\"${SESSION1}\",\"phase\":\"done\",\"team_name\":\"test-team\"}"

OUT1=$(_run_hook "$SESSION1" "$SANDBOX1")
RC1=$(printf '%s' "$OUT1" | tail -1)
_assert_exit "ARC-1: exits 0" "0" "$RC1"

if [[ -f "${INST_DIR1}/state.archived.json" ]]; then
  _pass "ARC-1: state.archived.json created"
else
  _fail "ARC-1: state.archived.json NOT found at ${INST_DIR1}/state.archived.json"
fi

if [[ ! -f "${INST_DIR1}/state.json" ]]; then
  _pass "ARC-1: state.json removed after archive"
else
  _fail "ARC-1: state.json still present (should have been moved)"
fi

# ── ARC-2: execute.phase=halt + halt_reason set → archives ──
echo ""
echo "── ARC-2: execute.phase=halt + halt_reason → archives ──"

SANDBOX2=$(mktemp -d)
trap 'rm -rf "$SANDBOX2"' EXIT
INST_ID2=$(printf '%08x' "$(($(date +%s) + 1))")
INST_DIR2="${SANDBOX2}/.claude/deepwork/${INST_ID2}"
mkdir -p "$INST_DIR2"
SESSION2="arc2-$(date +%s)"

_write_state "${INST_DIR2}/state.json" \
  "{\"session_id\":\"${SESSION2}\",\"phase\":\"execute\",\"execute\":{\"phase\":\"halt\"},\"halt_reason\":\"irrecoverable: secret detected\"}"

OUT2=$(_run_hook "$SESSION2" "$SANDBOX2")
RC2=$(printf '%s' "$OUT2" | tail -1)
_assert_exit "ARC-2: exits 0" "0" "$RC2"

if [[ -f "${INST_DIR2}/state.archived.json" ]]; then
  _pass "ARC-2: state.archived.json created for halt path"
else
  _fail "ARC-2: state.archived.json NOT found for halt path"
fi

if [[ ! -f "${INST_DIR2}/state.json" ]]; then
  _pass "ARC-2: state.json removed after halt archive"
else
  _fail "ARC-2: state.json still present (should have been moved)"
fi

# ── ARC-3: execute.phase=halt, NO halt_reason → does NOT archive ──
echo ""
echo "── ARC-3: execute.phase=halt, no halt_reason → no archive ──"

SANDBOX3=$(mktemp -d)
trap 'rm -rf "$SANDBOX3"' EXIT
INST_ID3=$(printf '%08x' "$(($(date +%s) + 2))")
INST_DIR3="${SANDBOX3}/.claude/deepwork/${INST_ID3}"
mkdir -p "$INST_DIR3"
SESSION3="arc3-$(date +%s)"

_write_state "${INST_DIR3}/state.json" \
  "{\"session_id\":\"${SESSION3}\",\"phase\":\"execute\",\"execute\":{\"phase\":\"halt\"}}"

OUT3=$(_run_hook "$SESSION3" "$SANDBOX3")
RC3=$(printf '%s' "$OUT3" | tail -1)
_assert_exit "ARC-3: exits 0" "0" "$RC3"

if [[ -f "${INST_DIR3}/state.archived.json" ]]; then
  _fail "ARC-3: state.archived.json should NOT exist (no halt_reason)"
else
  _pass "ARC-3: state.archived.json correctly absent"
fi

if [[ -f "${INST_DIR3}/state.json" ]]; then
  _pass "ARC-3: state.json preserved (not archived)"
else
  _fail "ARC-3: state.json missing — hook incorrectly archived without halt_reason"
fi

# ── ARC-4: full CC Stop event JSON (hook_event_name + stop_reason) → archives ──
echo ""
echo "── ARC-4: full CC Stop event JSON format → archives ──"

SANDBOX4=$(mktemp -d)
trap 'rm -rf "$SANDBOX4"' EXIT
INST_ID4=$(printf '%08x' "$(($(date +%s) + 3))")
INST_DIR4="${SANDBOX4}/.claude/deepwork/${INST_ID4}"
mkdir -p "$INST_DIR4"
SESSION4="arc4-$(date +%s)"

_write_state "${INST_DIR4}/state.json" \
  "{\"session_id\":\"${SESSION4}\",\"phase\":\"done\",\"team_name\":\"test-team\"}"

# Use the exact CC Stop event JSON schema (hook_event_name, stop_reason present)
OUT4=$(printf '{"hook_event_name":"Stop","session_id":"%s","stop_reason":"end_turn"}' "$SESSION4" \
  | CLAUDE_PROJECT_DIR="$SANDBOX4" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$HOOK" 2>&1; echo $?)
RC4=$(printf '%s' "$OUT4" | tail -1)
_assert_exit "ARC-4: exits 0 with full Stop event JSON" "0" "$RC4"

if [[ -f "${INST_DIR4}/state.archived.json" ]]; then
  _pass "ARC-4: state.archived.json created (full Stop event JSON)"
else
  _fail "ARC-4: state.archived.json NOT found — hook failed with full Stop event JSON"
fi

if [[ ! -f "${INST_DIR4}/state.json" ]]; then
  _pass "ARC-4: state.json removed after archive (full Stop event JSON)"
else
  _fail "ARC-4: state.json still present — hook did not archive with full Stop event JSON"
fi

# ── ARC-5: unknown session_id → hook exits 0 silently (no-op) ──
echo ""
echo "── ARC-5: unknown session_id → no-op, state.json preserved ──"

SANDBOX5=$(mktemp -d)
trap 'rm -rf "$SANDBOX5"' EXIT
INST_ID5=$(printf '%08x' "$(($(date +%s) + 4))")
INST_DIR5="${SANDBOX5}/.claude/deepwork/${INST_ID5}"
mkdir -p "$INST_DIR5"
SESSION5_STORED="arc5-stored-$(date +%s)"
SESSION5_UNKNOWN="arc5-unknown-$(date +%s)-NOMATCH"

_write_state "${INST_DIR5}/state.json" \
  "{\"session_id\":\"${SESSION5_STORED}\",\"phase\":\"done\",\"team_name\":\"test-team\"}"

OUT5=$(printf '{"hook_event_name":"Stop","session_id":"%s","stop_reason":"end_turn"}' "$SESSION5_UNKNOWN" \
  | CLAUDE_PROJECT_DIR="$SANDBOX5" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$HOOK" 2>&1; echo $?)
RC5=$(printf '%s' "$OUT5" | tail -1)
_assert_exit "ARC-5: exits 0 on unknown session" "0" "$RC5"

if [[ ! -f "${INST_DIR5}/state.archived.json" ]]; then
  _pass "ARC-5: state.archived.json correctly absent (unknown session → no-op)"
else
  _fail "ARC-5: state.archived.json exists — hook archived wrong instance"
fi

if [[ -f "${INST_DIR5}/state.json" ]]; then
  _pass "ARC-5: state.json preserved (unknown session → no-op)"
else
  _fail "ARC-5: state.json missing — hook incorrectly removed for unknown session"
fi

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
