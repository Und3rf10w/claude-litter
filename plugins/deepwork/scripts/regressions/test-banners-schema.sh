#!/usr/bin/env bash
# test-banners-schema.sh — regression tests for banners[] schema validation in
# hooks/state-drift-marker.sh (post-write revert mechanism, F1 refactor)
#
# Schema: references/schemas/banner-schema.json
# Required fields per entry: artifact_path (string), banner_type (enum),
#   reason (string), added_at (ISO8601), added_by (string)
# additionalProperties: false
#
# Mechanism: state-drift-marker.sh PostToolUse reads state.json after write,
# validates banners[], and if invalid: reverts state.json from .state-snapshot,
# appends blocker line to log.md, prints error to stderr.
#
# Exit 0 = all cases pass; Exit 1 = one or more failures.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
HOOK="${PLUGIN_ROOT}/hooks/state-drift-marker.sh"

if [[ ! -f "$HOOK" ]]; then
  printf 'SKIP: state-drift-marker.sh not found at %s\n' "$HOOK" >&2
  exit 0
fi

PASS=0
FAIL=0

_assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf 'pass: %s (expected=%s)\n' "$name" "$actual"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected "%s", got "%s"\n' "$name" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

_assert_file_contains() {
  local name="$1" pattern="$2" file="$3"
  if grep -q "$pattern" "$file" 2>/dev/null; then
    printf 'pass: %s (file contains "%s")\n' "$name" "$pattern"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — file did not contain "%s"\n  file: %s\n  content: %s\n' \
      "$name" "$pattern" "$file" "$(cat "$file" 2>/dev/null || echo '<absent>')" >&2
    FAIL=$((FAIL + 1))
  fi
}

_assert_file_not_contains() {
  local name="$1" pattern="$2" file="$3"
  if ! grep -q "$pattern" "$file" 2>/dev/null; then
    printf 'pass: %s (file does not contain "%s")\n' "$name" "$pattern"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — file unexpectedly contains "%s"\n' "$name" "$pattern" >&2
    FAIL=$((FAIL + 1))
  fi
}

_assert_stderr_contains() {
  local name="$1" pattern="$2" stderr_output="$3"
  if printf '%s' "$stderr_output" | grep -q "$pattern"; then
    printf 'pass: %s (stderr contains "%s")\n' "$name" "$pattern"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — stderr did not contain "%s"\n  stderr: %s\n' \
      "$name" "$pattern" "$stderr_output" >&2
    FAIL=$((FAIL + 1))
  fi
}

_assert_json_field() {
  local name="$1" file="$2" field="$3" expected="$4"
  local actual
  actual=$(jq -r "$field" "$file" 2>/dev/null || echo "<jq-error>")
  if [[ "$actual" == "$expected" ]]; then
    printf 'pass: %s (%s = %s)\n' "$name" "$field" "$actual"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected %s=%s, got %s\n' "$name" "$field" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

# ── Fixture setup ──
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

export CLAUDE_PROJECT_DIR="$SANDBOX"
INSTANCE_ID="ab12cd34"
INSTANCE_DIR="$SANDBOX/.claude/deepwork/$INSTANCE_ID"
mkdir -p "$INSTANCE_DIR"

SESSION_ID="test-banners-$(date +%s)"

LOG_FILE="${INSTANCE_DIR}/log.md"
touch "$LOG_FILE"

export CLAUDE_CODE_SESSION_ID="$SESSION_ID"
export INSTANCE_DIR
export LOG_FILE

STATE_JSON="${INSTANCE_DIR}/state.json"
SNAPSHOT="${INSTANCE_DIR}/.state-snapshot"

VALID_BANNER='{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "Proposal weighed risk differently; see proposals/v2.md §3",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}'

# Write state.json with given banners content, create snapshot from "before" content,
# then invoke state-drift-marker.sh in PostToolUse:Write mode.
# $1 = banners JSON (as jq expression for the banners array value)
# $2 = "before" phase (saved in snapshot, used to detect revert)
_run_post_hook() {
  local banners_json="$1"
  local before_phase="${2:-synthesize}"
  local stderr_file exit_code

  # Create clean "before" snapshot (valid, no banners)
  jq -cn \
    --arg sid "$SESSION_ID" \
    --arg phase "$before_phase" \
    '{session_id: $sid, phase: $phase, team_name: "test-team",
      frontmatter_schema_version: "1", banners: []}' \
    > "$SNAPSHOT"

  # Write state.json with the new banners content
  jq -cn \
    --arg sid "$SESSION_ID" \
    --argjson banners "$banners_json" \
    '{session_id: $sid, phase: "synthesize", team_name: "test-team",
      frontmatter_schema_version: "1", banners: $banners}' \
    | STATE_FILE="$STATE_JSON" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init -

  stderr_file=$(mktemp)
  local payload
  payload=$(jq -cn \
    --arg sid "$SESSION_ID" \
    --arg fp  "$STATE_JSON" \
    '{session_id: $sid, tool_name: "Write", tool_input: {file_path: $fp}}')
  printf '%s' "$payload" \
    | HOOK_EVENT_NAME="PostToolUse" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "$HOOK" 2>"$stderr_file" >/dev/null
  _LAST_EXIT=$?
  _LAST_STDERR=$(cat "$stderr_file")
  rm -f "$stderr_file"
}

