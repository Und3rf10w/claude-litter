#!/usr/bin/env bash
# test-hook-contract.sh — regression tests for _parse_hook_input and _load_task_file (W11 contract)
#
# Verifies that the v2.1.118 hook input contract is correctly implemented:
#   HC-a: _parse_hook_input exports SESSION_ID, HOOK_EVENT_NAME, TOOL_NAME, TOOL_USE_ID from stdin JSON
#   HC-b: _parse_hook_input with missing fields exports empty strings (no crash, no env fallback)
#   HC-c: discover_instance requires explicit session_id arg (no CLAUDE_CODE_SESSION_ID fallback)
#   HC-d: _load_task_file resolves team_name/task_id to task file path
#
# Exit 0 = all ran cases passed
# Exit 1 = one or more failures

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
INSTANCE_LIB="${PLUGIN_ROOT}/scripts/instance-lib.sh"

if [[ ! -f "$INSTANCE_LIB" ]]; then
  printf 'SKIP: instance-lib.sh not found at %s\n' "$INSTANCE_LIB" >&2
  exit 0
fi

PASS=0
FAIL=0

_assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    printf 'pass: %s\n' "$name"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected=%q, got=%q\n' "$name" "$expected" "$actual" >&2
    FAIL=$((FAIL + 1))
  fi
}

_assert_nonempty() {
  local name="$1" actual="$2"
  if [[ -n "$actual" ]]; then
    printf 'pass: %s (value=%q)\n' "$name" "$actual"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — expected non-empty, got empty\n' "$name" >&2
    FAIL=$((FAIL + 1))
  fi
}

# ── HC-a: _parse_hook_input exports all fields from stdin JSON ──
echo ""
echo "── HC-a: _parse_hook_input exports SESSION_ID, HOOK_EVENT_NAME, TOOL_NAME, TOOL_USE_ID ──"

_result=$(
  printf '%s' '{"session_id":"ses-abc","hook_event_name":"PreToolUse","tool_name":"Write","tool_use_id":"uid-xyz"}' \
  | bash -c "
    source '${INSTANCE_LIB}'
    _parse_hook_input
    printf '%s|%s|%s|%s' \"\$SESSION_ID\" \"\$HOOK_EVENT_NAME\" \"\$TOOL_NAME\" \"\$TOOL_USE_ID\"
  " 2>/dev/null
)

_sid_got=$(printf '%s' "$_result" | cut -d'|' -f1)
_hen_got=$(printf '%s' "$_result" | cut -d'|' -f2)
_tn_got=$(printf '%s'  "$_result" | cut -d'|' -f3)
_uid_got=$(printf '%s' "$_result" | cut -d'|' -f4)

_assert_eq "HC-a: SESSION_ID from stdin"        "ses-abc"    "$_sid_got"
_assert_eq "HC-a: HOOK_EVENT_NAME from stdin"   "PreToolUse" "$_hen_got"
_assert_eq "HC-a: TOOL_NAME from stdin"         "Write"      "$_tn_got"
_assert_eq "HC-a: TOOL_USE_ID from stdin"       "uid-xyz"    "$_uid_got"

# ── HC-b: _parse_hook_input with missing fields → empty strings ──
echo ""
echo "── HC-b: _parse_hook_input with missing fields → empty strings ──"

_result_b=$(
  printf '%s' '{"session_id":"ses-def"}' \
  | bash -c "
    source '${INSTANCE_LIB}'
    _parse_hook_input
    printf '%s|%s|%s|%s' \"\$SESSION_ID\" \"\$HOOK_EVENT_NAME\" \"\$TOOL_NAME\" \"\$TOOL_USE_ID\"
  " 2>/dev/null
)

_sid_b=$(printf '%s'  "$_result_b" | cut -d'|' -f1)
_hen_b=$(printf '%s'  "$_result_b" | cut -d'|' -f2)
_tn_b=$(printf '%s'   "$_result_b" | cut -d'|' -f3)
_uid_b=$(printf '%s'  "$_result_b" | cut -d'|' -f4)

