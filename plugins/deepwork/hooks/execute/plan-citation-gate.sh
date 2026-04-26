#!/bin/bash
# plan-citation-gate.sh — PreToolUse(Write|Edit) gate enforcing G3 plan-citation and G4 EP3
# pending-test constraints.
#
# G3 (plan citation): Every file write/edit must be authorized by a pending-change.json entry
# listing the file path and a non-empty plan_section reference. Without a pending-change.json
# or without the target file in its files[] array, the write is blocked. This ensures every
# change is traceable to an approved plan section.
#
# G4 EP3 (pending-test block): If test-results.jsonl records a test covering the target file
# with last_result=="fail", "pending", or "unknown", the next write is blocked until the test
# passes. This enforces the test-evidence gate; test-capture.sh (PostToolUse:Bash) writes the
# evidence, and this hook reads it before each subsequent write. See mechanism.hooks-engineer.md
# §4 for the two-hook pattern (cli_formatted_2.1.116.js:266053-266058: PostToolUse cannot block;
# enforcement sits here on the next PreToolUse).
#
# Additional protection (GAP-10 mitigation): log files within INSTANCE_DIR are never in
# pending-change.json files[] and are blocked unconditionally to prevent audit trail tampering.
#
# Blocking form: exit 2 (stderr becomes blockingError per cli_formatted_2.1.116.js:564690).
# hookSpecificOutput.permissionDecision:"deny" is the preferred form for PreToolUse per
# cli_formatted_2.1.116.js:632082 (decision:"block" deprecated for PreToolUse), but exit 2 is
# equally valid for bash scripts and avoids JSON encoding complexity with dynamic path strings.
# CC source: cli_formatted_2.1.116.js:424926 (PreToolUse blockingError), :265655 (stdin schema).
#
# Fail-open: if no active execute instance, exit 0 immediately.

set +e

command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

discover_instance "$SESSION_ID" 2>/dev/null || exit 0

