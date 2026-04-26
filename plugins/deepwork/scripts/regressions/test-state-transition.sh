#!/usr/bin/env bash
# test-state-transition.sh — regression tests for state-transition.sh (W6).
#
# ST-a: phase_advance to valid next phase succeeds + hash updated
# ST-b: phase_advance to same phase (no gate block) succeeds + hash updated
# ST-c: append_array .hook_warnings appends + hash updated
# ST-d: merge multi-field JSON updates all fields + hash updated
# ST-e: halt_reason writes correct schema + hash updated
# ST-f: concurrent invocations leave valid JSON (flock test)
# ST-g: init writes bare state without hash
# ST-j: integrity gate fires on hash mismatch (external edit)
# ST-k: absent .state_integrity_hash (pre-W6 instance) passes integrity gate
# ST-l: exec_phase_advance updates .execute.phase + hash updated
# ST-m: set_field updates field + appends hook_warnings audit entry + hash updated
# ST-n: flaky_test_append deduplicates
# ST-o: backfill_session backfills placeholder, ignores non-placeholder
# ST-p: invalid subcommand exits 3
# ST-q: init guard fires when instance_id already present
# ST-r: started_at mutation detected by integrity hash (W9 M2)
# ST-s: source_of_truth mutation detected by integrity hash (W9 M2)
#
# Exit 0 = all pass; Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STATE_TRANSITION="${PLUGIN_ROOT}/scripts/state-transition.sh"

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

_assert_jq_eq() {
  local name="$1" file="$2" jq_filter="$3" expected="$4"
  local actual
  actual=$(jq -r "$jq_filter" "$file" 2>/dev/null)
  if [[ "$actual" == "$expected" ]]; then
    _pass "${name} (jq=${actual})"
  else
    _fail "${name} — expected '${expected}', got '${actual}'"
  fi
}

_assert_hash_present() {
  local name="$1" file="$2"
  local h
  h=$(jq -r '.state_integrity_hash // ""' "$file" 2>/dev/null)
  if [[ -n "$h" ]] && [[ "$h" != "null" ]]; then
    _pass "${name} (hash present: ${h:0:12}...)"
  else
    _fail "${name} — state_integrity_hash absent or null"
  fi
}

_assert_hash_absent() {
  local name="$1" file="$2"
  local h
  h=$(jq -r '.state_integrity_hash // ""' "$file" 2>/dev/null)
  if [[ -z "$h" ]] || [[ "$h" == "null" ]]; then
    _pass "${name} (hash absent as expected)"
  else
    _fail "${name} — expected hash absent, got ${h}"
  fi
}

# ── Fixture setup ──
SANDBOX=$(mktemp -d)
# Resolve through symlinks (macOS /var → /private/var)
SANDBOX="$(cd "$SANDBOX" && pwd -P)"
trap 'rm -rf "$SANDBOX"' EXIT

INSTANCE_ID="deadc0de"
INSTANCE_DIR="${SANDBOX}/.claude/deepwork/${INSTANCE_ID}"
mkdir -p "$INSTANCE_DIR"
SESSION_ID="test-st-$(date +%s)"

_make_state() {
  local phase="${1:-scope}"
  local sf="${INSTANCE_DIR}/state.json"
  rm -f "$sf"
  "$STATE_TRANSITION" --state-file "$sf" init - <<EOF
{
  "session_id": "${SESSION_ID}",
  "instance_id": "${INSTANCE_ID}",
  "phase": "${phase}",
  "team_name": "test-team",
  "hook_warnings": [],
  "bar": [],
  "frontmatter_schema_version": "1"
}
EOF
}

# ── ST-g: init writes bare state without hash ──
echo ""
echo "── ST-g: init writes state; no integrity hash ──"
_make_state "scope"
SF="${INSTANCE_DIR}/state.json"
_assert_jq_eq "ST-g: phase written" "$SF" '.phase' "scope"
_assert_hash_absent "ST-g: no hash after init" "$SF"