_assert_eq "HC-b: SESSION_ID present when supplied"   "ses-def" "$_sid_b"
_assert_eq "HC-b: HOOK_EVENT_NAME empty when absent"  ""        "$_hen_b"
_assert_eq "HC-b: TOOL_NAME empty when absent"        ""        "$_tn_b"
_assert_eq "HC-b: TOOL_USE_ID empty when absent"      ""        "$_uid_b"

# HC-b2: env fallback is NOT used — CLAUDE_CODE_SESSION_ID must not bleed in
_result_b2=$(
  printf '%s' '{}' \
  | bash -c "
    export CLAUDE_CODE_SESSION_ID='should-not-appear'
    source '${INSTANCE_LIB}'
    _parse_hook_input
    printf '%s' \"\$SESSION_ID\"
  " 2>/dev/null
)
_assert_eq "HC-b: no env fallback for SESSION_ID" "" "$_result_b2"

# ── HC-c: discover_instance requires explicit session_id arg (no CLAUDE_CODE_SESSION_ID fallback) ──
echo ""
echo "── HC-c: discover_instance with no arg and CLAUDE_CODE_SESSION_ID set → returns 1 ──"

SANDBOX_C=$(mktemp -d)
trap 'rm -rf "$SANDBOX_C"' EXIT

_sid_c="hc-c-session-$(date +%s)"
INST_DIR_C="${SANDBOX_C}/.claude/deepwork/ab12cd34"
mkdir -p "$INST_DIR_C"
STATE_FILE_C="${INST_DIR_C}/state.json"
STATE_FILE="$STATE_FILE_C" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init \
  "{\"session_id\":\"${_sid_c}\",\"phase\":\"explore\",\"team_name\":\"test\"}" 2>/dev/null

# With explicit session_id arg → success
RC_C1=$(
  bash -c "
    export CLAUDE_PROJECT_DIR='$SANDBOX_C'
    source '${INSTANCE_LIB}'
    discover_instance '${_sid_c}'
  " >/dev/null 2>&1; echo $?
)
_assert_eq "HC-c: discover_instance with explicit arg succeeds" "0" "$RC_C1"

# With no arg, even when CLAUDE_CODE_SESSION_ID is set → fails (no fallback)
RC_C2=$(
  bash -c "
    export CLAUDE_PROJECT_DIR='$SANDBOX_C'
    export CLAUDE_CODE_SESSION_ID='${_sid_c}'
    source '${INSTANCE_LIB}'
    discover_instance
  " >/dev/null 2>&1; echo $?
)
_assert_eq "HC-c: discover_instance with no arg and CLAUDE_CODE_SESSION_ID set → fails (1)" "1" "$RC_C2"

# ── HC-d: _load_task_file resolves team/task to file path ──
echo ""
echo "── HC-d: _load_task_file resolves team_name/task_id to task file ──"

_TASKS_DIR=$(mktemp -d)
_TEAM="hc-d-team"
_TASK_ID="task-001"
_TASK_FILE_DIR="${_TASKS_DIR}/.claude/tasks/${_TEAM}"
mkdir -p "$_TASK_FILE_DIR"
printf '%s\n' '{"task_id":"task-001","task_subject":"Test task","metadata":{"wave":"W3"}}' \
  > "${_TASK_FILE_DIR}/${_TASK_ID}.json"

_result_d=$(
  bash -c "
    export HOME='$_TASKS_DIR'
    source '${INSTANCE_LIB}'
    if _load_task_file '${_TEAM}' '${_TASK_ID}'; then
      printf '%s|%s' \"\$TASK_FILE_PATH\" \"\$(printf '%s' \"\$TASK_JSON\" | jq -r '.task_subject' 2>/dev/null)\"
    else
      printf 'LOAD_FAILED'
    fi
  " 2>/dev/null
)

