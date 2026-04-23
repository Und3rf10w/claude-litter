#!/usr/bin/env bash
# test-hook-timing.sh — regression tests for instance-lib.sh trap logic
#
# Highest-risk coverage gap: the EXIT trap MUST preserve $? across all hook
# exit paths. A bug here silently changes every hook's effective exit code —
# exit 2 (block) could become exit 0 (pass) and defeat the gate layer.
#
# Coverage:
#   C1a–d: exit code preservation (0, 1, 2, 127)
#   C2a–f: JSONL schema (fields, elapsed_ms int, ts ISO8601, blocked bool)
#   C3:    INSTANCE_DIR unset → silent no-op
#   C4:    double-source guard → exactly one JSONL entry
#   C5:    trap error robustness (jq mock failure)
#   C6a–c: HOOK_EVENT_NAME / TOOL_NAME handling
#
# Exit 0 = all pass; Exit 1 = one or more failures.

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

_pass() {
  printf 'pass: %s\n' "$1"
  PASS=$((PASS + 1))
}

_fail() {
  printf 'FAIL: %s\n' "$1" >&2
  if [[ -n "${2:-}" ]]; then
    printf '  detail: %s\n' "$2" >&2
  fi
  FAIL=$((FAIL + 1))
}

_assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    _pass "$name"
  else
    _fail "$name" "expected=${expected}, got=${actual}"
  fi
}

_assert_match() {
  local name="$1" pattern="$2" value="$3"
  if printf '%s' "$value" | grep -qE -- "$pattern"; then
    _pass "$name"
  else
    _fail "$name" "value='${value}' did not match pattern '${pattern}'"
  fi
}

# Create a minimal state.json so discover_instance can find the instance.
_make_instance() {
  local base_dir="$1" session_id="$2"
  local inst_id="deadbeef"
  local inst_dir="${base_dir}/.claude/deepwork/${inst_id}"
  mkdir -p "$inst_dir"
  printf '{"session_id":"%s","phase":"work","team_name":"test"}\n' "$session_id" \
    > "${inst_dir}/state.json"
  printf '%s' "$inst_dir"
}

# ── C1: Exit code preservation ──────────────────────────────────────────────

echo ""
echo "── C1: Exit code preservation ──"

for _code in 0 1 2 127; do
  _sandbox=$(mktemp -d)
  _sid="test-timing-$(date +%s)-${_code}"
  _inst_dir=$(_make_instance "$_sandbox" "$_sid")

  _actual=$(
    (
      unset _DW_TIMING_TRAP_INSTALLED
      unset INSTANCE_DIR
      export CLAUDE_PROJECT_DIR="$_sandbox"
      export CLAUDE_CODE_SESSION_ID="$_sid"
      # shellcheck source=/dev/null
      source "$INSTANCE_LIB"
      discover_instance
      exit $_code
    )
    echo $?
  )

  _assert_eq "C1: exit ${_code} preserved" "$_code" "$_actual"
  rm -rf "$_sandbox"
done

# ── C2: JSONL schema ─────────────────────────────────────────────────────────

echo ""
echo "── C2: JSONL schema ──"

_sandbox=$(mktemp -d)
_sid="test-schema-$(date +%s)"
_inst_dir=$(_make_instance "$_sandbox" "$_sid")

# Run a hook-like subshell that exits 0 (blocked=false)
(
  unset _DW_TIMING_TRAP_INSTALLED
  unset INSTANCE_DIR
  export CLAUDE_PROJECT_DIR="$_sandbox"
  export CLAUDE_CODE_SESSION_ID="$_sid"
  export HOOK_EVENT_NAME="PreToolUse"
  export TOOL_NAME="Write"
  source "$INSTANCE_LIB"
  discover_instance
  exit 0
) >/dev/null 2>&1

_timing_file="${_inst_dir}/hook-timing.jsonl"

if [[ ! -f "$_timing_file" ]]; then
  _fail "C2: hook-timing.jsonl written" "file not found: $_timing_file"
else
  _pass "C2: hook-timing.jsonl written"
  _last_line=$(tail -1 "$_timing_file")

  # C2a: parseable with jq
  if printf '%s' "$_last_line" | jq . >/dev/null 2>&1; then
    _pass "C2a: JSONL line is valid JSON"
  else
    _fail "C2a: JSONL line is valid JSON" "line: $_last_line"
  fi

  # C2b: required fields present (use has() to handle boolean false correctly)
  for _field in hook event tool elapsed_ms ts blocked; do
    _present=$(printf '%s' "$_last_line" | jq --arg f "$_field" 'has($f)' 2>/dev/null)
    if [[ "$_present" == "true" ]]; then
      _pass "C2b: field '${_field}' present"
    else
      _fail "C2b: field '${_field}' present" "line: $_last_line"
    fi
  done

  # C2c: elapsed_ms is a non-negative integer
  _elapsed=$(printf '%s' "$_last_line" | jq '.elapsed_ms' 2>/dev/null)
  if printf '%s' "$_elapsed" | grep -qE '^[0-9]+$'; then
    _pass "C2c: elapsed_ms is non-negative integer"
  else
    _fail "C2c: elapsed_ms is non-negative integer" "elapsed_ms=${_elapsed}"
  fi

  # C2d: ts matches ISO8601
  _ts=$(printf '%s' "$_last_line" | jq -r '.ts' 2>/dev/null)
  _assert_match "C2d: ts matches ISO8601" \
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$' "$_ts"

  # C2e: blocked is false when exit was 0
  _blocked=$(printf '%s' "$_last_line" | jq -r '.blocked' 2>/dev/null)
  _assert_eq "C2e: blocked=false for exit 0" "false" "$_blocked"