# ── ST-a: phase_advance to valid next phase succeeds + hash updated ──
echo ""
echo "── ST-a: phase_advance succeeds + hash updated ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
RC=$?
_assert_exit "ST-a: exit 0" "0" "$RC"
_assert_jq_eq "ST-a: phase=work" "$SF" '.phase' "work"
_assert_hash_present "ST-a: hash written after phase_advance" "$SF"

# ── ST-b: phase_advance to same phase succeeds (gate doesn't block on non-forward phases) ──
echo ""
echo "── ST-b: phase_advance to unguarded phase succeeds ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "scope"
RC=$?
_assert_exit "ST-b: exit 0" "0" "$RC"
_assert_jq_eq "ST-b: phase unchanged" "$SF" '.phase' "scope"
_assert_hash_present "ST-b: hash written" "$SF"

# ── ST-c: append_array .hook_warnings appends + hash updated ──
echo ""
echo "── ST-c: append_array .hook_warnings ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" append_array '.hook_warnings' \
  '{"event":"test","message":"hello"}'
RC=$?
_assert_exit "ST-c: exit 0" "0" "$RC"
_assert_jq_eq "ST-c: hook_warnings length=1" "$SF" '.hook_warnings | length' "1"
_assert_jq_eq "ST-c: entry event=test" "$SF" '.hook_warnings[0].event' "test"
_assert_hash_present "ST-c: hash updated" "$SF"

# Append a second entry to verify accumulation
"$STATE_TRANSITION" --state-file "$SF" append_array '.hook_warnings' \
  '{"event":"second","message":"world"}'
_assert_jq_eq "ST-c: hook_warnings length=2 after second append" "$SF" '.hook_warnings | length' "2"

# ── ST-d: merge multi-field JSON updates all fields + hash updated ──
echo ""
echo "── ST-d: merge updates multiple fields ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" merge \
  '{"custom_field":"hello","another_field":42}'
RC=$?
_assert_exit "ST-d: exit 0" "0" "$RC"
_assert_jq_eq "ST-d: custom_field set" "$SF" '.custom_field' "hello"
_assert_jq_eq "ST-d: another_field set" "$SF" '.another_field' "42"
_assert_hash_present "ST-d: hash updated after merge" "$SF"

# ── ST-e: halt_reason writes correct schema + hash updated ──
echo ""
echo "── ST-e: halt_reason writes correct schema ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" halt_reason \
  --summary "blocked on external dep" \
  --blocker "waiting for API" \
  --blocker "legal review"
RC=$?
_assert_exit "ST-e: exit 0" "0" "$RC"
_assert_jq_eq "ST-e: halt_reason.summary" "$SF" '.halt_reason.summary' "blocked on external dep"
_assert_jq_eq "ST-e: blockers count=2" "$SF" '.halt_reason.blockers | length' "2"
_assert_jq_eq "ST-e: blocker[0]" "$SF" '.halt_reason.blockers[0]' "waiting for API"
_assert_jq_eq "ST-e: recorded_at present" "$SF" '.halt_reason.recorded_at | test("^[0-9]{4}-")' "true"
_assert_hash_present "ST-e: hash updated" "$SF"

# ── ST-f: concurrent invocations leave valid JSON ──
echo ""
echo "── ST-f: concurrent invocations (flock test) ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
# Fire 5 concurrent appends; expect valid JSON afterward
for i in 1 2 3 4 5; do
  "$STATE_TRANSITION" --state-file "$SF" append_array '.hook_warnings' \
    "{\"event\":\"concurrent\",\"n\":${i}}" &
done
wait
# state.json must still be valid JSON
if jq empty "$SF" 2>/dev/null; then
  _pass "ST-f: state.json is valid JSON after concurrent writes"
else
  _fail "ST-f: state.json is invalid JSON after concurrent writes"
fi
_assert_hash_present "ST-f: hash present after concurrent writes" "$SF"

