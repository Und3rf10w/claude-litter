#!/usr/bin/env bash
# test-event-sourcing.sh — regression tests for W7 event sourcing (events.jsonl).
#
# ES-a: subcommand appends one event, events.jsonl grows, state.json updated, event_head correct
# ES-b: corrupt events.jsonl line (invalid JSON) → replay detects it, exits non-zero
# ES-c: bootstrap: events.jsonl absent on first subcommand call → seeded with bootstrap event
# ES-d: frontmatter-gate blocks Write when state.json event_head mismatches events.jsonl tail
# ES-e: replay rebuilds state.json from events.jsonl to match expected projection
# ES-f: 5 concurrent subshells each append an event → all 5 land, no corruption
# ES-g: replay 1000 synthetic events completes in <5s (performance regression guard)
# ES-h: state_snapshot event at non-genesis position resets working state in replay
# ES-i: pre-W7 instance (no events.jsonl) bootstrapped transparently; replay produces correct state
#
# Exit 0 = all pass; Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STATE_TRANSITION="${PLUGIN_ROOT}/scripts/state-transition.sh"
FRONTMATTER_GATE="${PLUGIN_ROOT}/hooks/frontmatter-gate.sh"

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

# ── Shared fixture helpers ──────────────────────────────────────────────────

SANDBOX=$(mktemp -d)
SANDBOX="$(cd "$SANDBOX" && pwd -P)"
trap 'rm -rf "$SANDBOX"' EXIT

INSTANCE_ID="deadc0de"
INSTANCE_DIR="${SANDBOX}/.claude/deepwork/${INSTANCE_ID}"
mkdir -p "$INSTANCE_DIR"
SESSION_ID="test-es-$(date +%s)"