# Run Pre then Post hook for a Bash tool use mentioning state.json
# $1 = banners JSON
_run_bash_path() {
  local banners_json="$1"
  local stderr_file

  # Create clean "before" snapshot
  jq -cn \
    --arg sid "$SESSION_ID" \
    '{session_id: $sid, phase: "synthesize", team_name: "test-team",
      frontmatter_schema_version: "1", banners: []}' \
    > "$SNAPSHOT"

  # Write state.json with bad banners (simulating jq+tmp+mv bash path)
  jq -cn \
    --arg sid "$SESSION_ID" \
    --argjson banners "$banners_json" \
    '{session_id: $sid, phase: "synthesize", team_name: "test-team",
      frontmatter_schema_version: "1", banners: $banners}' \
    | STATE_FILE="$STATE_JSON" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init -

  # Invoke PostToolUse:Bash (snapshot already exists from Pre leg)
  stderr_file=$(mktemp)
  local payload
  payload=$(jq -cn \
    --arg sid "$SESSION_ID" \
    '{session_id: $sid, tool_name: "Bash",
      tool_input: {command: "jq \".banners += [...]\" state.json > tmp && mv tmp state.json"}}')
  printf '%s' "$payload" \
    | HOOK_EVENT_NAME="PostToolUse" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "$HOOK" 2>"$stderr_file" >/dev/null
  _LAST_EXIT=$?
  _LAST_STDERR=$(cat "$stderr_file")
  rm -f "$stderr_file"
}

# ── (a) Valid banner entry — state.json unchanged ──
echo ""
echo "── TB-a: Valid banner entry → no revert ──"
_run_post_hook "[$VALID_BANNER]"
_assert_eq "TB-a: exit 0" "0" "$_LAST_EXIT"
# state.json should still have banners (not reverted)
_assert_json_field "TB-a: banners preserved" "$STATE_JSON" '.banners | length' "1"

# ── (b) Empty banners[] → no revert ──
echo ""
echo "── TB-b: Empty banners[] → no revert ──"
_run_post_hook "[]"
_assert_eq "TB-b: exit 0" "0" "$_LAST_EXIT"
_assert_json_field "TB-b: empty banners not reverted" "$STATE_JSON" '.banners | length' "0"

# ── (c) Missing artifact_path → revert + log.md blocker + stderr token ──
echo ""
echo "── TB-c: Missing artifact_path → revert ──"
BANNER_NO_PATH=$(jq -cn '{
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}')
_run_post_hook "[$BANNER_NO_PATH]"
_assert_eq "TB-c: exit 0 (non-blocking)" "0" "$_LAST_EXIT"
# Reverted — state.json should have banners=[] from snapshot
_assert_json_field "TB-c: state.json reverted" "$STATE_JSON" '.banners | length' "0"
_assert_file_contains "TB-c: log.md blocker line" "banner-corruption" "$LOG_FILE"
_assert_stderr_contains "TB-c: MISSING_ARTIFACT_PATH in stderr" "MISSING_ARTIFACT_PATH" "$_LAST_STDERR"

# Reset log.md between tests
: > "$LOG_FILE"

