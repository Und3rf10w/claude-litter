#!/usr/bin/env bash
# test-banners-schema.sh — regression tests for banners[] schema validation in
# hooks/frontmatter-gate.sh (C6 enforcement, 2026-04-23 deepwork audit)
#
# Schema: references/schemas/banner-schema.json
# Required fields per entry: artifact_path (string), banner_type (enum),
#   reason (string), added_at (ISO8601), added_by (string)
# additionalProperties: false
#
# Exit 0 = all cases pass; Exit 1 = one or more failures.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
GATE="${PLUGIN_ROOT}/hooks/frontmatter-gate.sh"

if [[ ! -f "$GATE" ]]; then
  printf 'SKIP: frontmatter-gate.sh not found at %s\n' "$GATE" >&2
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

# ── Fixture setup ──
SANDBOX=$(mktemp -d)
trap 'rm -rf "$SANDBOX"' EXIT

export CLAUDE_PROJECT_DIR="$SANDBOX"
INSTANCE_ID="ab12cd34"
INSTANCE_DIR="$SANDBOX/.claude/deepwork/$INSTANCE_ID"
mkdir -p "$INSTANCE_DIR"

SESSION_ID="test-banners-$(date +%s)"

cat > "$INSTANCE_DIR/state.json" <<EOF
{
  "session_id": "$SESSION_ID",
  "phase": "synthesize",
  "team_name": "test-team",
  "frontmatter_schema_version": "1",
  "banners": []
}
EOF

export CLAUDE_CODE_SESSION_ID="$SESSION_ID"

STATE_JSON="${INSTANCE_DIR}/state.json"

# Run gate against a state.json write; capture exit code and stderr into globals
# _LAST_EXIT and _LAST_STDERR.
_run_state_gate() {
  local content="$1"
  local payload stderr_file exit_code
  stderr_file=$(mktemp)
  payload=$(jq -cn \
    --arg sid "$SESSION_ID" \
    --arg fp  "$STATE_JSON" \
    --arg c   "$content" \
    '{session_id: $sid, tool_name: "Write", tool_input: {file_path: $fp, content: $c}}')
  printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$GATE" 2>"$stderr_file" >/dev/null
  _LAST_EXIT=$?
  _LAST_STDERR=$(cat "$stderr_file")
  rm -f "$stderr_file"
}

# Run gate against an arbitrary file path write; returns exit code in _LAST_EXIT.
_run_file_gate() {
  local file_path="$1" content="$2"
  local payload stderr_file
  stderr_file=$(mktemp)
  payload=$(jq -cn \
    --arg sid "$SESSION_ID" \
    --arg fp  "$file_path" \
    --arg c   "$content" \
    '{session_id: $sid, tool_name: "Write", tool_input: {file_path: $fp, content: $c}}')
  printf '%s' "$payload" | CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" bash "$GATE" 2>"$stderr_file" >/dev/null
  _LAST_EXIT=$?
  _LAST_STDERR=$(cat "$stderr_file")
  rm -f "$stderr_file"
}

VALID_BANNER='{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "Proposal weighed risk differently; see proposals/v2.md §3",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}'

# ── (a) Valid banner entry → exit 0 ──
echo ""
echo "── TB-a: Valid banner entry → pass (exit 0) ──"
CONTENT_VALID=$(jq -cn --argjson b "$VALID_BANNER" '{phase:"synthesize","banners":[$b]}')
_run_state_gate "$CONTENT_VALID"
_assert_exit "TB-a: valid banner" "0" "$_LAST_EXIT"

# ── (b) Empty banners[] → exit 0 ──
echo ""
echo "── TB-b: Empty banners[] → pass (exit 0) ──"
_run_state_gate '{"phase":"synthesize","banners":[]}'
_assert_exit "TB-b: empty banners" "0" "$_LAST_EXIT"

# ── (c) No banners field → exit 0 ──
echo ""
echo "── TB-c: No banners field → pass (exit 0) ──"
_run_state_gate '{"phase":"synthesize"}'
_assert_exit "TB-c: no banners field" "0" "$_LAST_EXIT"