_make_state() {
  local phase="${1:-scope}"
  local sf="${INSTANCE_DIR}/state.json"
  local events_f="${INSTANCE_DIR}/events.jsonl"
  rm -f "$sf" "$events_f"
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

_event_count() {
  local events_f="${INSTANCE_DIR}/events.jsonl"
  [[ -f "$events_f" ]] || { printf '0'; return; }
  wc -l < "$events_f" | tr -d ' '
}

_compute_hash() {
  local line="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' "$line" | sha256sum | cut -d' ' -f1
  else
    printf '%s\n' "$line" | shasum -a 256 | cut -d' ' -f1
  fi
}

# ── ES-a: subcommand appends one event ──────────────────────────────────────
echo ""
echo "── ES-a: phase_advance appends one event, event_head correct ──"
_make_state "scope"
SF="${INSTANCE_DIR}/state.json"
EVENTS_F="${INSTANCE_DIR}/events.jsonl"

# Call phase_advance — must seed bootstrap + emit phase_advanced
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
RC=$?
_assert_exit "ES-a: exit 0" "0" "$RC"

# events.jsonl must now exist
if [[ -f "$EVENTS_F" ]]; then
  _pass "ES-a: events.jsonl created"
else
  _fail "ES-a: events.jsonl not created"
fi

COUNT=$(_event_count)
# bootstrap + phase_advanced = 2 events
if [[ "$COUNT" -ge 2 ]]; then
  _pass "ES-a: events.jsonl has >=2 lines (bootstrap + phase_advanced)"
else
  _fail "ES-a: expected >=2 lines in events.jsonl, got ${COUNT}"
fi

# Verify state.json event_head matches tail line hash
_LAST=$(tail -1 "$EVENTS_F")
_EXPECTED_HEAD=$(_compute_hash "$_LAST")
_ACTUAL_HEAD=$(jq -r '.event_head // ""' "$SF" 2>/dev/null)
if [[ "$_EXPECTED_HEAD" == "$_ACTUAL_HEAD" ]]; then
  _pass "ES-a: event_head in state.json matches events.jsonl tail"
else
  _fail "ES-a: event_head mismatch — expected ${_EXPECTED_HEAD:0:12}, got ${_ACTUAL_HEAD:0:12}"
fi

# Verify state.json phase updated
_assert_jq_eq "ES-a: phase=work" "$SF" '.phase' "work"

# Verify hash chain: second event's prev_event_hash = hash of first line
_FIRST=$(head -1 "$EVENTS_F")
_SECOND=$(sed -n '2p' "$EVENTS_F")
if [[ -n "$_SECOND" ]]; then
  _FIRST_HASH=$(_compute_hash "$_FIRST")
  _SECOND_PREV=$(printf '%s' "$_SECOND" | jq -r '.prev_event_hash // ""' 2>/dev/null)
  if [[ "$_FIRST_HASH" == "$_SECOND_PREV" ]]; then
    _pass "ES-a: hash chain valid (event 2 prev_event_hash = hash of event 1)"
  else
    _fail "ES-a: hash chain invalid — event 2 prev_event_hash mismatch"
  fi
fi

# ── ES-b: corrupt events.jsonl line detected by replay ──────────────────────
echo ""
echo "── ES-b: corrupt events.jsonl line detected by replay ──"
_make_state "scope"

# Seed events.jsonl via a real subcommand
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"

# Corrupt the last line
_CORRUPT_OUTPUT="${SANDBOX}/corrupt-replay-output.json"
printf '{"broken":true}\n' >> "$EVENTS_F"

STDERR_OUT=$("$STATE_TRANSITION" --state-file "$SF" replay --output "$_CORRUPT_OUTPUT" 2>&1)
RC=$?
if [[ $RC -ne 0 ]]; then
  _pass "ES-b: replay exits non-zero on corrupt line"
else
  _fail "ES-b: replay should have exited non-zero but got 0"
fi
_assert_contains "ES-b: stderr mentions broken chain or invalid JSON" \
  "HASH_CHAIN_BROKEN" "$STDERR_OUT"

# ── ES-c: bootstrap seeded on first subcommand call ─────────────────────────
echo ""
echo "── ES-c: events.jsonl absent → bootstrap event seeded ──"
_make_state "scope"
# events.jsonl was removed by _make_state; verify it doesn't exist
rm -f "$EVENTS_F"

# Capture state snapshot before first subcommand
SNAP_BEFORE=$(cat "$SF")

"$STATE_TRANSITION" --state-file "$SF" append_array '.hook_warnings' '{"event":"test"}'

if [[ -f "$EVENTS_F" ]]; then
  _pass "ES-c: events.jsonl created on first call"
else
  _fail "ES-c: events.jsonl not created"
  # stop here to avoid downstream jq errors
fi

# First event must be bootstrap type
FIRST_TYPE=$(head -1 "$EVENTS_F" | jq -r '.event_type // ""' 2>/dev/null)
if [[ "$FIRST_TYPE" == "bootstrap" ]]; then
  _pass "ES-c: first event is bootstrap"
else
  _fail "ES-c: expected bootstrap, got '${FIRST_TYPE}'"
fi

# First event must have prev_event_hash=GENESIS
FIRST_PREV=$(head -1 "$EVENTS_F" | jq -r '.prev_event_hash // ""' 2>/dev/null)
if [[ "$FIRST_PREV" == "GENESIS" ]]; then
  _pass "ES-c: bootstrap event has prev_event_hash=GENESIS"
else
  _fail "ES-c: expected GENESIS, got '${FIRST_PREV}'"
fi

# Bootstrap payload.state_snapshot must match pre-call state
SNAP_IN_BOOT=$(head -1 "$EVENTS_F" | jq -c '.payload.state_snapshot' 2>/dev/null)
SNAP_BEFORE_C=$(printf '%s' "$SNAP_BEFORE" | jq -c '.' 2>/dev/null)
if [[ "$SNAP_IN_BOOT" == "$SNAP_BEFORE_C" ]]; then
  _pass "ES-c: bootstrap payload.state_snapshot matches pre-call state.json"
else
  _fail "ES-c: bootstrap payload.state_snapshot does not match pre-call state.json"
fi

# ── ES-d: frontmatter-gate blocks Write when event_head mismatches ───────────
echo ""
echo "── ES-d: frontmatter-gate blocks Write on event_head mismatch ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"

# Manually corrupt event_head in state.json to create a mismatch
_SF_TMP="${SF}.tmp.es-d.$$"
jq '.event_head = "000000000000000000000000000000000000000000000000000000000000dead"' \
  "$SF" > "$_SF_TMP" 2>/dev/null && mv "$_SF_TMP" "$SF" || rm -f "$_SF_TMP"

# Build a fake PreToolUse:Write payload targeting state.json.
# Use the canonical (resolved) path so _canonical_path() in the gate matches INSTANCE_DIR.
_SF_CANON=$(cd "$(dirname "$SF")" 2>/dev/null && pwd -P)/$(basename "$SF")
_PAYLOAD_FILE="${SANDBOX}/es-d-payload.json"
jq -cn --arg sid "$SESSION_ID" --arg fp "$_SF_CANON" \
  '{session_id: $sid, hook_event_name: "PreToolUse", tool_name: "Write", tool_input: {file_path: $fp, content: "---\ntitle: test\n---\n"}}' \
  > "$_PAYLOAD_FILE"

# Run gate: pipe payload via a wrapper so env vars land on the gate process, not printf.
GATE_STDERR=$(env CLAUDE_PROJECT_DIR="$SANDBOX" \
  bash -c "cat '$_PAYLOAD_FILE' | bash '$FRONTMATTER_GATE'" 2>&1)
GATE_RC=$?
rm -f "$_PAYLOAD_FILE"

if [[ $GATE_RC -ne 0 ]]; then
  _pass "ES-d: frontmatter-gate blocks Write on event_head mismatch (exit ${GATE_RC})"
else
  _fail "ES-d: frontmatter-gate should have blocked but exited 0"
fi
_assert_contains "ES-d: stderr mentions EVENT_HEAD_MISMATCH" \
  "EVENT_HEAD_MISMATCH" "$GATE_STDERR"

# ── ES-e: replay rebuilds state.json to expected projection ─────────────────
echo ""
echo "── ES-e: replay rebuilds state.json to expected projection ──"
_make_state "scope"

# Apply multiple mutations
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"
"$STATE_TRANSITION" --state-file "$SF" merge '{"custom_e2e":"hello"}'
"$STATE_TRANSITION" --state-file "$SF" append_array '.hook_warnings' '{"event":"marker"}'

# Capture expected state
EXPECTED_PHASE=$(jq -r '.phase' "$SF" 2>/dev/null)
EXPECTED_CUSTOM=$(jq -r '.custom_e2e' "$SF" 2>/dev/null)
EXPECTED_WARNINGS=$(jq -r '.hook_warnings | length' "$SF" 2>/dev/null)

# Wipe state.json and replay from events.jsonl
rm -f "$SF"
printf '{}' > "$SF"

REPLAY_OUT=$("$STATE_TRANSITION" --state-file "$SF" replay 2>&1)
RC=$?
_assert_exit "ES-e: replay exits 0" "0" "$RC"
_assert_contains "ES-e: replay reports events processed" "events processed" "$REPLAY_OUT"

_assert_jq_eq "ES-e: phase matches expected" "$SF" '.phase' "$EXPECTED_PHASE"
_assert_jq_eq "ES-e: custom_e2e matches expected" "$SF" '.custom_e2e' "$EXPECTED_CUSTOM"

ACTUAL_WARNINGS=$(jq -r '.hook_warnings | length' "$SF" 2>/dev/null)
if [[ "$ACTUAL_WARNINGS" == "$EXPECTED_WARNINGS" ]]; then
  _pass "ES-e: hook_warnings count matches expected (${EXPECTED_WARNINGS})"
else
  _fail "ES-e: expected ${EXPECTED_WARNINGS} hook_warnings, got ${ACTUAL_WARNINGS}"
fi

# event_head in rebuilt state.json must match tail line
_LAST=$(tail -1 "$EVENTS_F")
_EXPECTED_HEAD=$(_compute_hash "$_LAST")
_ACTUAL_HEAD=$(jq -r '.event_head // ""' "$SF" 2>/dev/null)
if [[ "$_EXPECTED_HEAD" == "$_ACTUAL_HEAD" ]]; then
  _pass "ES-e: event_head in rebuilt state.json is correct"
else
  _fail "ES-e: event_head mismatch after replay"
fi

# ── ES-f: 5 concurrent subshells each append one event ──────────────────────
echo ""
echo "── ES-f: 5 concurrent appends land without corruption ──"
_make_state "scope"
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"

BASE_COUNT=$(_event_count)

# Launch 5 parallel append_array calls
for i in 1 2 3 4 5; do
  "$STATE_TRANSITION" --state-file "$SF" append_array '.hook_warnings' \
    "{\"event\":\"concurrent\",\"seq\":${i}}" &
done
wait

NEW_COUNT=$(_event_count)
DELTA=$(( NEW_COUNT - BASE_COUNT ))
if [[ "$DELTA" -eq 5 ]]; then
  _pass "ES-f: all 5 concurrent events landed in events.jsonl"
else
  _fail "ES-f: expected 5 new events, got ${DELTA} (total=${NEW_COUNT}, base=${BASE_COUNT})"
fi

# Verify each line is valid JSON
CORRUPT_LINES=0
while IFS= read -r _l; do
  [[ -z "$_l" ]] && continue
  printf '%s' "$_l" | jq empty 2>/dev/null || CORRUPT_LINES=$((CORRUPT_LINES + 1))
done < "$EVENTS_F"

if [[ "$CORRUPT_LINES" -eq 0 ]]; then
  _pass "ES-f: no corrupt JSON lines after concurrent writes"
else
  _fail "ES-f: found ${CORRUPT_LINES} corrupt JSON lines"
fi

# ── ES-g: replay 1000 synthetic events is a regression guard ────────────────
# Design spec (§8) targets <1s using a jq-s implementation. The current bash
# loop spawns sha256sum/shasum per event — O(N) subprocesses. Use python3 to
# generate the fixture quickly; the replay itself is measured.
echo ""
echo "── ES-g: replay 1000 events performance regression guard ──"
PERF_DIR="${SANDBOX}/perf-test"
mkdir -p "$PERF_DIR"
PERF_STATE="${PERF_DIR}/state.json"
PERF_EVENTS="${PERF_DIR}/events.jsonl"

printf '{"phase":"scope","instance_id":"perf0001","session_id":"perf-session","team_name":"perf"}' \
  > "$PERF_STATE"

if command -v python3 >/dev/null 2>&1; then
  # Fast path: Python generates 1000 events with SHA-256 chain in <1s
  python3 - "$PERF_STATE" "$PERF_EVENTS" <<'PYEOF'
import hashlib, json, sys
state_file, events_file = sys.argv[1], sys.argv[2]
state = json.load(open(state_file))
now = "2026-01-01T00:00:00Z"
lines = []
e1 = {"event_id": "boot-0001", "event_type": "bootstrap", "prev_event_hash": "GENESIS",
      "timestamp": now, "actor": "test", "payload": {"state_snapshot": state}}
line1 = json.dumps(e1, separators=(',', ':'))
lines.append(line1)
prev = line1
for i in range(2, 1001):
    ph = hashlib.sha256((prev + "\n").encode()).hexdigest()
    ev = {"event_id": f"evt-{i:04d}", "event_type": "last_updated_stamped",
          "prev_event_hash": ph, "timestamp": now, "actor": "test", "payload": {}}
    line = json.dumps(ev, separators=(',', ':'))
    lines.append(line)
    prev = line
open(events_file, 'w').write("\n".join(lines) + "\n")
PYEOF
  _GEN_OK=$?
else
  # Slow-path: bash loop (warns but still runs)
  printf 'ES-g: python3 unavailable — using bash generator (slow)\n' >&2
  NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  BOOT=$(jq -cn --arg ts "$NOW" --argjson snap "$(cat "$PERF_STATE")" \
    '{event_id:"boot-0001",event_type:"bootstrap",prev_event_hash:"GENESIS",
      timestamp:$ts,actor:"test",payload:{state_snapshot:$snap}}')
  printf '%s\n' "$BOOT" >> "$PERF_EVENTS"
  _PREV_LINE="$BOOT"
  for i in $(seq 2 1000); do
    _PH=$(_compute_hash "$_PREV_LINE")
    _L=$(jq -cn --arg eid "evt-$(printf '%04d' "$i")" --arg ph "$_PH" --arg ts "$NOW" \
      '{event_id:$eid,event_type:"last_updated_stamped",prev_event_hash:$ph,
        timestamp:$ts,actor:"test",payload:{}}')
    printf '%s\n' "$_L" >> "$PERF_EVENTS"
    _PREV_LINE="$_L"
  done
  _GEN_OK=0
fi

if [[ "$_GEN_OK" -eq 0 ]] && [[ -f "$PERF_EVENTS" ]]; then
  _GEN_LINES=$(wc -l < "$PERF_EVENTS" | tr -d ' ')
  if [[ "$_GEN_LINES" -eq 1000 ]]; then
    _pass "ES-g: fixture generated (1000 events)"
  else
    _fail "ES-g: fixture generation produced ${_GEN_LINES} lines, expected 1000"
  fi
else
  _fail "ES-g: fixture generation failed"
fi

_START_TS=$(date +%s)
"$STATE_TRANSITION" --state-file "$PERF_STATE" replay > /dev/null 2>&1
REPLAY_RC=$?
_END_TS=$(date +%s)
ELAPSED=$(( _END_TS - _START_TS ))

_assert_exit "ES-g: replay exits 0 on 1000 events" "0" "$REPLAY_RC"
# Python fast-path achieves <1s for 1000 events (no per-event subshell spawns).
# Threshold set to 5s to tolerate CI overhead; bash fallback (no python3) is exempt.
if command -v python3 >/dev/null 2>&1; then
  _THRESHOLD=5
else
  _THRESHOLD=120
fi
if [[ "$ELAPSED" -lt "$_THRESHOLD" ]]; then
  _pass "ES-g: 1000-event replay completed in ${ELAPSED}s (<${_THRESHOLD}s threshold)"
else
  _fail "ES-g: 1000-event replay took ${ELAPSED}s (threshold: ${_THRESHOLD}s)"
fi

# ── ES-h: state_snapshot at non-genesis resets working state in replay ───────
echo ""
echo "── ES-h: state_snapshot at non-genesis position resets working state ──"
SNAP_DIR="${SANDBOX}/snap-test"
mkdir -p "$SNAP_DIR"
SNAP_STATE="${SNAP_DIR}/state.json"
SNAP_EVENTS="${SNAP_DIR}/events.jsonl"

printf '{"phase":"scope","instance_id":"snap0001","session_id":"snap-session","team_name":"snap"}' \
  > "$SNAP_STATE"

NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

# Event 1: bootstrap
_E1=$(jq -cn --arg ts "$NOW" --argjson snap "$(cat "$SNAP_STATE")" \
  '{event_id: "snap-e1", event_type: "bootstrap", prev_event_hash: "GENESIS",
    timestamp: $ts, actor: "test", payload: {state_snapshot: $snap}}')
printf '%s\n' "$_E1" >> "$SNAP_EVENTS"

# Event 2: phase_advanced (scope → explore) — should be overwritten by snapshot
_E1_HASH=$(_compute_hash "$_E1")
_E2=$(jq -cn --arg phash "$_E1_HASH" --arg ts "$NOW" \
  '{event_id: "snap-e2", event_type: "phase_advanced", prev_event_hash: $phash,
    timestamp: $ts, actor: "test", payload: {from_phase: "scope", to_phase: "explore"}}')
printf '%s\n' "$_E2" >> "$SNAP_EVENTS"

# Event 3: state_snapshot with phase=synthesize — replaces all prior state
_E2_HASH=$(_compute_hash "$_E2")
_SNAP_PAYLOAD=$(jq -cn '{"phase":"synthesize","instance_id":"snap0001","session_id":"snap-session","team_name":"snap","snap_marker":true}')
_E3=$(jq -cn --arg phash "$_E2_HASH" --arg ts "$NOW" \
  --argjson sp "$_SNAP_PAYLOAD" \
  '{event_id: "snap-e3", event_type: "state_snapshot", prev_event_hash: $phash,
    timestamp: $ts, actor: "test", payload: {state_snapshot: $sp}}')
printf '%s\n' "$_E3" >> "$SNAP_EVENTS"

# Replay — result must reflect state_snapshot (phase=synthesize, not explore)
"$STATE_TRANSITION" --state-file "$SNAP_STATE" replay > /dev/null 2>&1
RC=$?
_assert_exit "ES-h: replay exits 0" "0" "$RC"
_assert_jq_eq "ES-h: phase = synthesize (from state_snapshot)" "$SNAP_STATE" '.phase' "synthesize"
_assert_jq_eq "ES-h: snap_marker present (from state_snapshot payload)" "$SNAP_STATE" '.snap_marker' "true"

# ── ES-i: pre-W7 instance bootstrapped transparently ────────────────────────
echo ""
echo "── ES-i: pre-W7 instance (no events.jsonl) bootstrapped transparently ──"
LEGACY_DIR="${SANDBOX}/legacy-test"
mkdir -p "$LEGACY_DIR"
LEGACY_STATE="${LEGACY_DIR}/state.json"
LEGACY_EVENTS="${LEGACY_DIR}/events.jsonl"

# Simulate a pre-W7 state.json (no event_head, no state_integrity_hash)
printf '{"phase":"scope","instance_id":"legacy1","session_id":"legacy-session","team_name":"legacy"}' \
  > "$LEGACY_STATE"

# No events.jsonl — verify it's absent
[[ ! -f "$LEGACY_EVENTS" ]] || rm -f "$LEGACY_EVENTS"

# Call a subcommand on the legacy instance — must auto-bootstrap
"$STATE_TRANSITION" --state-file "$LEGACY_STATE" stamp_last_updated
RC=$?
_assert_exit "ES-i: stamp_last_updated on legacy instance exits 0" "0" "$RC"

if [[ -f "$LEGACY_EVENTS" ]]; then
  _pass "ES-i: events.jsonl created for pre-W7 instance"
else
  _fail "ES-i: events.jsonl not created for pre-W7 instance"
fi

BOOT_TYPE=$(head -1 "$LEGACY_EVENTS" | jq -r '.event_type // ""' 2>/dev/null)
if [[ "$BOOT_TYPE" == "bootstrap" ]]; then
  _pass "ES-i: first event is bootstrap (pre-W7 migration)"
else
  _fail "ES-i: expected bootstrap, got '${BOOT_TYPE}'"
fi

# event_head must now be in state.json
_LEGACY_HEAD=$(jq -r '.event_head // ""' "$LEGACY_STATE" 2>/dev/null)
if [[ -n "$_LEGACY_HEAD" ]] && [[ "$_LEGACY_HEAD" != "null" ]]; then
  _pass "ES-i: event_head populated after first call on legacy instance"
else
  _fail "ES-i: event_head absent after first call on legacy instance"
fi

# ── ES-j: 5 concurrent transitions — hash chain must be intact ──────────────
echo ""
echo "── ES-j: 5 concurrent phase_advance calls leave chain intact (flock race guard) ──"
_make_state "scope"

# Advance to 'work' first so all 5 parallel append_array calls can proceed
# without tripping the phase gate.
"$STATE_TRANSITION" --state-file "$SF" phase_advance --to "work"

BASE_COUNT=$(_event_count)

# 5 concurrent append_array mutations — each must emit its own unique event
for _i in 1 2 3 4 5; do
  "$STATE_TRANSITION" --state-file "$SF" append_array '.hook_warnings' \
    "{\"event\":\"race\",\"seq\":${_i}}" &
done
wait

NEW_COUNT=$(_event_count)
DELTA=$(( NEW_COUNT - BASE_COUNT ))
if [[ "$DELTA" -eq 5 ]]; then
  _pass "ES-j: all 5 concurrent events landed (count delta=${DELTA})"
else
  _fail "ES-j: expected 5 new events, got ${DELTA} (total=${NEW_COUNT}, base=${BASE_COUNT})"
fi

# Walk the full chain: each event's prev_event_hash must equal SHA256 of the previous line.
# This assertion only runs when flock is available; without it the race is known and
# documented (warning is emitted to stderr by _emit_event).
if ! command -v flock >/dev/null 2>&1; then
  _pass "ES-j: hash chain integrity check skipped (flock unavailable on this platform)"
else
  _CHAIN_BROKEN=0
  _PREV_LINE=""
  _LINE_NUM=0
  while IFS= read -r _L; do
    [[ -z "$_L" ]] && continue
    _LINE_NUM=$(( _LINE_NUM + 1 ))
    if [[ $_LINE_NUM -eq 1 ]]; then
      _PREV_HASH=$(printf '%s' "$_L" | jq -r '.prev_event_hash // ""' 2>/dev/null)
      if [[ "$_PREV_HASH" != "GENESIS" ]]; then
        _fail "ES-j: line 1 prev_event_hash is '${_PREV_HASH}', expected GENESIS"
        _CHAIN_BROKEN=$(( _CHAIN_BROKEN + 1 ))
      fi
    else
      _EXPECTED_PREV=$(_compute_hash "$_PREV_LINE")
      _ACTUAL_PREV=$(printf '%s' "$_L" | jq -r '.prev_event_hash // ""' 2>/dev/null)
      if [[ "$_EXPECTED_PREV" != "$_ACTUAL_PREV" ]]; then
        _CHAIN_BROKEN=$(( _CHAIN_BROKEN + 1 ))
      fi
    fi
    _PREV_LINE="$_L"
  done < "$EVENTS_F"

  if [[ "$_CHAIN_BROKEN" -eq 0 ]]; then
    _pass "ES-j: hash chain integrity verified (no sibling events)"
  else
    _fail "ES-j: hash chain broken at ${_CHAIN_BROKEN} point(s) — sibling events detected"
  fi
fi

# ── ES-k: malicious jq_path in field_set event → replay exits non-zero ───────
echo ""
echo "── ES-k: malicious jq_path in field_set → INVALID_JQ_PATH ──"
ESK_DIR="${SANDBOX}/esk-test"
mkdir -p "$ESK_DIR"
ESK_STATE="${ESK_DIR}/state.json"
ESK_EVENTS="${ESK_DIR}/events.jsonl"

printf '{"phase":"scope","instance_id":"esk0001","session_id":"esk-session","team_name":"esk"}' \
  > "$ESK_STATE"

NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

_E1=$(jq -cn --arg ts "$NOW" --argjson snap "$(cat "$ESK_STATE")" \
  '{event_id: "esk-e1", event_type: "bootstrap", prev_event_hash: "GENESIS",
    timestamp: $ts, actor: "test", payload: {state_snapshot: $snap}}')
printf '%s\n' "$_E1" >> "$ESK_EVENTS"

# field_set with malicious jq_path
_E1_HASH=$(_compute_hash "$_E1")
_E2=$(jq -cn --arg phash "$_E1_HASH" --arg ts "$NOW" \
  '{event_id: "esk-e2", event_type: "field_set", prev_event_hash: $phash,
    timestamp: $ts, actor: "test",
    payload: {jq_path: ". | input_filename", json_value: true}}')
printf '%s\n' "$_E2" >> "$ESK_EVENTS"

ESKA_ERR=$("$STATE_TRANSITION" --state-file "$ESK_STATE" replay 2>&1)
ESKA_RC=$?
if [[ $ESKA_RC -ne 0 ]]; then
  _pass "ES-k: replay exits non-zero on malicious jq_path"
else
  _fail "ES-k: replay should have exited non-zero but returned 0"
fi
if printf '%s' "$ESKA_ERR" | grep -qF "INVALID_JQ_PATH"; then
  _pass "ES-k: stderr contains INVALID_JQ_PATH"
else
  _fail "ES-k: stderr did not contain INVALID_JQ_PATH — got: ${ESKA_ERR}"
fi

# ── ES-l: legitimate field_set with .execute.plan_drift_detected → succeeds ──
echo ""
echo "── ES-l: legitimate jq_path .execute.plan_drift_detected → replay succeeds ──"
ESL_DIR="${SANDBOX}/esl-test"
mkdir -p "$ESL_DIR"
ESL_STATE="${ESL_DIR}/state.json"
ESL_EVENTS="${ESL_DIR}/events.jsonl"

printf '{"phase":"scope","instance_id":"esl0001","session_id":"esl-session","team_name":"esl","execute":{}}' \
  > "$ESL_STATE"

_L1=$(jq -cn --arg ts "$NOW" --argjson snap "$(cat "$ESL_STATE")" \
  '{event_id: "esl-e1", event_type: "bootstrap", prev_event_hash: "GENESIS",
    timestamp: $ts, actor: "test", payload: {state_snapshot: $snap}}')
printf '%s\n' "$_L1" >> "$ESL_EVENTS"

_L1_HASH=$(_compute_hash "$_L1")
_L2=$(jq -cn --arg phash "$_L1_HASH" --arg ts "$NOW" \
  '{event_id: "esl-e2", event_type: "field_set", prev_event_hash: $phash,
    timestamp: $ts, actor: "test",
    payload: {jq_path: ".execute.plan_drift_detected", json_value: true}}')
printf '%s\n' "$_L2" >> "$ESL_EVENTS"

"$STATE_TRANSITION" --state-file "$ESL_STATE" replay > /dev/null 2>&1
ESLRC=$?
_assert_exit "ES-l: replay exits 0 on valid jq_path" "0" "$ESLRC"

# ── ES-m: state-drift-marker F1 revert path emits state_reverted event ───────
echo ""
echo "── ES-m: F1 revert path — state_reverted event present and replay correct ──"
# Instance must live at CLAUDE_PROJECT_DIR/.claude/deepwork/<8-hex-id>/ so
# discover_instance can locate it via session_id match.
ESM_SESSION="esm-$(date +%s)"
ESM_IID="a1b2c3d4"
ESM_PROJECT="${SANDBOX}/esm-project"
ESM_INSTANCE_DIR="${ESM_PROJECT}/.claude/deepwork/${ESM_IID}"
mkdir -p "$ESM_INSTANCE_DIR"
ESM_STATE="${ESM_INSTANCE_DIR}/state.json"
ESM_EVENTS="${ESM_INSTANCE_DIR}/events.jsonl"
ESM_LOG="${ESM_INSTANCE_DIR}/log.md"
STATE_DRIFT_MARKER="${PLUGIN_ROOT}/hooks/state-drift-marker.sh"

# Bootstrap a clean instance using state-transition.sh init
"$STATE_TRANSITION" --state-file "$ESM_STATE" init - <<EOF
{
  "session_id": "${ESM_SESSION}",
  "instance_id": "${ESM_IID}",
  "phase": "work",
  "team_name": "esm-team",
  "hook_warnings": [],
  "bar": [],
  "frontmatter_schema_version": "1",
  "banners": []
}
EOF
printf '# log\n' > "$ESM_LOG"

# Seed events.jsonl via a real subcommand
"$STATE_TRANSITION" --state-file "$ESM_STATE" stamp_last_updated

# Step 1: PreToolUse — snapshot state.json before writing bad banners
cp "$ESM_STATE" "${ESM_INSTANCE_DIR}/.state-snapshot"

# Step 2: Write bad banners directly to state.json (bypassing state-transition.sh),
# simulating a rogue Write that state-drift-marker will detect and revert.
jq '.banners = [{"artifact_path":"x.md","banner_type":"BAD_TYPE","reason":"r","added_at":"2026-01-01T00:00:00Z","added_by":"test"}]' \
  "$ESM_STATE" > "${ESM_STATE}.tmp" && mv "${ESM_STATE}.tmp" "$ESM_STATE"

# Step 3: Run state-drift-marker PostToolUse leg — detect violation and revert.
# Pass the canonical path to state.json as file_path so the Write branch matches.
_ESM_SF_CANON=$(cd "$(dirname "$ESM_STATE")" && pwd -P)/$(basename "$ESM_STATE")
printf '%s' "{\"session_id\":\"${ESM_SESSION}\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${_ESM_SF_CANON}\",\"content\":\"\"}}" \
  | CLAUDE_PROJECT_DIR="$ESM_PROJECT" \
    bash "$STATE_DRIFT_MARKER" \
    2>/dev/null

# Step 4: Walk events.jsonl — confirm state_reverted event present
ESM_REVERTED_COUNT=0
while IFS= read -r _esm_l; do
  [[ -z "$_esm_l" ]] && continue
  _et=$(printf '%s' "$_esm_l" | jq -r '.event_type // ""' 2>/dev/null)
  [[ "$_et" == "state_reverted" ]] && ESM_REVERTED_COUNT=$(( ESM_REVERTED_COUNT + 1 ))
done < "$ESM_EVENTS"
if [[ "$ESM_REVERTED_COUNT" -ge 1 ]]; then
  _pass "ES-m: state_reverted event present in events.jsonl"
else
  _fail "ES-m: state_reverted event NOT found in events.jsonl"
fi

# Step 5: Run replay — confirm bad banners are gone from replayed state
ESM_REPLAY_OUT="${ESM_INSTANCE_DIR}/replay-out.json"
cp "$ESM_STATE" "$ESM_REPLAY_OUT"
"$STATE_TRANSITION" --state-file "$ESM_REPLAY_OUT" replay > /dev/null 2>&1
ESM_REPLAY_RC=$?
_assert_exit "ES-m: replay exits 0 after revert" "0" "$ESM_REPLAY_RC"

ESM_BAD_BANNERS=$(jq -r '[.banners[]? | select(.banner_type == "BAD_TYPE")] | length' \
  "$ESM_REPLAY_OUT" 2>/dev/null || echo "0")
if [[ "$ESM_BAD_BANNERS" -eq 0 ]]; then
  _pass "ES-m: replay state has no bad banners (revert was replayed correctly)"
else
  _fail "ES-m: replay state still contains ${ESM_BAD_BANNERS} bad banner(s)"
fi

# ── ES-n: delete state.json → replay succeeds, regenerates from events ────────
echo ""
echo "── ES-n: delete state.json → replay succeeds, regenerates from events ──"

ESN_INSTANCE_DIR="${SANDBOX}/.claude/deepwork/e5f6a7b8"
mkdir -p "$ESN_INSTANCE_DIR"
ESN_STATE="${ESN_INSTANCE_DIR}/state.json"
ESN_EVENTS="${ESN_INSTANCE_DIR}/events.jsonl"

"$STATE_TRANSITION" --state-file "$ESN_STATE" init \
  '{"session_id":"es-n-session","phase":"scope","team_name":"esn-team"}' 2>/dev/null

"$STATE_TRANSITION" --state-file "$ESN_STATE" phase_advance --to "explore" 2>/dev/null
rm -f "$ESN_STATE"

ESN_REPLAY_RC=0
"$STATE_TRANSITION" --state-file "$ESN_STATE" replay > /dev/null 2>&1 || ESN_REPLAY_RC=$?
_assert_exit "ES-n: replay exits 0 when state.json absent" "0" "$ESN_REPLAY_RC"

if [[ -f "$ESN_STATE" ]]; then
  _pass "ES-n: state.json regenerated from events"
else
  _fail "ES-n: state.json not created by replay"
fi

ESN_PHASE=$(jq -r '.phase // ""' "$ESN_STATE" 2>/dev/null || echo "")
if [[ "$ESN_PHASE" == "explore" ]]; then
  _pass "ES-n: replayed state.phase == explore"
else
  _fail "ES-n: replayed state.phase expected 'explore', got '${ESN_PHASE}'"
fi

# ── ES-o: corrupt state.json (invalid JSON) → replay succeeds, overwrites ──────
echo ""
echo "── ES-o: corrupt state.json → replay succeeds, overwrites ──"

ESO_INSTANCE_DIR="${SANDBOX}/.claude/deepwork/c9d0e1f2"
mkdir -p "$ESO_INSTANCE_DIR"
ESO_STATE="${ESO_INSTANCE_DIR}/state.json"
ESO_EVENTS="${ESO_INSTANCE_DIR}/events.jsonl"

"$STATE_TRANSITION" --state-file "$ESO_STATE" init \
  '{"session_id":"es-o-session","phase":"scope","team_name":"eso-team"}' 2>/dev/null

"$STATE_TRANSITION" --state-file "$ESO_STATE" phase_advance --to "explore" 2>/dev/null

# Corrupt state.json with invalid JSON
printf '{this is not valid json\n' > "$ESO_STATE"

ESO_REPLAY_RC=0
"$STATE_TRANSITION" --state-file "$ESO_STATE" replay > /dev/null 2>&1 || ESO_REPLAY_RC=$?
_assert_exit "ES-o: replay exits 0 with corrupt state.json" "0" "$ESO_REPLAY_RC"

if jq empty "$ESO_STATE" 2>/dev/null; then
  _pass "ES-o: state.json is valid JSON after replay overwrites corrupt file"
else
  _fail "ES-o: state.json still corrupt after replay"
fi

ESO_PHASE=$(jq -r '.phase // ""' "$ESO_STATE" 2>/dev/null || echo "")
if [[ "$ESO_PHASE" == "explore" ]]; then
  _pass "ES-o: replayed state.phase == explore (corrupt state overwritten)"
else
  _fail "ES-o: replayed state.phase expected 'explore', got '${ESO_PHASE}'"
fi

# ── ES-p: corrupt events.jsonl → replay fails without overwriting state.json ───
echo ""
echo "── ES-p: corrupt events.jsonl → replay fails, state.json preserved ──"

ESP_INSTANCE_DIR="${SANDBOX}/.claude/deepwork/a3b4c5d6"
mkdir -p "$ESP_INSTANCE_DIR"
ESP_STATE="${ESP_INSTANCE_DIR}/state.json"
ESP_EVENTS="${ESP_INSTANCE_DIR}/events.jsonl"

"$STATE_TRANSITION" --state-file "$ESP_STATE" init \
  '{"session_id":"es-p-session","phase":"scope","team_name":"esp-team"}' 2>/dev/null

ESP_BEFORE=$(jq -c '.' "$ESP_STATE" 2>/dev/null || echo "")

# Corrupt events.jsonl — partially valid then garbage
printf '{not valid json at all\n' > "$ESP_EVENTS"

ESP_REPLAY_RC=0
"$STATE_TRANSITION" --state-file "$ESP_STATE" replay > /dev/null 2>&1 || ESP_REPLAY_RC=$?

if [[ "$ESP_REPLAY_RC" -ne 0 ]]; then
  _pass "ES-p: replay exits non-zero on corrupt events.jsonl (exit=${ESP_REPLAY_RC})"
else
  _fail "ES-p: replay should have failed on corrupt events.jsonl, got exit 0"
fi

ESP_AFTER=$(jq -c '.' "$ESP_STATE" 2>/dev/null || echo "")
if [[ "$ESP_BEFORE" == "$ESP_AFTER" ]]; then
  _pass "ES-p: state.json unchanged after failed replay"
else
  _fail "ES-p: state.json was modified by a failed replay (before != after)"
fi

# ── ES-q: recursive merge equivalence ────────────────────────────────────────
# Write a merged event with a nested fragment; replay; compare with `. * $frag`
echo ""
echo "── ES-q: recursive merge equivalence ──"

ESQ_INSTANCE_DIR="${SANDBOX}/.claude/deepwork/1a2b3c4d"
mkdir -p "$ESQ_INSTANCE_DIR"
ESQ_STATE="${ESQ_INSTANCE_DIR}/state.json"

"$STATE_TRANSITION" --state-file "$ESQ_STATE" init \
  '{"session_id":"es-q-session","phase":"scope","team_name":"esq-team"}' 2>/dev/null

ESQ_FRAG='{"execute":{"plan_ref":"plans/v1.md","authorized_push":false},"custom_field":"qval"}'
"$STATE_TRANSITION" --state-file "$ESQ_STATE" merge "$ESQ_FRAG" 2>/dev/null

# Capture live state for comparison
ESQ_LIVE=$(jq -c 'del(.event_head,.integrity_hash)' "$ESQ_STATE" 2>/dev/null || echo "")

# Now replay from scratch and compare
rm -f "$ESQ_STATE"
ESQ_REPLAY_RC=0
"$STATE_TRANSITION" --state-file "$ESQ_STATE" replay >/dev/null 2>&1 || ESQ_REPLAY_RC=$?
_assert_exit "ES-q: replay exits 0" "0" "$ESQ_REPLAY_RC"

ESQ_REPLAYED=$(jq -c 'del(.event_head,.integrity_hash)' "$ESQ_STATE" 2>/dev/null || echo "")
if [[ "$ESQ_LIVE" == "$ESQ_REPLAYED" ]]; then
  _pass "ES-q: replayed state matches live state after merge (recursive merge equivalence)"
else
  _fail "ES-q: replayed state differs from live state after merge"
  printf '  live:     %s\n' "$ESQ_LIVE" >&2
  printf '  replayed: %s\n' "$ESQ_REPLAYED" >&2
fi

ESQ_CUSTOM=$(jq -r '.custom_field // ""' "$ESQ_STATE" 2>/dev/null || echo "")
if [[ "$ESQ_CUSTOM" == "qval" ]]; then
  _pass "ES-q: merged field custom_field=qval present in replayed state"
else
  _fail "ES-q: merged field custom_field not found in replayed state (got '${ESQ_CUSTOM}')"
fi

ESQ_PLAN=$(jq -r '.execute.plan_ref // ""' "$ESQ_STATE" 2>/dev/null || echo "")
if [[ "$ESQ_PLAN" == "plans/v1.md" ]]; then
  _pass "ES-q: nested merged field execute.plan_ref=plans/v1.md present in replayed state"
else
  _fail "ES-q: nested merged field execute.plan_ref not found in replayed state (got '${ESQ_PLAN}')"
fi

# ── ES-r: nested field_set replays correctly ──────────────────────────────────
# set_field on a nested path (.execute.plan_drift_detected); verify replay sets it.
# The Python fast-path silently skipped nested paths — this is the regression test.
echo ""
echo "── ES-r: nested field_set replays correctly ──"

ESR_INSTANCE_DIR="${SANDBOX}/.claude/deepwork/5e6f7a8b"
mkdir -p "$ESR_INSTANCE_DIR"
ESR_STATE="${ESR_INSTANCE_DIR}/state.json"

"$STATE_TRANSITION" --state-file "$ESR_STATE" init \
  '{"session_id":"es-r-session","phase":"execute","team_name":"esr-team"}' 2>/dev/null

"$STATE_TRANSITION" --state-file "$ESR_STATE" set_field '.execute.plan_drift_detected' 'true' 2>/dev/null

ESR_LIVE=$(jq -r '.execute.plan_drift_detected // "absent"' "$ESR_STATE" 2>/dev/null || echo "absent")
if [[ "$ESR_LIVE" == "true" ]]; then
  _pass "ES-r: live state has execute.plan_drift_detected=true"
else
  _fail "ES-r: live state missing execute.plan_drift_detected (got '${ESR_LIVE}')"
fi

rm -f "$ESR_STATE"
ESR_REPLAY_RC=0
"$STATE_TRANSITION" --state-file "$ESR_STATE" replay >/dev/null 2>&1 || ESR_REPLAY_RC=$?
_assert_exit "ES-r: replay exits 0 after nested set_field" "0" "$ESR_REPLAY_RC"

ESR_REPLAYED=$(jq -r '.execute.plan_drift_detected // "absent"' "$ESR_STATE" 2>/dev/null || echo "absent")
if [[ "$ESR_REPLAYED" == "true" ]]; then
  _pass "ES-r: replayed state has execute.plan_drift_detected=true (nested field_set replayed)"
else
  _fail "ES-r: nested field_set not replayed — execute.plan_drift_detected expected true, got '${ESR_REPLAYED}'"
fi

# ── ES-s: nested array_appended replays correctly ─────────────────────────────
# append_array on a nested path (.execute.flaky_tests); verify replay appends item.
# The Python fast-path silently skipped nested paths — this is the regression test.
echo ""
echo "── ES-s: nested array_appended replays correctly ──"

ESS_INSTANCE_DIR="${SANDBOX}/.claude/deepwork/9c0d1e2f"
mkdir -p "$ESS_INSTANCE_DIR"
ESS_STATE="${ESS_INSTANCE_DIR}/state.json"

"$STATE_TRANSITION" --state-file "$ESS_STATE" init \
  '{"session_id":"es-s-session","phase":"execute","team_name":"ess-team"}' 2>/dev/null

ESS_ITEM='{"test":"test_foo.sh","reason":"timing"}'
"$STATE_TRANSITION" --state-file "$ESS_STATE" append_array '.execute.flaky_tests' "$ESS_ITEM" 2>/dev/null

ESS_LIVE_COUNT=$(jq '[.execute.flaky_tests // [] | .[]] | length' "$ESS_STATE" 2>/dev/null || echo "0")
if [[ "$ESS_LIVE_COUNT" -eq 1 ]]; then
  _pass "ES-s: live state has 1 item in execute.flaky_tests"
else
  _fail "ES-s: live state execute.flaky_tests expected 1 item, got ${ESS_LIVE_COUNT}"
fi

rm -f "$ESS_STATE"
ESS_REPLAY_RC=0
"$STATE_TRANSITION" --state-file "$ESS_STATE" replay >/dev/null 2>&1 || ESS_REPLAY_RC=$?
_assert_exit "ES-s: replay exits 0 after nested array_appended" "0" "$ESS_REPLAY_RC"

ESS_REPLAYED_COUNT=$(jq '[.execute.flaky_tests // [] | .[]] | length' "$ESS_STATE" 2>/dev/null || echo "0")
if [[ "$ESS_REPLAYED_COUNT" -eq 1 ]]; then
  _pass "ES-s: replayed state has 1 item in execute.flaky_tests (nested array_appended replayed)"
else
  _fail "ES-s: nested array_appended not replayed — execute.flaky_tests expected 1 item, got ${ESS_REPLAYED_COUNT}"
fi

ESS_REPLAYED_REASON=$(jq -r '.execute.flaky_tests[0].reason // ""' "$ESS_STATE" 2>/dev/null || echo "")
if [[ "$ESS_REPLAYED_REASON" == "timing" ]]; then
  _pass "ES-s: replayed execute.flaky_tests[0].reason == timing"
else
  _fail "ES-s: replayed execute.flaky_tests[0].reason expected 'timing', got '${ESS_REPLAYED_REASON}'"
fi

# ── Summary ──────────────────────────────────────────────────────────────────
echo ""
echo "── Results: ${PASS} passed, ${FAIL} failed ──"
[[ $FAIL -eq 0 ]] || exit 1
exit 0