# ── (d) artifact_path wrong type → revert ──
echo ""
echo "── TB-d: artifact_path is number → revert ──"
BANNER_BAD_PATH=$(jq -cn '{
  "artifact_path": 42,
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}')
_run_post_hook "[$BANNER_BAD_PATH]"
_assert_eq "TB-d: exit 0" "0" "$_LAST_EXIT"
_assert_json_field "TB-d: state.json reverted" "$STATE_JSON" '.banners | length' "0"
_assert_stderr_contains "TB-d: ARTIFACT_PATH_NOT_STRING in stderr" "ARTIFACT_PATH_NOT_STRING" "$_LAST_STDERR"
: > "$LOG_FILE"

# ── (e) Missing reason → revert ──
echo ""
echo "── TB-e: Missing reason → revert ──"
BANNER_NO_REASON=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}')
_run_post_hook "[$BANNER_NO_REASON]"
_assert_eq "TB-e: exit 0" "0" "$_LAST_EXIT"
_assert_json_field "TB-e: state.json reverted" "$STATE_JSON" '.banners | length' "0"
_assert_stderr_contains "TB-e: MISSING_REASON in stderr" "MISSING_REASON" "$_LAST_STDERR"
: > "$LOG_FILE"

# ── (f) Missing added_at → revert ──
echo ""
echo "── TB-f: Missing added_at → revert ──"
BANNER_NO_ADDAT=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_by": "synthesizer"
}')
_run_post_hook "[$BANNER_NO_ADDAT]"
_assert_eq "TB-f: exit 0" "0" "$_LAST_EXIT"
_assert_json_field "TB-f: state.json reverted" "$STATE_JSON" '.banners | length' "0"
_assert_stderr_contains "TB-f: MISSING_ADDED_AT in stderr" "MISSING_ADDED_AT" "$_LAST_STDERR"
: > "$LOG_FILE"

# ── (g) added_at wrong format → revert ──
echo ""
echo "── TB-g: added_at non-ISO8601 → revert ──"
BANNER_BAD_DATE=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_at": "April 23 2026",
  "added_by": "synthesizer"
}')
_run_post_hook "[$BANNER_BAD_DATE]"
_assert_eq "TB-g: exit 0" "0" "$_LAST_EXIT"
_assert_json_field "TB-g: state.json reverted" "$STATE_JSON" '.banners | length' "0"
_assert_stderr_contains "TB-g: ADDED_AT_NOT_ISO8601 in stderr" "ADDED_AT_NOT_ISO8601" "$_LAST_STDERR"
: > "$LOG_FILE"

# ── (h) Missing added_by → revert ──
echo ""
echo "── TB-h: Missing added_by → revert ──"
BANNER_NO_ADDBY=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_at": "2026-04-23T10:00:00Z"
}')
_run_post_hook "[$BANNER_NO_ADDBY]"
_assert_eq "TB-h: exit 0" "0" "$_LAST_EXIT"
_assert_json_field "TB-h: state.json reverted" "$STATE_JSON" '.banners | length' "0"
_assert_stderr_contains "TB-h: MISSING_ADDED_BY in stderr" "MISSING_ADDED_BY" "$_LAST_STDERR"
: > "$LOG_FILE"

# ── (i) Unknown extra field → revert ──
echo ""
echo "── TB-i: Unknown extra field → revert ──"
BANNER_EXTRA=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer",
  "unexpected_extra": "oops"
}')
_run_post_hook "[$BANNER_EXTRA]"
_assert_eq "TB-i: exit 0" "0" "$_LAST_EXIT"
_assert_json_field "TB-i: state.json reverted" "$STATE_JSON" '.banners | length' "0"
_assert_stderr_contains "TB-i: UNKNOWN_FIELD in stderr" "UNKNOWN_FIELD" "$_LAST_STDERR"
: > "$LOG_FILE"

# ── (j) Invalid banner_type → revert ──
echo ""
echo "── TB-j: Invalid banner_type → revert ──"
BANNER_BAD_TYPE=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "made-up-type",
  "reason": "some reason",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}')
_run_post_hook "[$BANNER_BAD_TYPE]"
_assert_eq "TB-j: exit 0" "0" "$_LAST_EXIT"
_assert_json_field "TB-j: state.json reverted" "$STATE_JSON" '.banners | length' "0"
_assert_stderr_contains "TB-j: UNKNOWN_BANNER_TYPE in stderr" "UNKNOWN_BANNER_TYPE" "$_LAST_STDERR"
: > "$LOG_FILE"