# ── (d) Missing artifact_path → exit 2, stderr MISSING_ARTIFACT_PATH ──
echo ""
echo "── TB-d: Missing artifact_path → blocked (exit 2), MISSING_ARTIFACT_PATH ──"
BANNER_NO_PATH=$(jq -cn '{
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}')
CONTENT_NO_PATH=$(jq -cn --argjson b "$BANNER_NO_PATH" '{phase:"synthesize","banners":[$b]}')
_run_state_gate "$CONTENT_NO_PATH"
_assert_exit "TB-d: missing artifact_path exit" "2" "$_LAST_EXIT"
_assert_stderr_contains "TB-d: MISSING_ARTIFACT_PATH in stderr" "MISSING_ARTIFACT_PATH" "$_LAST_STDERR"

# ── (e) artifact_path wrong type (number) → exit 2, ARTIFACT_PATH_NOT_STRING ──
echo ""
echo "── TB-e: artifact_path is number → blocked (exit 2), ARTIFACT_PATH_NOT_STRING ──"
BANNER_BAD_PATH=$(jq -cn '{
  "artifact_path": 42,
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}')
CONTENT_BAD_PATH=$(jq -cn --argjson b "$BANNER_BAD_PATH" '{phase:"synthesize","banners":[$b]}')
_run_state_gate "$CONTENT_BAD_PATH"
_assert_exit "TB-e: artifact_path number exit" "2" "$_LAST_EXIT"
_assert_stderr_contains "TB-e: ARTIFACT_PATH_NOT_STRING in stderr" "ARTIFACT_PATH_NOT_STRING" "$_LAST_STDERR"

# ── (f) Missing reason → exit 2, MISSING_REASON ──
echo ""
echo "── TB-f: Missing reason → blocked (exit 2), MISSING_REASON ──"
BANNER_NO_REASON=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}')
CONTENT_NO_REASON=$(jq -cn --argjson b "$BANNER_NO_REASON" '{phase:"synthesize","banners":[$b]}')
_run_state_gate "$CONTENT_NO_REASON"
_assert_exit "TB-f: missing reason exit" "2" "$_LAST_EXIT"
_assert_stderr_contains "TB-f: MISSING_REASON in stderr" "MISSING_REASON" "$_LAST_STDERR"

# ── (g) Missing added_at → exit 2, MISSING_ADDED_AT ──
echo ""
echo "── TB-g: Missing added_at → blocked (exit 2), MISSING_ADDED_AT ──"
BANNER_NO_ADDAT=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_by": "synthesizer"
}')
CONTENT_NO_ADDAT=$(jq -cn --argjson b "$BANNER_NO_ADDAT" '{phase:"synthesize","banners":[$b]}')
_run_state_gate "$CONTENT_NO_ADDAT"
_assert_exit "TB-g: missing added_at exit" "2" "$_LAST_EXIT"
_assert_stderr_contains "TB-g: MISSING_ADDED_AT in stderr" "MISSING_ADDED_AT" "$_LAST_STDERR"

# ── (h) added_at wrong format (not ISO8601) → exit 2, ADDED_AT_NOT_ISO8601 ──
echo ""
echo "── TB-h: added_at non-ISO8601 → blocked (exit 2), ADDED_AT_NOT_ISO8601 ──"
BANNER_BAD_DATE=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_at": "April 23 2026",
  "added_by": "synthesizer"
}')
CONTENT_BAD_DATE=$(jq -cn --argjson b "$BANNER_BAD_DATE" '{phase:"synthesize","banners":[$b]}')
_run_state_gate "$CONTENT_BAD_DATE"
_assert_exit "TB-h: bad added_at exit" "2" "$_LAST_EXIT"
_assert_stderr_contains "TB-h: ADDED_AT_NOT_ISO8601 in stderr" "ADDED_AT_NOT_ISO8601" "$_LAST_STDERR"