# Only active execute instances apply these gates
EXEC_PHASE=$(jq -r '.execute.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
[[ -n "$EXEC_PHASE" ]] || exit 0

FILE_PATH=$(_canonical_path "$(printf '%s' "$INPUT" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")")
[[ -n "$FILE_PATH" ]] || exit 0

# W14: synchronous plan-hash recomputation. plan-drift-detector.sh relies on a
# FileChanged(__plan_ref__) registration which may not fire on all installations.
# Re-checking the plan hash here on every Write|Edit guarantees drift is detected
# even without a working FileChanged watcher.
_PLAN_REF=$(jq -r '.execute.plan_ref // ""' "$STATE_FILE" 2>/dev/null || echo "")
_PLAN_HASH=$(jq -r '.execute.plan_hash // ""' "$STATE_FILE" 2>/dev/null || echo "")
if [[ -n "$_PLAN_REF" && -n "$_PLAN_HASH" && -f "$_PLAN_REF" ]]; then
  if command -v sha256sum >/dev/null 2>&1; then
    _CURRENT_PLAN_HASH=$(sha256sum "$_PLAN_REF" 2>/dev/null | awk '{print $1}' || echo "")
  elif command -v shasum >/dev/null 2>&1; then
    _CURRENT_PLAN_HASH=$(shasum -a 256 "$_PLAN_REF" 2>/dev/null | awk '{print $1}' || echo "")
  else
    _CURRENT_PLAN_HASH=""
  fi
  if [[ -n "$_CURRENT_PLAN_HASH" && "$_CURRENT_PLAN_HASH" != "$_PLAN_HASH" ]]; then
    _NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    STATE_FILE="$STATE_FILE" bash "${_PLUGIN_ROOT}/scripts/state-transition.sh" merge \
      "{\"execute\":{\"plan_drift_detected\":true,\"plan_drift_detected_at\":\"${_NOW}\",\"plan_hash_at_drift\":\"${_CURRENT_PLAN_HASH}\"}}" \
      2>/dev/null || true
  fi
fi

# Drift block: if plan_drift_detected is true, all writes are blocked until amended
DRIFT=$(jq -r '.execute.plan_drift_detected // false' "$STATE_FILE" 2>/dev/null || echo "false")
if [[ "$DRIFT" == "true" ]]; then
  printf 'DRIFT BLOCKED — run /deepwork-execute-amend before proceeding.\n' >&2
  exit 2
fi

# GAP-10 mitigation: unconditionally block writes to execute log files (extended list)
for _protected in "test-results.jsonl" "change_log.jsonl" "rollback_log.jsonl" "discoveries.jsonl" "pending-change.json" "log.md" "hook-timing.jsonl" "incidents.jsonl" "metrics-violations.jsonl"; do
  if [[ "$FILE_PATH" == "${INSTANCE_DIR}/${_protected}" ]]; then
    printf 'BLOCKED: writes to execute log file %s are not permitted (GAP-10 audit trail protection).\n' "$_protected" >&2
    exit 2
  fi
done

PENDING_CHANGE="${INSTANCE_DIR}/pending-change.json"

# --- Gate G3: plan-citation check ---
if [[ ! -f "$PENDING_CHANGE" ]]; then
  printf 'BLOCKED (G3): no pending-change.json found at %s\n' "$PENDING_CHANGE" >&2
  printf 'Before writing any file, create %s with:\n' "$PENDING_CHANGE" >&2
  printf '  {"plan_section": "<plan_file>#<section>", "files": ["%s"], "change_id": "<uuid>"}\n' "$FILE_PATH" >&2
  exit 2
fi

PENDING_JSON=$(jq '.' "$PENDING_CHANGE" 2>/dev/null)
if [[ -z "$PENDING_JSON" ]]; then
  printf 'BLOCKED (G3): pending-change.json at %s is not valid JSON.\n' "$PENDING_CHANGE" >&2
  exit 2
fi

PLAN_SECTION=$(printf '%s' "$PENDING_JSON" | jq -r '.plan_section // ""' 2>/dev/null || echo "")
if [[ -z "$PLAN_SECTION" ]] || [[ "$PLAN_SECTION" == "null" ]]; then
  printf 'BLOCKED (G3): pending-change.json.plan_section is empty — must reference an approved plan section (e.g. "v3-final.md#M4").\n' >&2
  exit 2
fi

# Check file is in pending-change.json files[] — canonicalize each entry before comparing
# so that unresolved symlinks in files[] (e.g. /tmp on macOS) match the canonicalized FILE_PATH.
FILE_IN_LIST="0"
while IFS= read -r _entry; do
  [[ -z "$_entry" ]] && continue
  _canon_entry=$(_canonical_path "$_entry")
  if [[ "$_canon_entry" == "$FILE_PATH" ]]; then
    FILE_IN_LIST="1"
    break
  fi
done < <(printf '%s' "$PENDING_JSON" | jq -r '.files // [] | .[]' 2>/dev/null || true)

if [[ "$FILE_IN_LIST" == "0" ]]; then
  printf 'BLOCKED (G3): file "%s" is not listed in pending-change.json.files[].\n' "$FILE_PATH" >&2
  printf 'Authorized files for change %s:\n' "$(printf '%s' "$PENDING_JSON" | jq -r '.change_id // "unknown"' 2>/dev/null)" >&2
  printf '%s\n' "$(printf '%s' "$PENDING_JSON" | jq -r '.files // [] | .[]' 2>/dev/null)" >&2
  printf 'Update pending-change.json.files[] to include this path before writing.\n' >&2
  exit 2
fi

# Verify the plan file referenced by plan_section exists.
# plan_section form: "<plan_ref>#<section>" | "#<section>" | bare section id.
# Canonical plan path comes from state.execute.plan_ref (set at SETUP and never mutated).
# If plan_section contains a path component before '#', that path is checked as an absolute
# path first; if not absolute, we fall back to state.execute.plan_ref.
STATE_PLAN_REF=$(jq -r '.execute.plan_ref // ""' "$STATE_FILE" 2>/dev/null || echo "")
PLAN_FILE_REF=$(printf '%s' "$PLAN_SECTION" | cut -d'#' -f1)
if [[ -n "$PLAN_FILE_REF" ]]; then
  if [[ "$PLAN_FILE_REF" == /* ]]; then
    PLAN_FILE_PATH="$PLAN_FILE_REF"
  elif [[ -n "$STATE_PLAN_REF" && "$STATE_PLAN_REF" == /* ]]; then
    PLAN_FILE_PATH="$STATE_PLAN_REF"
  elif [[ -n "$STATE_PLAN_REF" ]]; then
    PLAN_FILE_PATH="${INSTANCE_DIR}/${STATE_PLAN_REF}"
  else
    PLAN_FILE_PATH="${INSTANCE_DIR}/${PLAN_FILE_REF}"
  fi
  if [[ ! -f "$PLAN_FILE_PATH" ]]; then
    printf 'BLOCKED (G3): referenced plan file "%s" not found at %s.\n' "$PLAN_FILE_REF" "$PLAN_FILE_PATH" >&2
    exit 2
  fi
fi

# --- Gate G5: new-file test coverage ---
# If the target file is NOT in state.execute.test_manifest, require pending-change.json
# to contain a non-empty no_test_reason field.
# Canonicalize each test_manifest entry before comparing (same reason as G3 above).
TEST_MANIFEST="0"
while IFS= read -r _tm_entry; do
  [[ -z "$_tm_entry" ]] && continue
  _canon_tm=$(_canonical_path "$_tm_entry")
  if [[ "$_canon_tm" == "$FILE_PATH" ]]; then
    TEST_MANIFEST="1"
    break
  fi
done < <(jq -r '.execute.test_manifest // [] | map(if type == "object" then (.source_file // .) else . end) | .[]' "$STATE_FILE" 2>/dev/null || true)

if [[ "$TEST_MANIFEST" == "0" ]]; then
  NO_TEST_REASON=$(printf '%s' "$PENDING_JSON" | jq -r '.no_test_reason // ""' 2>/dev/null || echo "")
  if [[ -z "$NO_TEST_REASON" ]] || [[ "$NO_TEST_REASON" == "null" ]]; then
    printf 'BLOCKED (G5): no test coverage and no documented exception.\n' >&2
    printf 'File "%s" is not in state.execute.test_manifest.\n' "$FILE_PATH" >&2
    printf 'Add a test_manifest entry or set '"'"'no_test_reason'"'"' in pending-change.json.\n' >&2
    exit 2
  fi
fi

# --- Gate G4 EP3: pending-test block ---
# Read test-results.jsonl. Find entries whose covering_files[] includes FILE_PATH.
# If any such entry has exit_code != 0 (fail/error), block until tests pass.
TEST_RESULTS="${INSTANCE_DIR}/test-results.jsonl"
if [[ -f "$TEST_RESULTS" ]] && [[ -s "$TEST_RESULTS" ]]; then
  # Find the most recent test result entry for each covering file matching FILE_PATH
  # An exit_code of 0 means pass; non-zero means fail/error. Block on non-zero.
  FAILING_TEST=$(jq -rs --arg fp "$FILE_PATH" '
    map(select(
      (.covering_files // []) | map(. == $fp) | any
    )) |
    if length == 0 then null
    else
      # Get the most recent entry
      sort_by(.timestamp) | last |
      if .exit_code != 0 then . else null end
    end
  ' "$TEST_RESULTS" 2>/dev/null || echo "null")

  if [[ -n "$FAILING_TEST" ]] && [[ "$FAILING_TEST" != "null" ]]; then
    FAIL_CMD=$(printf '%s' "$FAILING_TEST" | jq -r '.command // "unknown"' 2>/dev/null || echo "unknown")
    FAIL_CODE=$(printf '%s' "$FAILING_TEST" | jq -r '.exit_code // "?" | tostring' 2>/dev/null || echo "?")
    printf 'BLOCKED (G4 EP3): covering test "%s" last exited with code %s.\n' "$FAIL_CMD" "$FAIL_CODE" >&2
    printf 'Fix failing tests before writing to %s.\n' "$FILE_PATH" >&2
    printf 'Run the test suite again to produce a passing result, then retry.\n' >&2
    exit 2
  fi
fi

exit 0
