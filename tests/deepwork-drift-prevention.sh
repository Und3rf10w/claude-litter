#!/bin/bash
# deepwork-drift-prevention.sh — M9 integration test harness.
#
# Exercises each drift-class mitigation from proposals/v3-final.md by
# running the hook scripts directly with simulated stdin JSON. Each sub-test
# creates an isolated TEST_TMPDIR session directory and asserts the expected
# behavior.
#
# Adversarial-pipeline gap (per CONDITIONAL-7 / proposals/v3-final.md §9):
# this harness does NOT spawn live CC teams. It does not exercise:
#   - ≥1 REFRAMER candidate under live debate (Inv1)
#   - no-peek enforcement across live hunter-a/hunter-b spawns (Inv2)
#   - HOLDING verdict blocking DELIVER end-to-end (Inv3)
# End-to-end adversarial testing is out of scope for this impl-plan phase
# and belongs in a follow-up execute-mode smoke session.
#
# Usage:
#   bash tests/deepwork-drift-prevention.sh            # run all 7 sub-tests
#   bash tests/deepwork-drift-prevention.sh --test M1  # run one sub-test
#
# Exit 0 → all requested sub-tests PASSED.
# Exit 1 → at least one sub-test FAILED.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PLUGIN_ROOT="${REPO_ROOT}/plugins/deepwork"
HOOKS="${PLUGIN_ROOT}/hooks"

# Arg parsing
ONLY_TEST=""
if [[ "${1:-}" == "--test" ]]; then
  ONLY_TEST="${2:-}"
fi

PASS=0
FAIL=0
FAILED_TESTS=()

# ---- helpers ----
_tmpdir() {
  mktemp -d -t deepwork-drift-prev.XXXXXX
}

_mkinstance() {
  # $1 = tmpdir; sets INSTANCE_DIR globally.
  local tmp="$1"
  INSTANCE_DIR="${tmp}/.claude/deepwork/abcd1234"
  mkdir -p "${INSTANCE_DIR}/proposals"
}

_assert_exit() {
  # $1 = expected rc, $2 = actual rc, $3 = test name
  local expected="$1" actual="$2" name="$3"
  if [[ "$actual" == "$expected" ]]; then
    printf '  PASS  %s (exit=%s)\n' "$name" "$actual"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s: expected exit=%s, got %s\n' "$name" "$expected" "$actual"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
  fi
}

_assert_contains() {
  # $1 = haystack, $2 = needle, $3 = test name
  local hay="$1" needle="$2" name="$3"
  if printf '%s' "$hay" | grep -Fq "$needle"; then
    printf '  PASS  %s\n' "$name"
    PASS=$((PASS + 1))
  else
    printf '  FAIL  %s: expected output to contain %q\n' "$name" "$needle"
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("$name")
  fi
}

_run_test() {
  local id="$1"
  if [[ -n "$ONLY_TEST" ]] && [[ "$id" != "$ONLY_TEST" ]]; then
    return 0
  fi
  printf '\n== %s ==\n' "$id"
  "test_${id//\//_}"
}

# ---- M1: phase-advance gate (drift class a) ----
test_M1() {
  local tmp=$(_tmpdir)
  _mkinstance "$tmp"

  cat > "${INSTANCE_DIR}/state.json" <<'EOF'
{
  "phase":"explore","team_name":"deepwork-t-abcd1234","instance_id":"abcd1234",
  "source_of_truth":[],
  "empirical_unknowns":[{"id":"E1","artifact":"empirical_results.E1.md","owner":"runtime","result":null}]
}
EOF
  printf '# Deepwork Log\n\n**Team:** `deepwork-t-abcd1234`\n**Instance:** `abcd1234`\n' > "${INSTANCE_DIR}/log.md"

  # Attempt to advance phase → synthesize while E1.result is null → block
  local INPUT=$(jq -n --arg fp "${INSTANCE_DIR}/state.json" \
    '{tool_name:"Write", tool_input:{file_path:$fp, content:"{\"phase\":\"synthesize\"}"}}')
  local OUT RC
  OUT=$(printf '%s' "$INPUT" | bash "${HOOKS}/phase-advance-gate.sh" 2>&1)
  RC=$?
  _assert_exit 2 "$RC" "M1 drift-a: null result blocks phase advance"
  _assert_contains "$OUT" "empirical_unknowns[E1].result is null" "M1 drift-a: error cites E1.result null"

  # Backfill result + artifact → passes
  jq '.empirical_unknowns[0].result="PRESENT"' "${INSTANCE_DIR}/state.json" > "${INSTANCE_DIR}/s.tmp" && mv "${INSTANCE_DIR}/s.tmp" "${INSTANCE_DIR}/state.json"
  touch "${INSTANCE_DIR}/empirical_results.E1.md"
  OUT=$(printf '%s' "$INPUT" | bash "${HOOKS}/phase-advance-gate.sh" 2>&1)
  RC=$?
  _assert_exit 0 "$RC" "M1 drift-a: populated result + artifact exists → pass"

  rm -rf "$tmp"
}

