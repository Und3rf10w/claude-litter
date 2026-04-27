#!/usr/bin/env bash
# T11-drift.sh — adversarial tests for hooks/state-drift-marker.sh (G-exec-4)
#
# Written BEFORE implementation to define the contract. Will SKIP if
# state-drift-marker.sh doesn't exist yet.
#
# Test strategy: exercise the 5 behavioral contracts from the mission brief:
#   (a) HOOK_EVENT_NAME=PreToolUse with Write target=state.json → snapshot created
#   (b) HOOK_EVENT_NAME=PostToolUse after phase change → log.md gets phase-transition line
#   (c) HOOK_EVENT_NAME=PostToolUse with no snapshot → no op, exits 0
#   (d) Write target not state.json → no op
#   (e) dedup: PostToolUse twice for same phase → only one log line
#
# Exit 0 = all ran cases passed
# Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${PLUGIN_ROOT}/hooks/state-drift-marker.sh"

if [[ ! -f "$HOOK" ]]; then
  printf 'SKIP: state-drift-marker.sh not found at %s — G-exec-4 not yet implemented\n' "$HOOK" >&2
  exit 0
fi

PASS=0
FAIL=0

_assert_exit() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf 'pass: %s (exit=%s)\n' "$name" "$actual"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected exit %s, got %s\n' "$name" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

_assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    printf 'pass: %s (found "%s")\n' "$name" "$needle"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — did not find "%s"\n' "$name" "$needle" >&2
    printf '  actual: %s\n' "$haystack" >&2
    FAIL=$((FAIL + 1))
  fi
}

_count_lines() {
  local needle="$1" haystack="$2"
  printf '%s' "$haystack" | grep -cF -- "$needle" 2>/dev/null || echo "0"
}

# ── Fixture setup ──
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

export CLAUDE_PROJECT_DIR="$SANDBOX"
INSTANCE_ID="ab12cd34"
INSTANCE_DIR="$SANDBOX/.claude/deepwork/$INSTANCE_ID"
mkdir -p "$INSTANCE_DIR"

SESSION_ID="test-session-$(date +%s)"

STATE_FILE="${INSTANCE_DIR}/state.json"
LOG_FILE="${INSTANCE_DIR}/log.md"
SNAPSHOT="${INSTANCE_DIR}/.state-snapshot"

STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{
  "session_id": "$SESSION_ID",
  "phase": "explore",
  "team_name": "test-team",
  "bar": [
    {"id": "G1", "verdict": null},
    {"id": "G2", "verdict": null}
  ]
}
EOF

printf '# Log\n\n' > "$LOG_FILE"

_run_hook() {
  local event="$1" tool_name="$2" file_path="$3"
  local payload
  payload=$(jq -cn \
    --arg sid "$SESSION_ID" \
    --arg hen "$event" \
    --arg tn  "$tool_name" \
    --arg fp  "$file_path" \
    '{session_id: $sid, hook_event_name: $hen, tool_name: $tn, tool_input: {file_path: $fp}}')
  printf '%s' "$payload" \
    | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "$HOOK" >/dev/null 2>&1
  echo $?
}

# ── (a) PreToolUse + Write targeting state.json → snapshot created ──
echo ""
echo "── T11-a: PreToolUse Write state.json → snapshot created ──"
rm -f "$SNAPSHOT"
_assert_exit "T11-a: exits 0" "0" "$(_run_hook "PreToolUse" "Write" "$STATE_FILE")"
if [[ -f "$SNAPSHOT" ]]; then
  printf 'pass: T11-a: snapshot created at %s\n' "$SNAPSHOT"
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-a: snapshot not created at %s\n' "$SNAPSHOT" >&2
  FAIL=$((FAIL + 1))
fi

# ── (b) PostToolUse after phase change → log.md gets phase-transition line ──
echo ""
echo "── T11-b: PostToolUse after phase change → log.md phase-transition line ──"

# Snapshot is already at "explore" phase (from T11-a)
# Now update state.json to "synthesize"
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" set_field .phase '"synthesize"'

_assert_exit "T11-b: exits 0" "0" "$(_run_hook "PostToolUse" "Write" "$STATE_FILE")"

LOG_CONTENT=$(cat "$LOG_FILE" 2>/dev/null)
if printf '%s' "$LOG_CONTENT" | grep -q 'phase-transition'; then
  printf 'pass: T11-b: phase-transition line in log.md\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-b: no phase-transition line in log.md\n' >&2
  printf '  log.md: %s\n' "$LOG_CONTENT" >&2
  FAIL=$((FAIL + 1))
fi

# Verify it mentions both old and new phase
_assert_contains "T11-b: log mentions 'explore'" "explore" "$LOG_CONTENT"
_assert_contains "T11-b: log mentions 'synthesize'" "synthesize" "$LOG_CONTENT"