fi

rm -rf "$_sandbox"

# C2f: blocked=true when exit was 2
_sandbox=$(mktemp -d)
_sid="test-schema-exit2-$(date +%s)"
_inst_dir=$(_make_instance "$_sandbox" "$_sid")

(
  unset _DW_TIMING_TRAP_INSTALLED
  unset INSTANCE_DIR
  export CLAUDE_PROJECT_DIR="$_sandbox"
  export CLAUDE_CODE_SESSION_ID="$_sid"
  export HOOK_EVENT_NAME="PreToolUse"
  export TOOL_NAME="Write"
  source "$INSTANCE_LIB"
  discover_instance
  exit 2
) >/dev/null 2>&1

_timing_file="${_inst_dir}/hook-timing.jsonl"
if [[ -f "$_timing_file" ]]; then
  _last_line=$(tail -1 "$_timing_file")
  _blocked=$(printf '%s' "$_last_line" | jq -r '.blocked' 2>/dev/null)
  _assert_eq "C2f: blocked=true for exit 2" "true" "$_blocked"
else
  _fail "C2f: blocked=true for exit 2" "hook-timing.jsonl not found"
fi

rm -rf "$_sandbox"

# ── C3: INSTANCE_DIR unset — no file written, no stderr ──────────────────────

echo ""
echo "── C3: INSTANCE_DIR unset → silent no-op ──"

_sandbox=$(mktemp -d)
_stderr_file=$(mktemp)

(
  unset _DW_TIMING_TRAP_INSTALLED
  unset INSTANCE_DIR
  unset CLAUDE_PROJECT_DIR
  unset CLAUDE_CODE_SESSION_ID
  source "$INSTANCE_LIB"
  # discover_instance returns 1 here (no session), but INSTANCE_DIR stays unset
  discover_instance 2>/dev/null || true
  exit 0
) 2>"$_stderr_file" >/dev/null

# Confirm no timing file was written anywhere in sandbox
_files_written=$(find "$_sandbox" -name 'hook-timing.jsonl' 2>/dev/null | wc -l | tr -d ' ')
_assert_eq "C3a: no hook-timing.jsonl written when INSTANCE_DIR unset" "0" "$_files_written"

_stderr_content=$(cat "$_stderr_file")
if [[ -z "$_stderr_content" ]]; then
  _pass "C3b: no stderr when INSTANCE_DIR unset"
else
  _fail "C3b: no stderr when INSTANCE_DIR unset" "stderr: $_stderr_content"
fi

rm -rf "$_sandbox"
rm -f "$_stderr_file"

# ── C4: Double-source guard ───────────────────────────────────────────────────

echo ""
echo "── C4: double-source guard → exactly one JSONL entry ──"

_sandbox=$(mktemp -d)
_sid="test-doublesource-$(date +%s)"
_inst_dir=$(_make_instance "$_sandbox" "$_sid")

(
  unset _DW_TIMING_TRAP_INSTALLED
  unset INSTANCE_DIR
  export CLAUDE_PROJECT_DIR="$_sandbox"
  export CLAUDE_CODE_SESSION_ID="$_sid"
  # Source twice — guard must prevent duplicate trap
  source "$INSTANCE_LIB"
  source "$INSTANCE_LIB"
  discover_instance
  exit 0
) >/dev/null 2>&1

_timing_file="${_inst_dir}/hook-timing.jsonl"
if [[ -f "$_timing_file" ]]; then
  _line_count=$(wc -l < "$_timing_file" | tr -d ' ')
  _assert_eq "C4: exactly one JSONL line after double-source" "1" "$_line_count"
else
  _fail "C4: exactly one JSONL line after double-source" "hook-timing.jsonl not found"
fi

rm -rf "$_sandbox"

# ── C5: Trap error robustness — jq mock failure ───────────────────────────────

echo ""
echo "── C5: trap error robustness (jq mock failure) ──"

_sandbox=$(mktemp -d)
_sid="test-jq-fail-$(date +%s)"
_inst_dir=$(_make_instance "$_sandbox" "$_sid")

# Create a mock jq that always fails
_mock_bin=$(mktemp -d)
cat > "${_mock_bin}/jq" <<'MOCK'
#!/bin/bash
exit 1
MOCK
chmod +x "${_mock_bin}/jq"