# ── (i) Missing added_by → exit 2, MISSING_ADDED_BY ──
echo ""
echo "── TB-i: Missing added_by → blocked (exit 2), MISSING_ADDED_BY ──"
BANNER_NO_ADDBY=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_at": "2026-04-23T10:00:00Z"
}')
CONTENT_NO_ADDBY=$(jq -cn --argjson b "$BANNER_NO_ADDBY" '{phase:"synthesize","banners":[$b]}')
_run_state_gate "$CONTENT_NO_ADDBY"
_assert_exit "TB-i: missing added_by exit" "2" "$_LAST_EXIT"
_assert_stderr_contains "TB-i: MISSING_ADDED_BY in stderr" "MISSING_ADDED_BY" "$_LAST_STDERR"

# ── (j) Unknown field (strict schema) → exit 2, UNKNOWN_FIELD ──
echo ""
echo "── TB-j: Unknown extra field → blocked (exit 2), UNKNOWN_FIELD ──"
BANNER_EXTRA=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "synthesis-deviation-backpointer",
  "reason": "some reason",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer",
  "unexpected_extra": "oops"
}')
CONTENT_EXTRA=$(jq -cn --argjson b "$BANNER_EXTRA" '{phase:"synthesize","banners":[$b]}')
_run_state_gate "$CONTENT_EXTRA"
_assert_exit "TB-j: unknown field exit" "2" "$_LAST_EXIT"
_assert_stderr_contains "TB-j: UNKNOWN_FIELD in stderr" "UNKNOWN_FIELD" "$_LAST_STDERR"

# ── (k) banner_type not in enum → exit 2, UNKNOWN_BANNER_TYPE ──
echo ""
echo "── TB-k: Invalid banner_type → blocked (exit 2), UNKNOWN_BANNER_TYPE ──"
BANNER_BAD_TYPE=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "made-up-type",
  "reason": "some reason",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}')
CONTENT_BAD_TYPE=$(jq -cn --argjson b "$BANNER_BAD_TYPE" '{phase:"synthesize","banners":[$b]}')
_run_state_gate "$CONTENT_BAD_TYPE"
_assert_exit "TB-k: unknown banner_type exit" "2" "$_LAST_EXIT"
_assert_stderr_contains "TB-k: UNKNOWN_BANNER_TYPE in stderr" "UNKNOWN_BANNER_TYPE" "$_LAST_STDERR"

# ── (l) Non-state.json write (file outside instance dir) → exit 0 (gate skips) ──
echo ""
echo "── TB-l: Write to file outside instance dir → gate skips (exit 0) ──"
OTHER_FILE="$SANDBOX/proposals/v1.md"
mkdir -p "$SANDBOX/proposals"
_run_file_gate "$OTHER_FILE" "# Proposal v1"
_assert_exit "TB-l: non-instance-dir write skipped" "0" "$_LAST_EXIT"

# ── (m) Malformed state.json content (not valid JSON) → exit 0 (fail-open) ──
echo ""
echo "── TB-m: Malformed JSON content → fail-open (exit 0) ──"
_run_state_gate 'not valid json {{{{'
_assert_exit "TB-m: malformed JSON fail-open" "0" "$_LAST_EXIT"

# ── (n) pre-reconciliation-draft banner_type → valid, exit 0 ──
echo ""
echo "── TB-n: pre-reconciliation-draft banner_type → valid (exit 0) ──"
BANNER_PRE_RECON=$(jq -cn '{
  "artifact_path": "findings.hunter-a.md",
  "banner_type": "pre-reconciliation-draft",
  "reason": "hunter-b cross-check superseded this",
  "added_at": "2026-04-23T10:00:00Z",
  "added_by": "synthesizer"
}')
CONTENT_PRE_RECON=$(jq -cn --argjson b "$BANNER_PRE_RECON" '{phase:"synthesize","banners":[$b]}')
_run_state_gate "$CONTENT_PRE_RECON"
_assert_exit "TB-n: pre-reconciliation-draft valid" "0" "$_LAST_EXIT"

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