# ── (c) PostToolUse with no snapshot → no op, exits 0 ──
echo ""
echo "── T11-c: PostToolUse with no snapshot → no op, exits 0 ──"
rm -f "$SNAPSHOT"
LOG_BEFORE=$(cat "$LOG_FILE")
_assert_exit "T11-c: exits 0" "0" "$(_run_hook "PostToolUse" "Write" "$STATE_FILE")"
LOG_AFTER=$(cat "$LOG_FILE")
if [[ "$LOG_BEFORE" == "$LOG_AFTER" ]]; then
  printf 'pass: T11-c: log.md unchanged when no snapshot\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-c: log.md was modified even with no snapshot\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── (d) Write target not state.json → no op ──
echo ""
echo "── T11-d: Write to different file → no op, exits 0 ──"
OTHER_FILE="${INSTANCE_DIR}/findings.test.md"
# Create snapshot so PostToolUse would fire if it incorrectly matches
cp "$STATE_FILE" "$SNAPSHOT"
LOG_BEFORE=$(cat "$LOG_FILE")
_assert_exit "T11-d: exits 0 for non-state.json target" "0" "$(_run_hook "PreToolUse" "Write" "$OTHER_FILE")"
_assert_exit "T11-d: PostToolUse exits 0 for non-state.json" "0" "$(_run_hook "PostToolUse" "Write" "$OTHER_FILE")"
LOG_AFTER=$(cat "$LOG_FILE")
if [[ "$LOG_BEFORE" == "$LOG_AFTER" ]]; then
  printf 'pass: T11-d: log.md unchanged for non-state.json target\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-d: log.md modified for non-state.json target\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── (e) Dedup: PostToolUse twice for same phase → only one log line ──
echo ""
echo "── T11-e: PostToolUse twice for same phase → only one phase-transition entry ──"

# Reset state to a known phase
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" set_field .phase '"critique"'
# Create snapshot at same phase (no actual transition)
cp "$STATE_FILE" "$SNAPSHOT"
# Now change phase
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" set_field .phase '"deliver"'

# First PostToolUse → should log once
_run_hook "PostToolUse" "Write" "$STATE_FILE" >/dev/null 2>&1

# Recreate snapshot at same state (dedup scenario: same transition repeated)
cp "$STATE_FILE" "$SNAPSHOT"
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" set_field .phase '"deliver"'

# Second PostToolUse with identical transition
_run_hook "PostToolUse" "Write" "$STATE_FILE" >/dev/null 2>&1

LOG_CONTENT=$(cat "$LOG_FILE")
TRANSITION_COUNT=$(_count_lines "critique" "$LOG_CONTENT")
if [[ "$TRANSITION_COUNT" -le 1 ]]; then
  printf 'pass: T11-e: dedup — critique transition appears at most once (%s)\n' "$TRANSITION_COUNT"
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-e: dedup failed — critique transition appeared %s times in log.md\n' "$TRANSITION_COUNT" >&2
  FAIL=$((FAIL + 1))
fi

# ── (f) ADV: bar verdict change (no phase change) → verdict-change line in log.md ──
echo ""
echo "── T11-f (ADV): bar verdict change → verdict-change line in log.md ──"

# Reset to clean snapshot with G1=null
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" merge \
  '{"phase":"deliver","bar":[{"id":"G1","verdict":null},{"id":"G2","verdict":null}]}'
cp "$STATE_FILE" "$SNAPSHOT"

# Update G1 verdict to PASS
STATE_FILE="$STATE_FILE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" merge \
  '{"bar":[{"id":"G1","verdict":"PASS"},{"id":"G2","verdict":null}]}'

_assert_exit "T11-f: exits 0" "0" "$(_run_hook "PostToolUse" "Write" "$STATE_FILE")"

LOG_CONTENT=$(cat "$LOG_FILE")
if printf '%s' "$LOG_CONTENT" | grep -q 'bar-verdict\|G1\|PASS'; then
  printf 'pass: T11-f: bar-verdict change captured in log.md\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-f: bar-verdict change not captured (G1: null→PASS)\n' >&2
  printf '  log.md: %s\n' "$LOG_CONTENT" >&2
  FAIL=$((FAIL + 1))
fi