# ── ST-j: integrity gate fires on hash mismatch (external edit) ──
echo ""
echo "── ST-j: integrity gate fires on external hash mismatch ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
# Tamper with the file externally (bypassing the single-writer path)
TMP_SF="${SF}.tamper.$$"
jq '.phase = "synthesize"' "$SF" > "$TMP_SF" && mv "$TMP_SF" "$SF"
# Now attempt another transition — integrity gate should fire (exit 2)
OUT=$("$STATE_TRANSITION" --state-file "$SF" append_array '.hook_warnings' \
  '{"event":"post-tamper"}' 2>&1)
RC=$?
_assert_exit "ST-j: integrity gate blocks (exit=2)" "2" "$RC"
_assert_contains "ST-j: error mentions INTEGRITY" "INTEGRITY_HASH_MISMATCH" "$OUT"

# ── ST-k: absent .state_integrity_hash (pre-W6 instance) passes integrity gate ──
echo ""
echo "── ST-k: absent hash (pre-W6) passes integrity gate ──"
_make_state "scope"
# init writes no hash; verify phase_advance succeeds without hash field
_assert_hash_absent "ST-k: pre-condition: hash absent after init" "$SF"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
RC=$?
_assert_exit "ST-k: phase_advance succeeds without hash (exit=0)" "0" "$RC"
_assert_jq_eq "ST-k: phase advanced" "$SF" '.phase' "work"

# ── ST-l: exec_phase_advance updates .execute.phase ──
echo ""
echo "── ST-l: exec_phase_advance updates .execute.phase ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
# Seed an execute sub-object
"$STATE_TRANSITION" --state-file "$SF" merge \
  '{"execute":{"phase":"plan","plan_drift_detected":false}}'
"$STATE_TRANSITION" --state-file "$SF" exec_phase_advance --to "execute"
RC=$?
_assert_exit "ST-l: exit 0" "0" "$RC"
_assert_jq_eq "ST-l: execute.phase=execute" "$SF" '.execute.phase' "execute"
_assert_hash_present "ST-l: hash updated" "$SF"

# ── ST-m: set_field updates field + appends hook_warnings audit entry ──
echo ""
echo "── ST-m: set_field updates field + audit log ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" set_field '.user_feedback' '"approved"'
RC=$?
_assert_exit "ST-m: exit 0" "0" "$RC"
_assert_jq_eq "ST-m: user_feedback=approved" "$SF" '.user_feedback' "approved"
_assert_jq_eq "ST-m: hook_warnings has set_field entry" "$SF" \
  '[.hook_warnings[] | select(.event == "set_field")] | length > 0' "true"
_assert_hash_present "ST-m: hash updated" "$SF"

# ── ST-n: flaky_test_append deduplicates ──
echo ""
echo "── ST-n: flaky_test_append deduplicates ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" merge \
  '{"execute":{"phase":"execute","flaky_tests":[]}}'
"$STATE_TRANSITION" --state-file "$SF" flaky_test_append --cmd "pytest tests/test_foo.py"
"$STATE_TRANSITION" --state-file "$SF" flaky_test_append --cmd "pytest tests/test_foo.py"
RC=$?
_assert_exit "ST-n: exit 0 on second (dedup no-op)" "0" "$RC"
_assert_jq_eq "ST-n: flaky_tests has exactly 1 entry" "$SF" \
  '.execute.flaky_tests | length' "1"

# ── ST-o: backfill_session backfills placeholder, ignores non-placeholder ──
echo ""
echo "── ST-o: backfill_session ──"
_make_state "scope"
# Seed a placeholder session_id
"$STATE_TRANSITION" --state-file "$SF" merge '{"session_id":"deepwork-placeholder-001"}'
"$STATE_TRANSITION" --state-file "$SF" backfill_session --session-id "real-session-abc"
RC=$?
_assert_exit "ST-o: exit 0 on backfill" "0" "$RC"
_assert_jq_eq "ST-o: session_id backfilled" "$SF" '.session_id' "real-session-abc"

# Run again with a non-placeholder id — should no-op
"$STATE_TRANSITION" --state-file "$SF" backfill_session --session-id "should-not-overwrite"
_assert_jq_eq "ST-o: non-placeholder not overwritten" "$SF" '.session_id' "real-session-abc"

