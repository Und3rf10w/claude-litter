#!/bin/bash
# instance-lib.sh — Instance discovery for multi-instance deepwork support
#
# Provides discover_instance() which finds the active deepwork instance
# for a given session ID by globbing state files and matching session_id.
#
# Usage: source this file, then call discover_instance <session_id>
#   - session_id is required (no env fallback — v2.1.118 contract)
#   - On success (return 0), sets globals:
#       INSTANCE_ID, INSTANCE_DIR, STATE_FILE, LOG_FILE, HEARTBEAT_FILE, PROJECT_ROOT
#   - On failure (return 1), no globals are set
#
# Also provides discover_instance_by_team_name() for hooks that fire on teammate
# sessions (e.g., TeammateIdle) where only team_name is available, not session_id.
# Handles worktree teammates via git-common-dir fallback.

# Requires jq — caller should verify before sourcing if needed

# ---------------------------------------------------------------------------
# _parse_hook_input — read stdin JSON once, export hook contract vars (v2.1.118)
#
# Exports: INPUT (raw JSON), HOOK_EVENT_NAME, TOOL_NAME, SESSION_ID, TOOL_USE_ID.
# Never falls back to env vars. Missing fields are exported as empty strings.
# Call immediately after sourcing instance-lib.sh, before any other logic.
_parse_hook_input() {
  INPUT=$(cat)
  export INPUT
  HOOK_EVENT_NAME=$(printf '%s' "$INPUT" | jq -r '.hook_event_name // ""' 2>/dev/null || echo "")
  export HOOK_EVENT_NAME
  TOOL_NAME=$(printf '%s' "$INPUT" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
  export TOOL_NAME
  SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
  export SESSION_ID
  TOOL_USE_ID=$(printf '%s' "$INPUT" | jq -r '.tool_use_id // ""' 2>/dev/null || echo "")
  export TOOL_USE_ID
}

# ---------------------------------------------------------------------------
# _load_task_file <team_name> <task_id>
#
# Resolves the task JSON file path and reads it into TASK_FILE_PATH and TASK_JSON.
# Returns 0 on success (TASK_JSON is valid JSON), 1 if file not found or invalid.
_load_task_file() {
  local team_name="$1" task_id="$2"
  [[ -n "$team_name" && -n "$task_id" ]] || return 1
  local sanitized_team task_safe tasks_dir candidate
  sanitized_team=$(printf '%s' "$team_name" | tr '/' '_' | tr ' ' '_')
  task_safe=$(printf '%s' "$task_id" | tr '/' '_')
  tasks_dir="${HOME}/.claude/tasks/${sanitized_team}"
  candidate="${tasks_dir}/${task_safe}.json"
  [[ -f "$candidate" ]] || return 1
  TASK_FILE_PATH="$candidate"
  TASK_JSON=$(jq '.' "$candidate" 2>/dev/null) || return 1
  [[ -n "$TASK_JSON" ]] || return 1
  return 0
}

# ---------------------------------------------------------------------------
# Hook latency instrumentation — installed once per sourcing hook.
#
# _HOOK_START_NS is captured at the top of discover_instance() (the first
# function called by every hook). The EXIT trap computes elapsed_ms and
# appends a JSONL record to ${INSTANCE_DIR}/hook-timing.jsonl.
#
# macOS BSD date supports %N (nanoseconds) since macOS 14. If it prints
# a literal "N" the arithmetic below produces a garbage elapsed_ms; the
# fallback sets _HOOK_START_NS from seconds precision only.
_dw_ns_now() {
  local _t
  _t=$(date +%s%N)
  # If date +%s%N is unsupported, the output ends with literal N
  if [[ "$_t" == *N ]]; then
    # Fall back to second precision; accept ~1 s granularity in elapsed_ms
    _t="$(date +%s)000000000"
  fi
  printf '%s' "$_t"
}

_dw_emit_timing() {
  local _exit=$1
  # No-op when INSTANCE_DIR is unset or empty (hook fired outside active session)
  [[ -n "${INSTANCE_DIR:-}" ]] || return 0
  (
    # Wrap in subshell so any error here cannot affect the hook exit code
    local _end _start _elapsed_ms _blocked _ts _hook _event _tool
    _end=$(_dw_ns_now)
    _start="${_HOOK_START_NS:-$_end}"
    _elapsed_ms=$(( (_end - _start) / 1000000 ))
    (( _elapsed_ms < 0 )) && _elapsed_ms=0
    _blocked="false"
    (( _exit == 2 )) && _blocked="true"
    _ts=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    _hook=$(basename "$0")
    _event="${HOOK_EVENT_NAME:-}"
    _tool="${TOOL_NAME:-}"
    printf '{"hook":"%s","event":"%s","tool":"%s","elapsed_ms":%d,"ts":"%s","blocked":%s}\n' \
      "$_hook" "$_event" "$_tool" "$_elapsed_ms" "$_ts" "$_blocked" \
      >> "${INSTANCE_DIR}/hook-timing.jsonl" 2>/dev/null || true
  ) || true
}

_dw_exit_trap() {
  local _s=$?
  _dw_emit_timing "$_s"
  return $_s
}

# Only install the trap once (guard against double-sourcing)
if [[ "${_DW_TIMING_TRAP_INSTALLED:-0}" != "1" ]]; then
  trap '_dw_exit_trap' EXIT
  _DW_TIMING_TRAP_INSTALLED=1
fi

# Canonicalizes a path: resolves symlinks in dirname, normalizes . and .., works for non-existent files.
# Falls back to original path if dirname doesn't exist (best-effort).
_canonical_path() {
  local p="$1"
  [[ -z "$p" ]] && { printf '%s' ""; return; }
  local dir base
  dir="$(cd "$(dirname "$p")" 2>/dev/null && pwd -P)" || { printf '%s' "$p"; return; }
  base="$(basename "$p")"
  printf '%s/%s' "$dir" "$base"
}

# _write_state_atomic <state-file> <jq-filter> [<jq-arg>...]
#
# Atomically applies a jq filter to the state file using flock + tmp + mv.
# Falls back to plain tmp + mv if flock unavailable (preserves existing semantics).
# Returns 0 on success, non-zero on failure (caller decides whether to fail open).
#
# Example:
#   _write_state_atomic "$STATE_FILE" '.execute.plan_drift_detected = true'
#   _write_state_atomic "$STATE_FILE" --arg id "$ID" '.change_log += [{id: $id}]'
_write_state_atomic() {
  local state_file="$1"; shift
  [[ -f "$state_file" ]] || return 1
  local tmp="${state_file}.tmp.$$"
  local lock="${state_file}.lock"

  if command -v flock >/dev/null 2>&1; then
    (
      flock -x 200 || exit 1
      jq "$@" "$state_file" > "$tmp" 2>/dev/null || exit 2
      [[ -s "$tmp" ]] || exit 3
      mv "$tmp" "$state_file" || exit 4
    ) 200>"$lock"
    local rc=$?
    rm -f "$tmp" 2>/dev/null
    return $rc
  else
    jq "$@" "$state_file" > "$tmp" 2>/dev/null
    if [[ -s "$tmp" ]]; then
      mv "$tmp" "$state_file"
    else
      rm -f "$tmp"
      return 1
    fi
  fi
}

# _verify_event_head_or_block
# Returns 0 (pass) or 2 (block). Writes diagnostic to stderr on mismatch.
# Absent event_head in state.json = pass (pre-W7 instance).
# Missing events.jsonl when event_head present = block.
_verify_event_head_or_block() {
  [[ -n "${STATE_FILE:-}" ]] || return 0  # no state context — fail-open
  [[ -f "$STATE_FILE" ]] || return 0

  local _event_head_stored
  _event_head_stored=$(jq -r '.event_head // ""' "$STATE_FILE" 2>/dev/null || echo "")
  [[ -n "$_event_head_stored" ]] || return 0  # pre-W7 instance: pass

  local _events_jsonl="${INSTANCE_DIR}/events.jsonl"
  if [[ ! -f "$_events_jsonl" ]]; then
    printf 'integrity-gate: STATE_DIVERGENCE — event_head present in state.json but events.jsonl is missing.\n' >&2
    printf 'Run /deepwork-reconcile to rebuild state from events.\n' >&2
    return 2
  fi

  local _last_line _actual_head
  _last_line=$(tail -1 "$_events_jsonl" 2>/dev/null || echo "")
  if [[ -n "$_last_line" ]]; then
    if command -v sha256sum >/dev/null 2>&1; then
      _actual_head=$(printf '%s\n' "$_last_line" | sha256sum | cut -d' ' -f1)
    else
      _actual_head=$(printf '%s\n' "$_last_line" | shasum -a 256 | cut -d' ' -f1)
    fi
    if [[ "$_event_head_stored" != "$_actual_head" ]]; then
      printf 'integrity-gate: EVENT_HEAD_MISMATCH — state.json event_head does not match events.jsonl tail.\n' >&2
      printf 'Run /deepwork-reconcile to rebuild state.json from the event log.\n' >&2
      return 2
    fi
  fi
  return 0
}

discover_instance() {
  # Capture start time on first call; subsequent calls (rare) don't overwrite it
  [[ -n "${_HOOK_START_NS:-}" ]] || _HOOK_START_NS=$(_dw_ns_now)

  local hook_session="${1:-}"
  [[ -n "$hook_session" ]] || return 1
  local _f _sid _id _dir _project_root

  # Resolve project root — CLAUDE_PROJECT_DIR is the canonical source (set by Claude Code
  # for all hook types). Fall back to pwd -P for non-hook contexts (e.g., test harness).
  _project_root="${CLAUDE_PROJECT_DIR:-$(pwd -P)}"

  for _f in "${_project_root}/.claude/deepwork"/*/state.json; do
    # Guard: glob returned literal pattern (no matches)
    [[ -f "$_f" ]] || continue

    # Symlink guard — reject symlinked state files
    [[ -L "$_f" ]] && continue

    # Symlink guard — reject symlinked instance directories
    _dir="$(dirname "$_f")"
    [[ -L "$_dir" ]] && continue

    _sid=$(jq -r '.session_id // ""' "$_f" 2>/dev/null) || continue

    # Backfill placeholder session IDs (generated when CLAUDE_CODE_SESSION_ID
    # was unavailable at setup time — prefix "deepwork-")
    if [[ "$_sid" == deepwork-* ]] && [[ -n "$hook_session" ]]; then
      _write_state_atomic "$_f" --arg sid "$hook_session" '.session_id = $sid' || continue
      _sid="$hook_session"
    fi

    [[ "$_sid" == "$hook_session" ]] || continue

    _id="$(basename "$_dir")"
    # Validate instance ID is exactly 8 hex chars (prevents path traversal)
    [[ "$_id" =~ ^[0-9a-f]{8}$ ]] || continue

    INSTANCE_ID="$_id"
    INSTANCE_DIR="$(_canonical_path "$_dir")"
    STATE_FILE="${INSTANCE_DIR}/state.json"
    LOG_FILE="${INSTANCE_DIR}/log.md"
    HEARTBEAT_FILE="${INSTANCE_DIR}/heartbeat.json"
    PROJECT_ROOT="$_project_root"
    return 0
  done

  return 1
}

# discover_instance_by_team_name — find instance by team_name (for teammate-session hooks)
discover_instance_by_team_name() {
  local team_name="${1:-}"
  [[ -n "$team_name" ]] || return 1
  local _f _tname _id _dir _project_root="" _candidate

  _candidate="${CLAUDE_PROJECT_DIR:-$(pwd -P)}"
  if [[ -d "${_candidate}/.claude/deepwork" ]]; then
    _project_root="$_candidate"
  else
    _candidate=$(git -C "${CLAUDE_PROJECT_DIR:-$(pwd -P)}" rev-parse --show-toplevel 2>/dev/null || echo "")
    if [[ -n "$_candidate" ]] && [[ -d "${_candidate}/.claude/deepwork" ]]; then
      _project_root="$_candidate"
    else
      local _git_common
      _git_common=$(git -C "${CLAUDE_PROJECT_DIR:-$(pwd -P)}" rev-parse --path-format=absolute --git-common-dir 2>/dev/null \
        || git -C "${CLAUDE_PROJECT_DIR:-$(pwd -P)}" rev-parse --git-common-dir 2>/dev/null \
        || echo "")
      if [[ -n "$_git_common" ]]; then
        if [[ "$_git_common" != /* ]]; then
          _git_common=$(cd "${CLAUDE_PROJECT_DIR:-$(pwd -P)}" && cd "$_git_common" 2>/dev/null && pwd) || _git_common=""
        fi
        if [[ -n "$_git_common" ]]; then
          _candidate="$(dirname "$_git_common")"
          [[ "$_candidate" == /* ]] && [[ -d "${_candidate}/.claude/deepwork" ]] && _project_root="$_candidate"
        fi
      fi
    fi
  fi
  [[ -n "$_project_root" ]] || return 1

  for _f in "${_project_root}/.claude/deepwork"/*/state.json; do
    [[ -f "$_f" ]] || continue
    [[ -L "$_f" ]] && continue

    _dir="$(dirname "$_f")"
    [[ -L "$_dir" ]] && continue

    _id="$(basename "$_dir")"
    [[ "$_id" =~ ^[0-9a-f]{8}$ ]] || continue

    _tname=$(jq -r '.team_name // ""' "$_f" 2>/dev/null) || continue
    [[ "$_tname" == "$team_name" ]] || continue

    INSTANCE_ID="$_id"
    INSTANCE_DIR="$(_canonical_path "$_dir")"
    STATE_FILE="${INSTANCE_DIR}/state.json"
    LOG_FILE="${INSTANCE_DIR}/log.md"
    HEARTBEAT_FILE="${INSTANCE_DIR}/heartbeat.json"
    PROJECT_ROOT="$_project_root"
    return 0
  done

  return 1
}
