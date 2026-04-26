#!/usr/bin/env bash
# test-wave-gate.sh — regression tests for PR-D: wave-gate.sh (teammate phase-authority gate).
#
# Cases:
#   WG-a: orchestrator (team-lead) creates cross-phase task → allowed
#   WG-b: teammate creates same-phase task with metadata.wave → allowed
#   WG-c: teammate creates task without metadata.wave → blocked (MISSING_WAVE_METADATA)
#   WG-d: teammate creates task with wave != current_phase, no override_reason → blocked (WAVE_MISMATCH)
#   WG-e: teammate creates task with wave != current_phase, with override_reason → allowed + audit in log.md
#   WG-f: design mode — uses state.phase
#   WG-g: execute mode — uses state.execute.phase
#   WG-h: malformed state.json → fail-open (allowed)
#   WG-i: no active instance → fail-open (allowed)
#
# Exit 0 = all pass; Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${PLUGIN_ROOT}/hooks/wave-gate.sh"

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
    _pass "${name} (found \"${needle}\")"
  else
    _fail "${name} — did not find \"${needle}\" in: ${haystack}"
  fi
}

_assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    _fail "${name} — found unexpected \"${needle}\""
  else
    _pass "${name} (did not find \"${needle}\")"
  fi
}

# ── Fixture helpers ──
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

TEAM_NAME="test-wave-team"
INSTANCE_ID="ab12ef34"
INSTANCE_DIR="${SANDBOX}/.claude/deepwork/${INSTANCE_ID}"
mkdir -p "$INSTANCE_DIR"
LOG_FILE="${INSTANCE_DIR}/log.md"
touch "$LOG_FILE"

_write_design_state() {
  local phase="${1:-explore}"
  STATE_FILE="${INSTANCE_DIR}/state.json" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{
  "session_id": "test-wg-session",
  "team_name": "${TEAM_NAME}",
  "phase": "${phase}"
}
EOF
}

_write_execute_state() {
  local phase="${1:-execute}"
  STATE_FILE="${INSTANCE_DIR}/state.json" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{
  "session_id": "test-wg-session",
  "team_name": "${TEAM_NAME}",
  "execute": {
    "phase": "${phase}",
    "plan_ref": "plan.md"
  }
}
EOF
}

_write_malformed_state() {
  printf 'NOT VALID JSON{{{' > "${INSTANCE_DIR}/state.json"
}

_run_hook() {
  local input="$1"
  printf '%s' "$input" \
    | HOME="$SANDBOX" CLAUDE_PROJECT_DIR="$SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "$HOOK" 2>&1
  echo $?
}

# ── WG-a: orchestrator (team-lead) creates cross-phase task → allowed ──
echo ""
echo "── WG-a: orchestrator (team-lead) creates cross-phase task → allowed ──"
_write_design_state "explore"
INPUT=$(jq -cn \
  --arg team "$TEAM_NAME" \
  --arg tid "task-1" \
  '{team_name: $team, teammate_name: "team-lead", task_id: $tid, task_subject: "some task",
    metadata: {wave: "synthesize"}}')
OUT=$(_run_hook "$INPUT")
RC=$(printf '%s' "$OUT" | tail -1)
_assert_exit "WG-a: team-lead cross-phase allowed (exit=0)" "0" "$RC"
_assert_not_contains "WG-a: no MISMATCH in output" "WAVE_MISMATCH" "$OUT"

# ── WG-b: teammate creates same-phase task with metadata.wave → allowed ──
echo ""
echo "── WG-b: teammate creates same-phase task → allowed ──"
_write_design_state "explore"
INPUT=$(jq -cn \
  --arg team "$TEAM_NAME" \
  --arg tid "task-2" \
  '{team_name: $team, teammate_name: "W1-researcher", task_id: $tid, task_subject: "explore task",
    metadata: {wave: "explore"}}')
OUT=$(_run_hook "$INPUT")
RC=$(printf '%s' "$OUT" | tail -1)
_assert_exit "WG-b: same-phase allowed (exit=0)" "0" "$RC"

# ── WG-c: teammate creates task without metadata.wave → blocked (MISSING_WAVE_METADATA) ──
echo ""
echo "── WG-c: teammate creates task without metadata.wave → blocked ──"
_write_design_state "explore"
INPUT=$(jq -cn \
  --arg team "$TEAM_NAME" \
  --arg tid "task-3" \
  '{team_name: $team, teammate_name: "W1-researcher", task_id: $tid, task_subject: "no wave",
    metadata: {}}')
OUT=$(_run_hook "$INPUT")
RC=$(printf '%s' "$OUT" | tail -1)
_assert_exit "WG-c: no metadata.wave blocked (exit=2)" "2" "$RC"
_assert_contains "WG-c: error mentions MISSING_WAVE_METADATA" "MISSING_WAVE_METADATA" "$OUT"

# ── WG-d: teammate creates task with wave != current_phase, no override → blocked (WAVE_MISMATCH) ──
echo ""
echo "── WG-d: teammate creates task with mismatched wave, no override → blocked ──"
_write_design_state "explore"
INPUT=$(jq -cn \
  --arg team "$TEAM_NAME" \
  --arg tid "task-4" \
  '{team_name: $team, teammate_name: "W1-researcher", task_id: $tid, task_subject: "wrong phase",
    metadata: {wave: "synthesize"}}')