# ── ST-p: invalid subcommand exits 3 ──
echo ""
echo "── ST-p: invalid subcommand exits 3 ──"
_make_state "scope"
OUT=$("$STATE_TRANSITION" --state-file "$SF" no_such_subcommand 2>&1)
RC=$?
_assert_exit "ST-p: exit 3" "3" "$RC"
_assert_contains "ST-p: error mentions unknown subcommand" "unknown subcommand" "$OUT"

# ── ST-q: init guard fires when instance_id already present ──
echo ""
echo "── ST-q: init guard fires when instance_id present ──"
_make_state "scope"
# Seed an instance_id in the file by merging it after init
"$STATE_TRANSITION" --state-file "$SF" merge "{\"instance_id\":\"${INSTANCE_ID}\"}"
OUT=$("$STATE_TRANSITION" --state-file "$SF" init - 2>&1 <<< '{"session_id":"x"}')
RC=$?
_assert_exit "ST-q: exit 1 (guard fired)" "1" "$RC"
_assert_contains "ST-q: error mentions instance_id" "instance_id" "$OUT"

# ── ST-r: started_at is included in integrity hash projection (W9 M2) ──
# Verify that mutating started_at outside state-transition.sh causes hash mismatch.
echo ""
echo "── ST-r: started_at change detected by integrity hash ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
# Capture hash after legitimate transition
HASH_BEFORE=$(jq -r '.state_integrity_hash // ""' "$SF" 2>/dev/null)
# Inject a started_at change bypassing state-transition.sh
tmp="${SF}.tmp.$$"
jq '.started_at = "2099-01-01T00:00:00Z"' "$SF" > "$tmp" && mv "$tmp" "$SF"
OUT=$("$STATE_TRANSITION" --state-file "$SF" phase_advance --to "execute" 2>&1)
RC=$?
_assert_exit "ST-r: exit 2 (hash mismatch after started_at mutation)" "2" "$RC"

# ── ST-s: source_of_truth change detected by integrity hash (W9 M2) ──
# Verify that adding an entry to source_of_truth outside state-transition.sh triggers mismatch.
echo ""
echo "── ST-s: source_of_truth structural change detected by integrity hash ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
# Inject a source_of_truth entry bypassing state-transition.sh
tmp="${SF}.tmp.$$"
jq '.source_of_truth = ["injected-file.md"]' "$SF" > "$tmp" && mv "$tmp" "$SF"
OUT=$("$STATE_TRANSITION" --state-file "$SF" phase_advance --to "execute" 2>&1)
RC=$?
_assert_exit "ST-s: exit 2 (hash mismatch after source_of_truth mutation)" "2" "$RC"

# ── ST-t: bar_add appends to .bar[] + hash updated ──────────────────────────
echo ""
echo "── ST-t: bar_add appends bar criterion ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" bar_add --id "G1" --statement "graceful rollback path exists"
RC=$?
_assert_exit "ST-t: exit 0" "0" "$RC"
_assert_jq_eq "ST-t: bar length=1" "$SF" '.bar | length' "1"
_assert_jq_eq "ST-t: bar[0].id=G1" "$SF" '.bar[0].id' "G1"
_assert_jq_eq "ST-t: bar[0].criterion set" "$SF" '.bar[0].criterion' "graceful rollback path exists"
_assert_jq_eq "ST-t: categorical_ban=false" "$SF" '.bar[0].categorical_ban' "false"
_assert_hash_present "ST-t: hash updated" "$SF"
# Verify bar_added event emitted
EVENTS_FILE="${INSTANCE_DIR}/events.jsonl"
if grep -q '"event_type":"bar_added"' "$EVENTS_FILE" 2>/dev/null; then
  _pass "ST-t: bar_added event in events.jsonl"
else
  _fail "ST-t: bar_added event missing from events.jsonl"
fi