# ---- M1/k: state.json vs log.md metadata ----
test_M1_k() {
  local tmp=$(_tmpdir)
  _mkinstance "$tmp"

  cat > "${INSTANCE_DIR}/state.json" <<'EOF'
{
  "phase":"explore","team_name":"deepwork-t-abcd1234","instance_id":"abcd1234",
  "empirical_unknowns":[]
}
EOF
  # log.md with WRONG team_name — simulates drift class (k) mangled multi-line team_name
  printf '# Deepwork Log\n\n**Team:** `deepwork-WRONG-abcd1234`\n**Instance:** `abcd1234`\n' > "${INSTANCE_DIR}/log.md"

  local INPUT=$(jq -n --arg fp "${INSTANCE_DIR}/state.json" \
    '{tool_name:"Write", tool_input:{file_path:$fp, content:"{\"phase\":\"synthesize\"}"}}')
  local OUT RC
  OUT=$(printf '%s' "$INPUT" | bash "${HOOKS}/phase-advance-gate.sh" 2>&1)
  RC=$?
  _assert_exit 2 "$RC" "M1/k drift-k: state.json vs log.md team_name mismatch blocks"
  _assert_contains "$OUT" "drift class k" "M1/k drift-k: error tagged with drift class k"

  rm -rf "$tmp"
}

# ---- M3: verdict-version-gate (drift class h async race) ----
test_M3() {
  local tmp=$(_tmpdir)
  _mkinstance "$tmp"

  # Provide a minimal state.json so discover_instance succeeds via session_id.
  local SID="sid-test-$$"
  cat > "${INSTANCE_DIR}/state.json" <<EOF
{"phase":"critique","team_name":"deepwork-t-abcd1234","instance_id":"abcd1234","session_id":"${SID}","guardrails":[]}
EOF
  echo '{"current_version":"v3","bumped_at":"2026-04-23T13:48Z","bumped_from":"v2"}' > "${INSTANCE_DIR}/version-sentinel.json"

  local INPUT=$(jq -n --arg sid "$SID" \
    '{session_id:$sid, tool_name:"SendMessage", tool_input:{to:"team-lead", message:"CRITIQUE v2: APPROVED."}}')
  local OUT RC
  OUT=$(CLAUDE_PROJECT_DIR="$tmp" printf '%s' "$INPUT" | CLAUDE_PROJECT_DIR="$tmp" bash "${HOOKS}/verdict-version-gate.sh" 2>&1)
  RC=$?
  _assert_exit 2 "$RC" "M3 drift-h: stale v2 verdict blocked when sentinel says v3"
  _assert_contains "$OUT" "Version mismatch" "M3 drift-h: error cites version-mismatch"

  local INPUT2=$(jq -n --arg sid "$SID" \
    '{session_id:$sid, tool_name:"SendMessage", tool_input:{to:"team-lead", message:"CRITIQUE v3: APPROVED."}}')
  OUT=$(CLAUDE_PROJECT_DIR="$tmp" printf '%s' "$INPUT2" | CLAUDE_PROJECT_DIR="$tmp" bash "${HOOKS}/verdict-version-gate.sh" 2>&1)
  RC=$?
  _assert_exit 0 "$RC" "M3 drift-h: current v3 verdict passes"

  rm -rf "$tmp"
}