OUT=$(_run_hook "$INPUT")
RC=$(printf '%s' "$OUT" | tail -1)
_assert_exit "WG-d: wave mismatch blocked (exit=2)" "2" "$RC"
_assert_contains "WG-d: error mentions WAVE_MISMATCH" "WAVE_MISMATCH" "$OUT"

# ── WG-e: teammate creates task with wave != current_phase, with override_reason → allowed + audit ──
echo ""
echo "── WG-e: teammate with override_reason → allowed + audit in log.md ──"
_write_design_state "explore"
> "$LOG_FILE"
INPUT=$(jq -cn \
  --arg team "$TEAM_NAME" \
  --arg tid "task-5" \
  '{team_name: $team, teammate_name: "W1-researcher", task_id: $tid, task_subject: "override task",
    metadata: {wave: "synthesize", override_reason: "pre-emptive work approved by lead"}}')
OUT=$(_run_hook "$INPUT")
RC=$(printf '%s' "$OUT" | tail -1)
_assert_exit "WG-e: override allowed (exit=0)" "0" "$RC"
# Verify audit entry in log.md
LOG_CONTENT=$(cat "$LOG_FILE" 2>/dev/null || echo "")
_assert_contains "WG-e: audit entry in log.md" "wave-gate override" "$LOG_CONTENT"
_assert_contains "WG-e: audit entry has teammate name" "W1-researcher" "$LOG_CONTENT"
_assert_contains "WG-e: audit entry has task id" "task-5" "$LOG_CONTENT"
_assert_contains "WG-e: audit entry has wave" "synthesize" "$LOG_CONTENT"
_assert_contains "WG-e: audit entry has override reason" "pre-emptive work approved by lead" "$LOG_CONTENT"

# ── WG-f: design mode uses state.phase ──
echo ""
echo "── WG-f: design mode — gate uses state.phase ──"
_write_design_state "critique"
INPUT=$(jq -cn \
  --arg team "$TEAM_NAME" \
  --arg tid "task-6" \
  '{team_name: $team, teammate_name: "W1-researcher", task_id: $tid, task_subject: "design task",
    metadata: {wave: "critique"}}')
OUT=$(_run_hook "$INPUT")
RC=$(printf '%s' "$OUT" | tail -1)
_assert_exit "WG-f: design mode same phase allowed (exit=0)" "0" "$RC"

# And a mismatch in design mode:
INPUT2=$(jq -cn \
  --arg team "$TEAM_NAME" \
  --arg tid "task-6b" \
  '{team_name: $team, teammate_name: "W1-researcher", task_id: $tid, task_subject: "design task mismatch",
    metadata: {wave: "explore"}}')
OUT2=$(_run_hook "$INPUT2")
RC2=$(printf '%s' "$OUT2" | tail -1)
_assert_exit "WG-f: design mode mismatch blocked (exit=2)" "2" "$RC2"

# ── WG-g: execute mode uses state.execute.phase ──
echo ""
echo "── WG-g: execute mode — gate uses state.execute.phase ──"
_write_execute_state "execute"
INPUT=$(jq -cn \
  --arg team "$TEAM_NAME" \
  --arg tid "task-7" \
  '{team_name: $team, teammate_name: "W1-coder", task_id: $tid, task_subject: "execute task",
    metadata: {wave: "execute"}}')
OUT=$(_run_hook "$INPUT")
RC=$(printf '%s' "$OUT" | tail -1)
_assert_exit "WG-g: execute mode same phase allowed (exit=0)" "0" "$RC"

# Mismatch in execute mode:
INPUT2=$(jq -cn \
  --arg team "$TEAM_NAME" \
  --arg tid "task-7b" \
  '{team_name: $team, teammate_name: "W1-coder", task_id: $tid, task_subject: "wrong execute phase",
    metadata: {wave: "verify"}}')
OUT2=$(_run_hook "$INPUT2")
RC2=$(printf '%s' "$OUT2" | tail -1)
_assert_exit "WG-g: execute mode mismatch blocked (exit=2)" "2" "$RC2"

# ── WG-h: malformed state.json → fail-open ──
echo ""
echo "── WG-h: malformed state.json → fail-open ──"
_write_malformed_state
INPUT=$(jq -cn \
  --arg team "$TEAM_NAME" \
  --arg tid "task-8" \
  '{team_name: $team, teammate_name: "W1-researcher", task_id: $tid, task_subject: "any task",
    metadata: {wave: "explore"}}')
OUT=$(_run_hook "$INPUT")
RC=$(printf '%s' "$OUT" | tail -1)
_assert_exit "WG-h: malformed state fail-open (exit=0)" "0" "$RC"

# Restore a good state for next test
_write_design_state "explore"

# ── WG-i: no active instance → fail-open ──
echo ""
echo "── WG-i: no active instance → fail-open ──"
INPUT=$(jq -cn \
  '{team_name: "nonexistent-team-xyz", teammate_name: "W1-researcher", task_id: "task-9",
    task_subject: "no instance", metadata: {wave: "explore"}}')
OUT=$(printf '%s' "$INPUT" \
  | HOME="$SANDBOX" CLAUDE_PROJECT_DIR="$SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$HOOK" 2>&1)
echo $? >> /dev/null
OUT2="$OUT"
RC2=$(printf '%s' "$INPUT" \
  | HOME="$SANDBOX" CLAUDE_PROJECT_DIR="$SANDBOX" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$HOOK" 2>/dev/null; echo $?)
RC=$(printf '%s' "$RC2" | tail -1)
_assert_exit "WG-i: no instance fail-open (exit=0)" "0" "$RC"

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