# ── (g) ADV: unknown event name → exits 0 gracefully ──
echo ""
echo "── T11-g (ADV): unknown HOOK_EVENT_NAME → exits 0 ──"
RC_G=$(printf '{"session_id":"%s","hook_event_name":"UnknownEvent","tool_name":"Write","tool_input":{"file_path":"%s"}}' \
  "$SESSION_ID" "$STATE_FILE" \
  | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$HOOK" >/dev/null 2>&1; echo $?)
_assert_exit "T11-g: unknown event exits 0" "0" "$RC_G"

# ── (h) ADV: /tmp not used for snapshots (snapshot must be in instance dir) ──
echo ""
echo "── T11-h (ADV): snapshot location is inside instance dir, not /tmp ──"
rm -f "$SNAPSHOT"
_run_hook "PreToolUse" "Write" "$STATE_FILE" >/dev/null 2>&1
# Snapshot should be in instance dir
if [[ -f "$SNAPSHOT" ]]; then
  printf 'pass: T11-h: snapshot at instance dir path %s\n' "$SNAPSHOT"
  PASS=$((PASS + 1))
else
  # Check if something landed in /tmp instead
  TMP_SNAPS=$(ls /tmp/dw-* 2>/dev/null | head -5)
  printf 'FAIL: T11-h: snapshot not found at %s\n' "$SNAPSHOT" >&2
  if [[ -n "$TMP_SNAPS" ]]; then
    printf '  Found in /tmp instead: %s\n' "$TMP_SNAPS" >&2
  fi
  FAIL=$((FAIL + 1))
fi

# ── (i) Archive cycle: orphan snapshots cleaned by archive_state ──
# Regression for W18-b: PreToolUse Bash snapshots state.json when archive_state runs.
# After mv state.json→state.archived.json, PostToolUse can't find the instance (glob
# only matches state.json), so state-transition.sh archive_state itself must remove
# any .state-snapshot* files to prevent orphans accumulating in the instance dir.
echo ""
echo "── T11-i: archive_state → orphan snapshots cleaned up ──"

ARCHIVE_SB=$(mktemp -d)
trap 'rm -rf "$ARCHIVE_SB"' EXIT
export CLAUDE_PROJECT_DIR="$ARCHIVE_SB"
ARCH_ID="cdef0123"
ARCH_DIR="$ARCHIVE_SB/.claude/deepwork/$ARCH_ID"
mkdir -p "$ARCH_DIR"
ARCH_SID="test-archive-$(date +%s)"
ARCH_STATE="${ARCH_DIR}/state.json"

STATE_FILE="$ARCH_STATE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{"session_id":"$ARCH_SID","phase":"done","team_name":"test-team"}
EOF

# Simulate two per-tool snapshots (as PreToolUse:Bash would create)
ARCH_SNAP1="${ARCH_DIR}/.state-snapshot.tool-abc.json"
ARCH_SNAP2="${ARCH_DIR}/.state-snapshot.tool-def.json"
cp "$ARCH_STATE" "$ARCH_SNAP1"
cp "$ARCH_STATE" "$ARCH_SNAP2"

# Run archive_state — should clean snapshots as part of the operation
_ARCH_RC=$(STATE_FILE="$ARCH_STATE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" archive_state >/dev/null 2>&1; echo $?)
_assert_exit "T11-i: archive_state exits 0" "0" "$_ARCH_RC"

if [[ -f "$ARCH_SNAP1" ]] || [[ -f "$ARCH_SNAP2" ]]; then
  printf 'FAIL: T11-i: orphan snapshot(s) NOT cleaned up after archive_state\n' >&2
  FAIL=$((FAIL + 1))
else
  printf 'pass: T11-i: orphan snapshots cleaned up by archive_state\n'
  PASS=$((PASS + 1))
fi

if [[ -f "${ARCH_DIR}/state.archived.json" ]]; then
  printf 'pass: T11-i: state.archived.json exists\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-i: state.archived.json missing\n' >&2
  FAIL=$((FAIL + 1))
fi

# ── (j) Banner violation revert: snapshot cleaned up on early-return revert path ──
# Regression for W18-b: when banners[] validation fails, state-drift-marker.sh reverts
# state.json from snapshot then exits early — the snapshot must be removed before exit.
echo ""
echo "── T11-j: banner violation revert → snapshot cleaned up on early exit ──"

BANNER_SB=$(mktemp -d)
trap 'rm -rf "$BANNER_SB"' EXIT
export CLAUDE_PROJECT_DIR="$BANNER_SB"
BAN_ID="ef012345"
BAN_DIR="$BANNER_SB/.claude/deepwork/$BAN_ID"
mkdir -p "$BAN_DIR"
BAN_SID="test-banner-$(date +%s)"
BAN_STATE="${BAN_DIR}/state.json"
BAN_EVENTS="${BAN_DIR}/events.jsonl"
BAN_LOG="${BAN_DIR}/log.md"
touch "$BAN_LOG"

STATE_FILE="$BAN_STATE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{"session_id":"$BAN_SID","phase":"synthesize","team_name":"test-team","banners":[]}
EOF

# Snapshot = good state (no banners)
BAN_SNAP="${BAN_DIR}/.state-snapshot.ban-tool-id.json"
cp "$BAN_STATE" "$BAN_SNAP"

# Write a bad banner (missing required fields) directly into state.json
printf '%s\n' '{"session_id":"'"$BAN_SID"'","phase":"synthesize","team_name":"test-team","banners":[{"bad_field":"oops"}]}' \
  > "$BAN_STATE"

# Run PostToolUse:Write — banner violation should trigger revert and clean up snapshot
_BAN_RC=$(printf '%s' \
  "{\"session_id\":\"$BAN_SID\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Write\",\"tool_use_id\":\"ban-tool-id\",\"tool_input\":{\"file_path\":\"$BAN_STATE\"}}" \
  | INSTANCE_DIR="$BAN_DIR" LOG_FILE="$BAN_LOG" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$HOOK" >/dev/null 2>&1; echo $?)
_assert_exit "T11-j: exits 0 after banner violation revert" "0" "$_BAN_RC"

if [[ -f "$BAN_SNAP" ]]; then
  printf 'FAIL: T11-j: snapshot NOT cleaned up after banner violation revert at %s\n' "$BAN_SNAP" >&2
  FAIL=$((FAIL + 1))
else
  printf 'pass: T11-j: snapshot cleaned up after banner violation revert\n'
  PASS=$((PASS + 1))
fi

# Snapshot cleanup restores original CLAUDE_PROJECT_DIR for remaining tests
export CLAUDE_PROJECT_DIR="$SANDBOX"

# ── (k) archive_state: pending-change.json absent after archive ──────────────
echo ""
echo "── T11-k: archive_state → pending-change.json absent after archive ──"

T11K_SB=$(mktemp -d)
T11K_ID="bc234567"
T11K_DIR="$T11K_SB/.claude/deepwork/$T11K_ID"
mkdir -p "$T11K_DIR"
T11K_STATE="${T11K_DIR}/state.json"
T11K_PENDING="${T11K_DIR}/pending-change.json"

STATE_FILE="$T11K_STATE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{"session_id":"t11k-session","phase":"synthesize","team_name":"test-team"}
EOF

# Create a pending-change.json to simulate mid-session state
printf '{"change":"test"}\n' > "$T11K_PENDING"

INSTANCE_DIR="$T11K_DIR" STATE_FILE="$T11K_STATE" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" archive_state >/dev/null 2>&1
_T11K_RC=$?
_assert_exit "T11-k: archive_state exits 0" "0" "$_T11K_RC"

if [[ ! -f "$T11K_PENDING" ]]; then
  printf 'pass: T11-k: pending-change.json removed after archive\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-k: pending-change.json still present after archive\n' >&2
  FAIL=$((FAIL + 1))
fi

if [[ -f "${T11K_DIR}/state.archived.json" ]]; then
  printf 'pass: T11-k: state.archived.json present\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-k: state.archived.json missing\n' >&2
  FAIL=$((FAIL + 1))
fi

rm -rf "$T11K_SB"

# ── (l) archive_state rollback: events.jsonl mv failure → state.json NOT archived ──
echo ""
echo "── T11-l: archive_state rollback — events mv fails → state.json remains ──"

T11L_SB=$(mktemp -d)
T11L_ID="cd345678"
T11L_DIR="$T11L_SB/.claude/deepwork/$T11L_ID"
mkdir -p "$T11L_DIR"
T11L_STATE="${T11L_DIR}/state.json"
T11L_EVENTS_ARCHIVE="${T11L_DIR}/events.archived.jsonl"

STATE_FILE="$T11L_STATE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{"session_id":"t11l-session","phase":"synthesize","team_name":"test-team"}
EOF

# Ensure events.jsonl is created (stamp_last_updated emits an event)
INSTANCE_DIR="$T11L_DIR" STATE_FILE="$T11L_STATE" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" stamp_last_updated >/dev/null 2>&1

# Block mv events.jsonl → events.archived.jsonl by placing a non-writable directory
# at the destination path. On macOS, mv src dir/ moves src INTO the dir (not replacing it),
# so we chmod 555 to prevent the write into it, forcing mv to fail.
mkdir "$T11L_EVENTS_ARCHIVE"
chmod 555 "$T11L_EVENTS_ARCHIVE"

INSTANCE_DIR="$T11L_DIR" STATE_FILE="$T11L_STATE" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" archive_state >/dev/null 2>&1
_T11L_RC=$?
chmod 755 "$T11L_EVENTS_ARCHIVE"

# archive_state should fail (exit non-zero) and roll back state.json
if [[ $_T11L_RC -ne 0 ]]; then
  printf 'pass: T11-l: archive_state exits non-zero on events mv failure\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-l: archive_state should exit non-zero but exited 0\n' >&2
  FAIL=$((FAIL + 1))
fi

if [[ -f "$T11L_STATE" ]]; then
  printf 'pass: T11-l: state.json rolled back (present after failed archive)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-l: state.json missing — rollback did not restore it\n' >&2
  FAIL=$((FAIL + 1))
fi

if [[ ! -f "${T11L_DIR}/state.archived.json" ]]; then
  printf 'pass: T11-l: state.archived.json absent (not half-archived)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-l: state.archived.json present — half-archived state\n' >&2
  FAIL=$((FAIL + 1))
fi

rm -rf "$T11L_SB"

# ── (m) banner validation gap: snapshot absent → banner check still fires ────
# Regression for W19-c Fix 2: PostToolBatch shadow period. When batch-gate cleans
# the per-tool snapshot before state-drift-marker's PostToolUse handler runs,
# banner validation must still fire (it doesn't need the snapshot for the check).
echo ""
echo "── T11-m: banner validation fires even without snapshot (shadow-period gap) ──"

T11M_SB=$(mktemp -d)
T11M_ID="de456789"
T11M_DIR="$T11M_SB/.claude/deepwork/$T11M_ID"
mkdir -p "$T11M_DIR"
T11M_SID="t11m-session-$(date +%s)"
T11M_STATE="${T11M_DIR}/state.json"
T11M_LOG="${T11M_DIR}/log.md"
touch "$T11M_LOG"

STATE_FILE="$T11M_STATE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{"session_id":"$T11M_SID","phase":"synthesize","team_name":"test-team","banners":[]}
EOF

# Write corrupt banners[] directly (no snapshot present — simulating batch-gate cleanup)
printf '%s\n' '{"session_id":"'"$T11M_SID"'","phase":"synthesize","team_name":"test-team","banners":[{"bad_field":"oops"}]}' \
  > "$T11M_STATE"

# No snapshot file present (simulates batch-gate having cleaned it)
T11M_SNAP="${T11M_DIR}/.state-snapshot.t11m-tool-id.json"
rm -f "$T11M_SNAP"

_T11M_RC=$(printf '%s' \
  "{\"session_id\":\"$T11M_SID\",\"hook_event_name\":\"PostToolUse\",\"tool_name\":\"Write\",\"tool_use_id\":\"t11m-tool-id\",\"tool_input\":{\"file_path\":\"$T11M_STATE\"}}" \
  | CLAUDE_PROJECT_DIR="$T11M_SB" LOG_FILE="$T11M_LOG" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$HOOK" >/dev/null 2>&1; echo $?)
_assert_exit "T11-m: exits 0 even without snapshot" "0" "$_T11M_RC"

# Banner validation should have logged to log.md (blocker line)
T11M_LOG_CONTENT=$(cat "$T11M_LOG" 2>/dev/null || echo "")
if printf '%s' "$T11M_LOG_CONTENT" | grep -q "banner-corruption"; then
  printf 'pass: T11-m: banner-corruption logged to log.md without snapshot\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-m: banner-corruption NOT logged to log.md (validation skipped?)\n' >&2
  printf '  log content: %s\n' "$T11M_LOG_CONTENT" >&2
  FAIL=$((FAIL + 1))
fi

rm -rf "$T11M_SB"

# ── (n) emit_revert_event stamps event_head atomically (W20-c regression) ──
# Regression for W20-c: emit_revert_event must stamp state.json.event_head to
# the new state_reverted event's hash inside the events.jsonl lock, so that
# integrity-always-gate never sees a mismatch after a banner-violation revert.
echo ""
echo "── T11-n: emit_revert_event stamps event_head + hash atomically (W20-c) ──"

T11N_SB=$(mktemp -d)
T11N_ID="fe567890"
T11N_DIR="$T11N_SB/.claude/deepwork/$T11N_ID"
mkdir -p "$T11N_DIR"
T11N_SID="t11n-session-$(date +%s)"
T11N_STATE="${T11N_DIR}/state.json"
T11N_EVENTS="${T11N_DIR}/events.jsonl"

STATE_FILE="$T11N_STATE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{"session_id":"$T11N_SID","phase":"synthesize","team_name":"test-team"}
EOF

# Seed events.jsonl and build up a proper event_head
INSTANCE_DIR="$T11N_DIR" STATE_FILE="$T11N_STATE" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" stamp_last_updated >/dev/null 2>&1

# Record pre-revert event_head and events tail (snapshot's last event)
T11N_PRE_HEAD=$(jq -r '.event_head // ""' "$T11N_STATE" 2>/dev/null)
T11N_REVERT_TO=$(tail -1 "$T11N_EVENTS" | jq -r '.event_id // "unknown"' 2>/dev/null)

# Call emit_revert_event (simulates state-drift-marker after snapshot restore)
INSTANCE_DIR="$T11N_DIR" STATE_FILE="$T11N_STATE" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" emit_revert_event \
  --reason "banner_schema_violation" \
  --reverted_to_event "$T11N_REVERT_TO" >/dev/null 2>&1
_T11N_REVERT_RC=$?

if [[ $_T11N_REVERT_RC -eq 0 ]]; then
  printf 'pass: T11-n: emit_revert_event exits 0\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-n: emit_revert_event exited %d (expected 0)\n' "$_T11N_REVERT_RC" >&2
  FAIL=$((FAIL + 1))
fi

# Assert state.json.event_head == SHA256 of the last events.jsonl line
T11N_LAST_LINE=$(tail -1 "$T11N_EVENTS" 2>/dev/null)
if command -v sha256sum >/dev/null 2>&1; then
  T11N_ACTUAL_HEAD=$(printf '%s\n' "$T11N_LAST_LINE" | sha256sum | cut -d' ' -f1)
else
  T11N_ACTUAL_HEAD=$(printf '%s\n' "$T11N_LAST_LINE" | shasum -a 256 | cut -d' ' -f1)
fi
T11N_STORED_HEAD=$(jq -r '.event_head // ""' "$T11N_STATE" 2>/dev/null)

if [[ "$T11N_STORED_HEAD" == "$T11N_ACTUAL_HEAD" ]]; then
  printf 'pass: T11-n: state.json.event_head matches events.jsonl tail hash after revert\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-n: event_head mismatch after emit_revert_event\n' >&2
  printf '  state.event_head:       %s\n' "$T11N_STORED_HEAD" >&2
  printf '  events.jsonl tail hash: %s\n' "$T11N_ACTUAL_HEAD" >&2
  FAIL=$((FAIL + 1))
fi

# Assert integrity-always-gate logic passes post-revert (no mismatch block)
_T11N_GATE_RC=0
(
  source "${PLUGIN_ROOT}/scripts/instance-lib.sh"
  STATE_FILE="$T11N_STATE"
  INSTANCE_DIR="$T11N_DIR"
  _verify_event_head_or_block
) 2>/dev/null
_T11N_GATE_RC=$?

if [[ $_T11N_GATE_RC -eq 0 ]]; then
  printf 'pass: T11-n: _verify_event_head_or_block exits 0 after revert (no integrity block)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-n: _verify_event_head_or_block exits %d after revert — integrity block would fire\n' \
    "$_T11N_GATE_RC" >&2
  FAIL=$((FAIL + 1))
fi

# Also assert event_head changed from pre-revert (the stamp actually updated it)
if [[ "$T11N_STORED_HEAD" != "$T11N_PRE_HEAD" ]]; then
  printf 'pass: T11-n: event_head advanced past pre-revert value (stamp updated)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-n: event_head unchanged — stamp did not fire or event_head == pre-revert hash\n' >&2
  FAIL=$((FAIL + 1))
fi

rm -rf "$T11N_SB"

# ── (o) archive_state → state.archived.json carries accurate state_integrity_hash (W20-i) ──
# Regression for W20-i: archive_state previously used _write_state_atomic which stamped
# only event_head, leaving state_integrity_hash stale (covering pre-stamp content).
# After the fix, _write_with_hash must produce a hash that matches _compute_integrity_hash
# on the archived file content.
echo ""
echo "── T11-o: archive_state → state.archived.json has valid state_integrity_hash (W20-i) ──"

T11O_SB=$(mktemp -d)
T11O_ID="fg678901"
T11O_DIR="$T11O_SB/.claude/deepwork/$T11O_ID"
mkdir -p "$T11O_DIR"
T11O_SID="t11o-session-$(date +%s)"
T11O_STATE="${T11O_DIR}/state.json"
T11O_ARCH="${T11O_DIR}/state.archived.json"

STATE_FILE="$T11O_STATE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{"session_id":"$T11O_SID","phase":"done","team_name":"test-team"}
EOF

# Build up some event history so event_head is non-trivial
INSTANCE_DIR="$T11O_DIR" STATE_FILE="$T11O_STATE" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" stamp_last_updated >/dev/null 2>&1

_T11O_RC=$(INSTANCE_DIR="$T11O_DIR" STATE_FILE="$T11O_STATE" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" archive_state >/dev/null 2>&1; echo $?)
_assert_exit "T11-o: archive_state exits 0" "0" "$_T11O_RC"

if [[ ! -f "$T11O_ARCH" ]]; then
  printf 'FAIL: T11-o: state.archived.json not present\n' >&2
  FAIL=$((FAIL + 1))
else
  printf 'pass: T11-o: state.archived.json present\n'
  PASS=$((PASS + 1))

  # Recompute integrity hash using _compute_integrity_hash from state-transition.sh.
  # Source state-transition.sh in a subshell to access the internal helper directly.
  T11O_STORED_HASH=$(jq -r '.state_integrity_hash // ""' "$T11O_ARCH" 2>/dev/null)
  T11O_COMPUTED_HASH=$(
    INSTANCE_DIR="$T11O_DIR" STATE_FILE="$T11O_ARCH" \
      bash -c '
        source "'"${PLUGIN_ROOT}/scripts/state-transition.sh"'" --_source_only 2>/dev/null || true
        _compute_integrity_hash "'"$T11O_ARCH"'" 2>/dev/null
      ' 2>/dev/null
  ) || T11O_COMPUTED_HASH=""
  # Fallback: replicate the projection inline if sourcing is not supported
  if [[ -z "$T11O_COMPUTED_HASH" ]]; then
    _T11O_SOT=$(jq -r '(.source_of_truth // []) | sort | tojson' "$T11O_ARCH" 2>/dev/null || echo "")
    _T11O_SOT_DIGEST=""
    if command -v sha256sum >/dev/null 2>&1; then
      _T11O_SOT_DIGEST=$(printf '%s\n' "$_T11O_SOT" | sha256sum | cut -d' ' -f1)
    else
      _T11O_SOT_DIGEST=$(printf '%s\n' "$_T11O_SOT" | shasum -a 256 | cut -d' ' -f1)
    fi
    _T11O_PROJ=$(jq -c --arg sot_digest "$_T11O_SOT_DIGEST" '{
      phase, team_name, instance_id, frontmatter_schema_version, started_at,
      source_of_truth_digest: $sot_digest,
      bar: ([.bar[]? | {id, verdict}] | sort_by(.id)),
      execute_plan_drift_detected: .execute.plan_drift_detected,
      execute_plan_hash: .execute.plan_hash
    }' "$T11O_ARCH" 2>/dev/null)
    if [[ -n "$_T11O_PROJ" ]]; then
      if command -v sha256sum >/dev/null 2>&1; then
        T11O_COMPUTED_HASH=$(printf '%s' "$_T11O_PROJ" | sha256sum | cut -d' ' -f1)
      else
        T11O_COMPUTED_HASH=$(printf '%s' "$_T11O_PROJ" | shasum -a 256 | cut -d' ' -f1)
      fi
    fi
  fi

  if [[ -n "$T11O_STORED_HASH" && "$T11O_STORED_HASH" == "$T11O_COMPUTED_HASH" ]]; then
    printf 'pass: T11-o: state.archived.json.state_integrity_hash is accurate\n'
    PASS=$((PASS + 1))
  else
    printf 'FAIL: T11-o: state_integrity_hash mismatch in archived file\n' >&2
    printf '  stored:   %s\n' "$T11O_STORED_HASH" >&2
    printf '  computed: %s\n' "$T11O_COMPUTED_HASH" >&2
    FAIL=$((FAIL + 1))
  fi

  # Also verify event_head in archived file matches the tail of events.archived.jsonl
  T11O_EVENTS_ARCH="${T11O_DIR}/events.archived.jsonl"
  if [[ -f "$T11O_EVENTS_ARCH" ]]; then
    T11O_LAST_LINE=$(tail -1 "$T11O_EVENTS_ARCH")
    T11O_LAST_HASH=""
    if command -v sha256sum >/dev/null 2>&1; then
      T11O_LAST_HASH=$(printf '%s\n' "$T11O_LAST_LINE" | sha256sum | cut -d' ' -f1)
    else
      T11O_LAST_HASH=$(printf '%s\n' "$T11O_LAST_LINE" | shasum -a 256 | cut -d' ' -f1)
    fi
    T11O_STORED_HEAD=$(jq -r '.event_head // ""' "$T11O_ARCH" 2>/dev/null)
    if [[ "$T11O_STORED_HEAD" == "$T11O_LAST_HASH" ]]; then
      printf 'pass: T11-o: state.archived.json.event_head matches events.archived.jsonl tail\n'
      PASS=$((PASS + 1))
    else
      printf 'FAIL: T11-o: event_head mismatch in archived state\n' >&2
      printf '  archived event_head:          %s\n' "$T11O_STORED_HEAD" >&2
      printf '  events.archived.jsonl tail:   %s\n' "$T11O_LAST_HASH" >&2
      FAIL=$((FAIL + 1))
    fi
  fi
fi

rm -rf "$T11O_SB"

# ── (p) emit_stamp_head lock contention → fail-closed skip + warn (W21 #3) ──
# Regression for W21 #3: when state.json.lock cannot be acquired, emit_revert_event
# must NOT proceed to write state.json, must NOT release the lock (which would rm
# another process's lock dir on macOS mkdir-fallback), must emit a stderr warning,
# and must still successfully append the state_reverted event to events.jsonl.
echo ""
echo "── T11-p: emit_stamp_head fails closed on state.json lock contention (W21 #3) ──"

T11P_SB=$(mktemp -d)
T11P_ID="aabbccdd"
T11P_DIR="$T11P_SB/.claude/deepwork/$T11P_ID"
mkdir -p "$T11P_DIR"
T11P_SID="t11p-session-$(date +%s)"
T11P_STATE="${T11P_DIR}/state.json"
T11P_LOCK="${T11P_STATE}.lock"

STATE_FILE="$T11P_STATE" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init - <<EOF
{"session_id":"$T11P_SID","phase":"explore","team_name":"test-team"}
EOF

# Generate a baseline event so prev_event_hash is non-empty
INSTANCE_DIR="$T11P_DIR" STATE_FILE="$T11P_STATE" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" stamp_last_updated >/dev/null 2>&1

# Capture pre-revert state.json content + event_head for comparison
T11P_PRE_EVENT_HEAD=$(jq -r '.event_head // ""' "$T11P_STATE")
T11P_PRE_HASH=$(jq -r '.state_integrity_hash // ""' "$T11P_STATE")

# Acquire state.json.lock externally to simulate contention. Use mkdir lock-dir
# pattern matching _acquire_lock's macOS fallback so the test exercises both paths.
# (On Linux flock is used; mkdir of $LOCK.dir still creates a directory that the
# in-process flock acquisition will not contest, so we hold via a long-running
# `flock` background process to be portable.)
if command -v flock >/dev/null 2>&1; then
  exec 9>"$T11P_LOCK"
  flock -x 9
  T11P_LOCK_HOLDER_FD=9
else
  mkdir "${T11P_LOCK}.dir" 2>/dev/null || true
fi

T11P_REVERT_OUT=$(INSTANCE_DIR="$T11P_DIR" STATE_FILE="$T11P_STATE" \
  bash "${PLUGIN_ROOT}/scripts/state-transition.sh" emit_revert_event \
  --reason "t11p_test_contention" \
  --reverted_to_event "$T11P_PRE_EVENT_HEAD" 2>&1)
T11P_REVERT_RC=$?

# Release lock
if [[ -n "${T11P_LOCK_HOLDER_FD:-}" ]]; then
  exec 9>&-
else
  rm -rf "${T11P_LOCK}.dir"
fi

# Assertion 1: emit_revert_event exits 0 (the events.jsonl append still succeeds)
if [[ "$T11P_REVERT_RC" -eq 0 ]]; then
  printf 'pass: T11-p: emit_revert_event exits 0 under stamp-lock contention\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-p: emit_revert_event exited %d (expected 0)\n' "$T11P_REVERT_RC" >&2
  FAIL=$((FAIL + 1))
fi

# Assertion 2: stderr contains the warn line (head-stamp skipped)
if printf '%s' "$T11P_REVERT_OUT" | grep -q "head-stamp skipped"; then
  printf 'pass: T11-p: stderr contains head-stamp skipped warning\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-p: warning line not found in stderr: %s\n' "$T11P_REVERT_OUT" >&2
  FAIL=$((FAIL + 1))
fi

# Assertion 3: state.json content unchanged (stamp was skipped)
T11P_POST_EVENT_HEAD=$(jq -r '.event_head // ""' "$T11P_STATE")
T11P_POST_HASH=$(jq -r '.state_integrity_hash // ""' "$T11P_STATE")
if [[ "$T11P_PRE_EVENT_HEAD" == "$T11P_POST_EVENT_HEAD" && "$T11P_PRE_HASH" == "$T11P_POST_HASH" ]]; then
  printf 'pass: T11-p: state.json unchanged when stamp skipped\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-p: state.json modified despite stamp skip (event_head %s→%s, hash %s→%s)\n' \
    "$T11P_PRE_EVENT_HEAD" "$T11P_POST_EVENT_HEAD" "$T11P_PRE_HASH" "$T11P_POST_HASH" >&2
  FAIL=$((FAIL + 1))
fi

# Assertion 4: events.jsonl got the state_reverted event despite stamp skip
T11P_LAST_TYPE=$(tail -1 "${T11P_DIR}/events.jsonl" | jq -r '.event_type // ""')
if [[ "$T11P_LAST_TYPE" == "state_reverted" ]]; then
  printf 'pass: T11-p: events.jsonl tail is state_reverted (append succeeded)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-p: events.jsonl tail event_type=%s (expected state_reverted)\n' \
    "$T11P_LAST_TYPE" >&2
  FAIL=$((FAIL + 1))
fi

# Assertion 5: no leftover .emit-stamp*.tmp.* files (also covers W21 #4 cleanup)
if ! ls "${T11P_DIR}"/state.json.emit-stamp*.tmp.* 2>/dev/null | head -1 | grep -q .; then
  printf 'pass: T11-p: no leftover emit-stamp tmp files (W21 #4 cleanup verified)\n'
  PASS=$((PASS + 1))
else
  printf 'FAIL: T11-p: leftover emit-stamp tmp files in instance dir\n' >&2
  ls "${T11P_DIR}"/state.json.emit-stamp*.tmp.* >&2 2>&1
  FAIL=$((FAIL + 1))
fi

rm -rf "$T11P_SB"

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