_tfp=$(printf '%s' "$_result_d" | cut -d'|' -f1)
_tsubject=$(printf '%s' "$_result_d" | cut -d'|' -f2)

_assert_nonempty "HC-d: TASK_FILE_PATH is set"                 "$_tfp"
_assert_eq      "HC-d: TASK_JSON contains task_subject"        "Test task" "$_tsubject"

# HC-d2: missing task file → returns 1
_result_d2=$(
  bash -c "
    export HOME='$_TASKS_DIR'
    source '${INSTANCE_LIB}'
    _load_task_file '${_TEAM}' 'no-such-task-999'
    echo \$?
  " 2>/dev/null
)
_assert_eq "HC-d: _load_task_file returns 1 for missing file" "1" "$_result_d2"

rm -rf "$_TASKS_DIR"

# ── HC-e: session-context.sh emits hookSpecificOutput.watchPaths for proposals/v*.md files ──
echo ""
echo "── HC-e: session-context.sh emits watchPaths JSON for proposals/v*.md files ──"

SANDBOX_E=$(mktemp -d)
trap 'rm -rf "$SANDBOX_C" "$SANDBOX_E"' EXIT

_sid_e="hc-e-session-$(date +%s)"
# Instance ID must be exactly 8 lowercase hex chars (validated by discover_instance)
INST_DIR_E="${SANDBOX_E}/.claude/deepwork/ab12cd34"
mkdir -p "${INST_DIR_E}/proposals"
printf 'v1.md content\n' > "${INST_DIR_E}/proposals/v1.md"
printf 'v2-final.md content\n' > "${INST_DIR_E}/proposals/v2-final.md"
# non-matching file — should not appear in watchPaths
printf 'notes content\n' > "${INST_DIR_E}/proposals/notes.md"

STATE_FILE_E="${INST_DIR_E}/state.json"
STATE_FILE="$STATE_FILE_E" bash "${PLUGIN_ROOT}/scripts/state-transition.sh" init \
  "{\"session_id\":\"${_sid_e}\",\"phase\":\"scope\",\"team_name\":\"hce-team\",\"goal\":\"test goal\",\"mode\":\"default\"}" 2>/dev/null

_sc_output=$(
  printf '%s' "{\"session_id\":\"${_sid_e}\",\"hook_event_name\":\"SessionStart\"}" \
    | CLAUDE_PROJECT_DIR="$SANDBOX_E" CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" \
      bash "${PLUGIN_ROOT}/hooks/session-context.sh" 2>/dev/null || true
)

# Extract the hookSpecificOutput line — may be last line of output
_watch_line=$(printf '%s' "$_sc_output" | grep -o '{"hookSpecificOutput".*}' | head -1)
_watch_paths_json=$(printf '%s' "$_watch_line" | jq -r '.hookSpecificOutput.watchPaths // empty' 2>/dev/null)
_path_count=$(printf '%s' "$_watch_paths_json" | jq 'length' 2>/dev/null || echo "0")
_has_v1=$(printf '%s' "$_watch_paths_json" | jq -r '.[] | select(endswith("v1.md"))' 2>/dev/null)
_has_v2=$(printf '%s' "$_watch_paths_json" | jq -r '.[] | select(endswith("v2-final.md"))' 2>/dev/null)
_has_notes=$(printf '%s' "$_watch_paths_json" | jq -r '.[] | select(endswith("notes.md"))' 2>/dev/null)

_assert_eq "HC-e: watchPaths contains exactly 2 entries" "2" "$_path_count"
_assert_nonempty "HC-e: watchPaths includes v1.md" "$_has_v1"
_assert_nonempty "HC-e: watchPaths includes v2-final.md" "$_has_v2"
_assert_eq "HC-e: watchPaths excludes notes.md" "" "$_has_notes"

rm -rf "$SANDBOX_E"

# ── Summary ──
echo ""
echo "─────────────────────────────────────"
printf "Passed: %d | Failed: %d\n" "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