_actual=$(
  (
    unset _DW_TIMING_TRAP_INSTALLED
    unset INSTANCE_DIR
    export CLAUDE_PROJECT_DIR="$_sandbox"
    # Bypass discover_instance's use of jq for state-file lookup by setting
    # INSTANCE_DIR directly (simulates a hook that already resolved its instance).
    export INSTANCE_DIR="$_inst_dir"
    # Prepend mock to PATH so the broken jq is used inside _dw_emit_timing
    export PATH="${_mock_bin}:${PATH}"
    source "$INSTANCE_LIB"
    # Manually set start time (discover_instance would normally set it)
    _HOOK_START_NS=0
    exit 2
  )
  echo $?
)

_assert_eq "C5: exit 2 preserved despite jq failure in trap" "2" "$_actual"

rm -rf "$_sandbox" "$_mock_bin"

# ── C6: HOOK_EVENT_NAME / TOOL_NAME handling ──────────────────────────────────

echo ""
echo "── C6: HOOK_EVENT_NAME / TOOL_NAME handling ──"

# C6a: both set → values present in JSONL
_sandbox=$(mktemp -d)
_sid="test-envvars-both-$(date +%s)"
_inst_dir=$(_make_instance "$_sandbox" "$_sid")

(
  unset _DW_TIMING_TRAP_INSTALLED
  unset INSTANCE_DIR
  export CLAUDE_PROJECT_DIR="$_sandbox"
  export CLAUDE_CODE_SESSION_ID="$_sid"
  export HOOK_EVENT_NAME="PostToolUse"
  export TOOL_NAME="Read"
  source "$INSTANCE_LIB"
  discover_instance
  exit 0
) >/dev/null 2>&1

_timing_file="${_inst_dir}/hook-timing.jsonl"
if [[ -f "$_timing_file" ]]; then
  _last_line=$(tail -1 "$_timing_file")
  _event=$(printf '%s' "$_last_line" | jq -r '.event' 2>/dev/null)
  _tool=$(printf '%s' "$_last_line" | jq -r '.tool' 2>/dev/null)
  _assert_eq "C6a: event field set when HOOK_EVENT_NAME is set" "PostToolUse" "$_event"
  _assert_eq "C6a: tool field set when TOOL_NAME is set" "Read" "$_tool"
else
  _fail "C6a: hook-timing.jsonl not found"
fi
rm -rf "$_sandbox"

# C6b: neither set → empty strings (not "null" or missing)
_sandbox=$(mktemp -d)
_sid="test-envvars-none-$(date +%s)"
_inst_dir=$(_make_instance "$_sandbox" "$_sid")

(
  unset _DW_TIMING_TRAP_INSTALLED
  unset INSTANCE_DIR
  unset HOOK_EVENT_NAME
  unset TOOL_NAME
  export CLAUDE_PROJECT_DIR="$_sandbox"
  export CLAUDE_CODE_SESSION_ID="$_sid"
  source "$INSTANCE_LIB"
  discover_instance
  exit 0
) >/dev/null 2>&1

_timing_file="${_inst_dir}/hook-timing.jsonl"
if [[ -f "$_timing_file" ]]; then
  _last_line=$(tail -1 "$_timing_file")
  _event=$(printf '%s' "$_last_line" | jq -r '.event' 2>/dev/null)
  _tool=$(printf '%s' "$_last_line" | jq -r '.tool' 2>/dev/null)
  _assert_eq "C6b: event is empty string when HOOK_EVENT_NAME unset" "" "$_event"
  _assert_eq "C6b: tool is empty string when TOOL_NAME unset" "" "$_tool"
else
  _fail "C6b: hook-timing.jsonl not found"
fi
rm -rf "$_sandbox"

# C6c: only HOOK_EVENT_NAME set, TOOL_NAME unset
_sandbox=$(mktemp -d)
_sid="test-envvars-partial-$(date +%s)"
_inst_dir=$(_make_instance "$_sandbox" "$_sid")

(
  unset _DW_TIMING_TRAP_INSTALLED
  unset INSTANCE_DIR
  unset TOOL_NAME
  export CLAUDE_PROJECT_DIR="$_sandbox"
  export CLAUDE_CODE_SESSION_ID="$_sid"
  export HOOK_EVENT_NAME="Stop"
  source "$INSTANCE_LIB"
  discover_instance
  exit 0
) >/dev/null 2>&1

_timing_file="${_inst_dir}/hook-timing.jsonl"
if [[ -f "$_timing_file" ]]; then
  _last_line=$(tail -1 "$_timing_file")
  _event=$(printf '%s' "$_last_line" | jq -r '.event' 2>/dev/null)
  _tool=$(printf '%s' "$_last_line" | jq -r '.tool' 2>/dev/null)
  _assert_eq "C6c: event set when only HOOK_EVENT_NAME is set" "Stop" "$_event"
  _assert_eq "C6c: tool empty when only HOOK_EVENT_NAME is set" "" "$_tool"
else
  _fail "C6c: hook-timing.jsonl not found"
fi
rm -rf "$_sandbox"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "─────────────────────────────────────"
printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