# ── (k) pre-reconciliation-draft banner_type → valid, no revert ──
echo ""
echo "── TB-k: pre-reconciliation-draft banner_type → valid (no revert) ──"
BANNER_PRE_RECON=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "pre-reconciliation-draft",
  "reason": "hunter-b cross-check superseded this",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}')
_run_post_hook "[$BANNER_PRE_RECON]"
_assert_eq "TB-k: exit 0" "0" "$_LAST_EXIT"
_assert_json_field "TB-k: banners preserved" "$STATE_JSON" '.banners | length' "1"

# ── (l) Edit-bypass case: bad banners written via Edit tool → revert ──
echo ""
echo "── TB-l: Edit-bypass — bad banners via Edit tool → revert ──"
BANNER_EDIT_BAD=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "made-up-type",
  "reason": "bad",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}')

# Create snapshot (valid, no banners)
jq -cn --arg sid "$SESSION_ID" \
  '{session_id: $sid, phase: "synthesize", team_name: "test-team",
    frontmatter_schema_version: "1", banners: []}' \
  > "$SNAPSHOT"

# Write bad state.json directly to disk (simulating Edit landing bad banners)
jq -cn --arg sid "$SESSION_ID" --argjson banners "[$BANNER_EDIT_BAD]" \
  '{session_id: $sid, phase: "synthesize", team_name: "test-team",
    frontmatter_schema_version: "1", banners: $banners}' \
  | STATE_FILE="$STATE_JSON" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init -

_LAST_STDERR_L=""
stderr_file_l=$(mktemp)
payload_l=$(jq -cn --arg sid "$SESSION_ID" --arg fp "$STATE_JSON" \
  '{session_id: $sid, tool_name: "Edit", tool_input: {file_path: $fp}}')
printf '%s' "$payload_l" \
  | HOOK_EVENT_NAME="PostToolUse" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$HOOK" 2>"$stderr_file_l" >/dev/null
_LAST_STDERR_L=$(cat "$stderr_file_l")
rm -f "$stderr_file_l"

_assert_json_field "TB-l: Edit-bypass state.json reverted" "$STATE_JSON" '.banners | length' "0"
_assert_stderr_contains "TB-l: UNKNOWN_BANNER_TYPE via Edit" "UNKNOWN_BANNER_TYPE" "$_LAST_STDERR_L"
: > "$LOG_FILE"

# ── (m) Bash-bypass case: bad banners written via jq+tmp+mv → revert ──
echo ""
echo "── TB-m: Bash-bypass (jq+tmp+mv) — bad banners → revert ──"
BANNER_BASH_BAD=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "bad-type",
  "reason": "injected",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "attacker"
}')

_run_bash_path "[$BANNER_BASH_BAD]"
_assert_eq "TB-m: exit 0" "0" "$_LAST_EXIT"
_assert_json_field "TB-m: Bash-bypass state.json reverted" "$STATE_JSON" '.banners | length' "0"
_assert_stderr_contains "TB-m: UNKNOWN_BANNER_TYPE via Bash" "UNKNOWN_BANNER_TYPE" "$_LAST_STDERR"
: > "$LOG_FILE"

# ── (n) No snapshot → PostToolUse skips gracefully ──
echo ""
echo "── TB-n: No snapshot — PostToolUse skips gracefully ──"
rm -f "$SNAPSHOT"
jq -cn --arg sid "$SESSION_ID" \
  '{session_id: $sid, phase: "synthesize", team_name: "test-team",
    frontmatter_schema_version: "1", banners: []}' \
  | STATE_FILE="$STATE_JSON" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init -
stderr_file_n=$(mktemp)
payload_n=$(jq -cn --arg sid "$SESSION_ID" --arg fp "$STATE_JSON" \
  '{session_id: $sid, tool_name: "Write", tool_input: {file_path: $fp}}')
printf '%s' "$payload_n" \
  | HOOK_EVENT_NAME="PostToolUse" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
    bash "$HOOK" 2>"$stderr_file_n" >/dev/null
_assert_eq "TB-n: no snapshot → exit 0" "0" "$?"
rm -f "$stderr_file_n"

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