# ── ST-u: bar_remove removes entry + hash updated ────────────────────────────
echo ""
echo "── ST-u: bar_remove deletes bar criterion ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" bar_add --id "G1" --statement "criterion one"
"$STATE_TRANSITION" --state-file "$SF" bar_add --id "G2" --statement "criterion two"
"$STATE_TRANSITION" --state-file "$SF" bar_remove --id "G1"
RC=$?
_assert_exit "ST-u: exit 0" "0" "$RC"
_assert_jq_eq "ST-u: bar length=1 after remove" "$SF" '.bar | length' "1"
_assert_jq_eq "ST-u: remaining entry is G2" "$SF" '.bar[0].id' "G2"
_assert_hash_present "ST-u: hash updated" "$SF"

# ── ST-v: guardrail_add appends guardrail + hash updated ─────────────────────
echo ""
echo "── ST-v: guardrail_add appends guardrail ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" guardrail_add --statement "no kill signals" --source "user"
RC=$?
_assert_exit "ST-v: exit 0" "0" "$RC"
_assert_jq_eq "ST-v: guardrails length=1" "$SF" '.guardrails | length' "1"
_assert_jq_eq "ST-v: rule set" "$SF" '.guardrails[0].rule' "no kill signals"
_assert_jq_eq "ST-v: source=user" "$SF" '.guardrails[0].source' "user"
_assert_hash_present "ST-v: hash updated" "$SF"
if grep -q '"event_type":"guardrail_added"' "$EVENTS_FILE" 2>/dev/null; then
  _pass "ST-v: guardrail_added event in events.jsonl"
else
  _fail "ST-v: guardrail_added event missing from events.jsonl"
fi

# ── ST-w: guardrail_replace overwrites rule + hash updated ───────────────────
echo ""
echo "── ST-w: guardrail_replace overwrites guardrail at index ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" guardrail_add --statement "old rule" --source "user"
"$STATE_TRANSITION" --state-file "$SF" guardrail_replace --index 0 --statement "new rule" --source "orchestrator"
RC=$?
_assert_exit "ST-w: exit 0" "0" "$RC"
_assert_jq_eq "ST-w: rule updated" "$SF" '.guardrails[0].rule' "new rule"
_assert_jq_eq "ST-w: source updated" "$SF" '.guardrails[0].source' "orchestrator"
_assert_hash_present "ST-w: hash updated" "$SF"

# ── ST-x: guardrail_remove deletes at index + hash updated ───────────────────
echo ""
echo "── ST-x: guardrail_remove removes guardrail at index ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" guardrail_add --statement "rule zero"
"$STATE_TRANSITION" --state-file "$SF" guardrail_add --statement "rule one"
"$STATE_TRANSITION" --state-file "$SF" guardrail_remove --index 0
RC=$?
_assert_exit "ST-x: exit 0" "0" "$RC"
_assert_jq_eq "ST-x: guardrails length=1 after remove" "$SF" '.guardrails | length' "1"
_assert_jq_eq "ST-x: remaining rule is rule one" "$SF" '.guardrails[0].rule' "rule one"
_assert_hash_present "ST-x: hash updated" "$SF"

# ── ST-y: archive_state renames state.json + events.jsonl ────────────────────
echo ""
echo "── ST-y: archive_state renames state.json and events.jsonl ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" archive_state
RC=$?
_assert_exit "ST-y: exit 0" "0" "$RC"
if [[ ! -f "$SF" ]]; then
  _pass "ST-y: state.json no longer present"
else
  _fail "ST-y: state.json still exists after archive_state"
fi
if [[ -f "${INSTANCE_DIR}/state.archived.json" ]]; then
  _pass "ST-y: state.archived.json created"
else
  _fail "ST-y: state.archived.json not found"
fi
if [[ -f "${INSTANCE_DIR}/events.archived.jsonl" ]]; then
  _pass "ST-y: events.archived.jsonl created"
else
  _fail "ST-y: events.archived.jsonl not found"
fi
if [[ ! -f "${INSTANCE_DIR}/events.jsonl" ]]; then
  _pass "ST-y: events.jsonl no longer present"
else
  _fail "ST-y: events.jsonl still exists after archive_state"
fi

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