# ---- M4: stale-warn on source-version change ----
test_M4() {
  local tmp=$(_tmpdir)
  _mkinstance "$tmp"

  # Create a proposal + an audit file anchored to v1
  printf '%s\n' '---' 'version: "v1"' '---' '# plan v1' > "${INSTANCE_DIR}/proposals/v1-final.md"
  cat > "${INSTANCE_DIR}/findings.hunter-a.md" <<'EOF'
---
valid_against:
  artifact: "proposals/v1-final.md"
  artifact_version: "v1"
  artifact_line_count: 50
  artifact_last_modified: "2026-04-23T10:00Z"
stale_warn: false
---
# hunter-a
EOF

  local INPUT=$(jq -n --arg fp "${INSTANCE_DIR}/proposals/v1-final.md" \
    '{hook_event_name:"FileChanged", file_path:$fp, event:"change"}')
  printf '%s' "$INPUT" | bash "${HOOKS}/stale-warn.sh" >/dev/null 2>&1
  local RC=$?

  _assert_exit 0 "$RC" "M4 drift-d: stale-warn.sh completes cleanly"
  # Check stale_warn flipped to true
  local CUR_STALE=$(grep -E '^stale_warn:' "${INSTANCE_DIR}/findings.hunter-a.md" | head -1)
  _assert_contains "$CUR_STALE" "stale_warn: true" "M4 drift-d: findings.hunter-a.md stale_warn flipped to true"

  rm -rf "$tmp"
}

# ---- M5: scope_items Gate 4 (drift class e) ----
test_M5() {
  local tmp=$(_tmpdir)
  _mkinstance "$tmp"
  local TEAM="deepwork-t-abcd1234"
  local TASK_DIR="${tmp}/home/.claude/tasks/${TEAM}"
  mkdir -p "$TASK_DIR"
  export HOME="${tmp}/home"

  cat > "${INSTANCE_DIR}/state.json" <<EOF
{"phase":"explore","team_name":"${TEAM}","instance_id":"abcd1234","session_id":"sid-m5"}
EOF
  touch "${INSTANCE_DIR}/findings.x.md"

  cat > "${TASK_DIR}/T1.json" <<EOF
{"id":"T1","subject":"scope test","status":"in_progress","owner":"hunter-x","metadata":{"artifact":"findings.x.md","scope_items":["RR-F1 patch"]}}
EOF
  local INPUT=$(jq -n --arg team "$TEAM" '{team_name:$team, task_id:"T1", teammate_name:"hunter-x"}')
  local OUT RC
  OUT=$(CLAUDE_PROJECT_DIR="$tmp" printf '%s' "$INPUT" | CLAUDE_PROJECT_DIR="$tmp" bash "${HOOKS}/task-completed-gate.sh" 2>&1)
  RC=$?
  _assert_exit 0 "$RC" "M5 drift-e: Gate 4 warn-only allows completion"
  _assert_contains "$OUT" "Gate 4 (scope_items)" "M5 drift-e: warning message emitted"
  _assert_contains "$OUT" "RR-F1 patch" "M5 drift-e: warning names missing scope item"

  rm -rf "$tmp"
}

# ---- M5/l: cross-check cycle prevention ----
test_M5_l() {
  local tmp=$(_tmpdir)
  _mkinstance "$tmp"
  local TEAM="deepwork-t-abcd1234"
  local TASK_DIR="${tmp}/home/.claude/tasks/${TEAM}"
  mkdir -p "$TASK_DIR"
  export HOME="${tmp}/home"

  cat > "${INSTANCE_DIR}/state.json" <<EOF
{"phase":"explore","team_name":"${TEAM}","instance_id":"abcd1234","session_id":"sid-m5l"}
EOF
  touch "${INSTANCE_DIR}/findings.hunter-a.md"

  cat > "${TASK_DIR}/T1.json" <<EOF
{"id":"T1","subject":"a","status":"in_progress","owner":"hunter-a","metadata":{"artifact":"findings.hunter-a.md","cross_check_required":true,"bar_id":"G6"}}
EOF
  cat > "${TASK_DIR}/T2.json" <<EOF
{"id":"T2","subject":"b","status":"in_progress","owner":"hunter-b","metadata":{"artifact":"findings.hunter-b.md","cross_check_required":false,"bar_id":"G6"}}
EOF
  local INPUT=$(jq -n --arg team "$TEAM" '{team_name:$team, task_id:"T1", teammate_name:"hunter-a"}')
  local OUT RC

  # Step 1: T1 completion blocks, marker is written
  OUT=$(CLAUDE_PROJECT_DIR="$tmp" printf '%s' "$INPUT" | CLAUDE_PROJECT_DIR="$tmp" bash "${HOOKS}/task-completed-gate.sh" 2>&1)
  RC=$?
  _assert_exit 2 "$RC" "M5/l drift-l: cross_check incomplete blocks"
  if [[ -f "${INSTANCE_DIR}/.gate-blocked-T1" ]]; then
    printf '  PASS  M5/l drift-l: sidecar marker written on block\n'
    PASS=$((PASS + 1))
  else
    printf '  FAIL  M5/l drift-l: sidecar marker missing after gate-block\n'
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("M5/l sidecar-marker-written")
  fi

  # Step 2: idle-gate with fresh marker → exit 0 (no retry cycle)
  local IDLE=$(jq -n --arg team "$TEAM" '{team_name:$team, teammate_name:"hunter-a"}')
  OUT=$(CLAUDE_PROJECT_DIR="$tmp" printf '%s' "$IDLE" | CLAUDE_PROJECT_DIR="$tmp" bash "${HOOKS}/teammate-idle-gate.sh" 2>&1)
  RC=$?
  _assert_exit 0 "$RC" "M5/l drift-l: fresh marker lets idle proceed without retry loop"

  # Step 3: T2 completes → T1 retry succeeds → marker deleted
  touch "${INSTANCE_DIR}/findings.hunter-b.md"
  jq '.status="completed"' "${TASK_DIR}/T2.json" > "${TASK_DIR}/T2.tmp" && mv "${TASK_DIR}/T2.tmp" "${TASK_DIR}/T2.json"
  OUT=$(CLAUDE_PROJECT_DIR="$tmp" printf '%s' "$INPUT" | CLAUDE_PROJECT_DIR="$tmp" bash "${HOOKS}/task-completed-gate.sh" 2>&1)
  RC=$?
  _assert_exit 0 "$RC" "M5/l drift-l: T1 passes after T2 completes"
  if [[ ! -f "${INSTANCE_DIR}/.gate-blocked-T1" ]]; then
    printf '  PASS  M5/l drift-l: sidecar marker cleaned up on gate-pass\n'
    PASS=$((PASS + 1))
  else
    printf '  FAIL  M5/l drift-l: marker not cleaned up on gate-pass\n'
    FAIL=$((FAIL + 1))
    FAILED_TESTS+=("M5/l sidecar-marker-cleanup")
  fi

  rm -rf "$tmp"
}

# ---- M8: path convention (drift class i) ----
test_M8() {
  local tmp=$(_tmpdir)
  _mkinstance "$tmp"
  local TEAM="deepwork-t-abcd1234"
  local TASK_DIR="${tmp}/home/.claude/tasks/${TEAM}"
  mkdir -p "$TASK_DIR"
  export HOME="${tmp}/home"

  cat > "${INSTANCE_DIR}/state.json" <<EOF
{"phase":"explore","team_name":"${TEAM}","instance_id":"abcd1234","session_id":"sid-m8"}
EOF
  cat > "${TASK_DIR}/T1.json" <<EOF
{"id":"T1","subject":"abs path","status":"in_progress","owner":"hunter","metadata":{"artifact":"/abs/path/file.md"}}
EOF

  local INPUT=$(jq -n --arg team "$TEAM" '{team_name:$team, task_id:"T1", teammate_name:"hunter"}')
  local OUT RC
  OUT=$(CLAUDE_PROJECT_DIR="$tmp" printf '%s' "$INPUT" | CLAUDE_PROJECT_DIR="$tmp" bash "${HOOKS}/task-completed-gate.sh" 2>&1)
  RC=$?
  _assert_exit 2 "$RC" "M8 drift-i: absolute path rejected"
  _assert_contains "$OUT" "task-conventions.md" "M8 drift-i: error cites task-conventions.md reference"
  _assert_contains "$OUT" "RELATIVE" "M8 drift-i: error tells author to use a relative path"

  rm -rf "$tmp"
}

# ---- Run ----
printf 'Deepwork drift-prevention integration test harness\n'
printf 'Hook scripts under test: %s\n' "$HOOKS"
if [[ -n "$ONLY_TEST" ]]; then
  printf 'Running only: %s\n' "$ONLY_TEST"
fi

_run_test "M1"
_run_test "M1_k"
_run_test "M3"
_run_test "M4"
_run_test "M5"
_run_test "M5_l"
_run_test "M8"

printf '\n----- Summary -----\n'
printf 'Passed: %d\nFailed: %d\n' "$PASS" "$FAIL"
if [[ $FAIL -gt 0 ]]; then
  printf '\nFailed tests:\n'
  for t in "${FAILED_TESTS[@]}"; do
    printf '  - %s\n' "$t"
  done
  exit 1
fi
printf '\nALL DRIFT PREVENTION TESTS PASSED\n'
exit 0
