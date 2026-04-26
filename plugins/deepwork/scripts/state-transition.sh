#!/bin/bash
# state-transition.sh — Canonical single writer for state.json (W6).
#
# Every mutation of state.json MUST go through this script. Hooks and
# orchestrators call a subcommand here instead of _write_state_atomic
# or raw jq+tmp+mv directly.
#
# Usage: state-transition.sh [--state-file <path>] <subcommand> [args...]
#
# Subcommands:
#   init [--json-file <path|-]         Write initial state JSON (test fixtures / setup only).
#                                       Only callable when state.json absent or instance_id empty.
#   phase_advance --to <phase> [--dry-run]
#                                       Advance .phase; runs gate checks (Checklists A,C,D).
#                                       --dry-run runs checks but does NOT write.
#   exec_phase_advance --to <phase>    Advance .execute.phase (no gate checks).
#   set_field <jq-path> <json-value>   Set a single field; logs to .hook_warnings[].
#   append_array <jq-path> <json-obj>  Append an object to an array field.
#   merge <json-fragment>              Merge a JSON object into the root state.
#   halt_reason --summary <text>
#               [--blocker <text>]...  Write .halt_reason = {summary, blockers:[...]}.
#   backfill_session --session-id <id> Set .session_id (one-shot backfill of placeholder IDs).
#   flaky_test_append --cmd <cmd>      Append to .execute.flaky_tests if not already present.
#   stamp_last_updated                 Set .last_updated = now.
#
# Exit codes (§2.2 of single-writer-state-design.md):
#   0   success; state.json updated atomically
#   1   precondition failure (file not found, not valid JSON, init guard fired)
#   2   gate violation (phase_advance blocked; reason on stderr)
#   3   invalid subcommand or missing required args
#   4   write failure (jq error or mv failed)
#
# Environment:
#   STATE_FILE              Path to state.json (set by discover_instance or setup-deepwork.sh)
#   _DW_STATE_TRANSITION_WRITER=1  Set by this script before any write (sentinel for gate)
#
# The sentinel is exported so that any subprocess inherits it. frontmatter-gate.sh
# checks for its absence to block direct Write|Edit to state.json.

set +e

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

# ---------------------------------------------------------------------------
# Arg parsing — strip --state-file override before subcommand dispatch
# ---------------------------------------------------------------------------

_STATE_FILE_OVERRIDE=""
_ARGS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --state-file)
      _STATE_FILE_OVERRIDE="$2"
      shift 2
      ;;
    *)
      _ARGS+=("$1")
      shift
      ;;
  esac
done

set -- "${_ARGS[@]}"

SUBCOMMAND="${1:-}"
[[ -n "$SUBCOMMAND" ]] || { printf 'state-transition.sh: missing subcommand\n' >&2; exit 3; }
shift

# Resolve STATE_FILE
if [[ -n "$_STATE_FILE_OVERRIDE" ]]; then
  STATE_FILE="$_STATE_FILE_OVERRIDE"
fi

# ---------------------------------------------------------------------------
# Event log helpers (W7)
# ---------------------------------------------------------------------------

# _compute_event_hash <line>
# Returns SHA256 hex of "<line>\n" — same bytes written to events.jsonl.
_compute_event_hash() {
  local line="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s\n' "$line" | sha256sum | cut -d' ' -f1
  else
    printf '%s\n' "$line" | shasum -a 256 | cut -d' ' -f1
  fi
}

# _read_event_head
# Returns SHA256 of the last line of events.jsonl, or "GENESIS" if missing/empty.
_read_event_head() {
  local events_file="${INSTANCE_DIR}/events.jsonl"
  local last_line
  last_line=$(tail -1 "$events_file" 2>/dev/null || echo "")
  if [[ -z "$last_line" ]]; then
    printf 'GENESIS'
    return
  fi
  _compute_event_hash "$last_line"
}

# _append_event_raw <events_file> <event_json>
# Appends event_json + newline to events_file. Uses >> for short events
# (POSIX O_APPEND atomic for writes < PIPE_BUF). For payloads >= 512 bytes,
# falls back to tmp+cat+rm to avoid torn writes (not atomic under concurrency,
# but bootstrap events are never concurrent).
_append_event_raw() {
  local events_file="$1"
  local event_json="$2"
  local byte_count=${#event_json}
  if [[ $byte_count -lt 512 ]]; then
    printf '%s\n' "$event_json" >> "$events_file"
  else
    local tmp="${events_file}.tmp.$$"
    printf '%s\n' "$event_json" > "$tmp" && cat "$tmp" >> "$events_file" && rm -f "$tmp"
  fi
}

# _emit_event <event_type> <payload_json>
# Builds and appends a full event envelope to ${INSTANCE_DIR}/events.jsonl.
# Ordering: events.jsonl write happens BEFORE state.json write (Q1: Option A).
# If state.json write later fails, reducer self-heals on next invocation.
#
# The entire read-prev_hash-through-append block is held under an exclusive
# flock on events.jsonl.lock to prevent concurrent processes from reading the
# same prev_event_hash and producing sibling events (hash chain race, W8 H1).
_emit_event() {
  local event_type="$1"
  local payload_json="$2"
  local events_file="${INSTANCE_DIR}/events.jsonl"
  local lock_file="${INSTANCE_DIR}/events.jsonl.lock"

  # Generate event_id before acquiring the lock (no shared state involved).
  local event_id
  if command -v uuidgen >/dev/null 2>&1; then
    event_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
  elif [[ -r /proc/sys/kernel/random/uuid ]]; then
    event_id=$(cat /proc/sys/kernel/random/uuid)
  else
    event_id="$(date +%s)-$$-$(printf '%04d' $((RANDOM % 10000)))"
  fi

  local actor="${_DW_CALLER:-$(basename "$0")}"

  # Hold an exclusive lock from _read_event_head through _append_event_raw so
  # no two concurrent callers can read the same prev_event_hash.
  if command -v flock >/dev/null 2>&1; then
    (
      flock -x 200 || exit 1

      local prev_hash
      prev_hash=$(_read_event_head)

      local timestamp
      timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

      local event_json
      event_json=$(jq -cn \
        --arg eid "$event_id" \
        --arg etype "$event_type" \
        --arg phash "$prev_hash" \
        --arg ts "$timestamp" \
        --arg actor "$actor" \
        --argjson payload "$payload_json" \
        '{event_id: $eid, event_type: $etype, prev_event_hash: $phash,
          timestamp: $ts, actor: $actor, payload: $payload}') || exit 1

      _append_event_raw "$events_file" "$event_json"
    ) 200>"$lock_file"
  else
    # macOS: flock unavailable — use POSIX-atomic mkdir for mutual exclusion.
    local _lock_dir="${lock_file}.dir"
    local _deadline=$(( $(date +%s) + 5 ))
    until mkdir "$_lock_dir" 2>/dev/null; do
      [[ $(date +%s) -lt $_deadline ]] || return 1
      sleep 0.1
    done
    trap 'rm -rf "$_lock_dir"' EXIT

    local prev_hash
    prev_hash=$(_read_event_head)

    local timestamp
    timestamp=$(date -u '+%Y-%m-%dT%H:%M:%SZ')

    local event_json
    event_json=$(jq -cn \
      --arg eid "$event_id" \
      --arg etype "$event_type" \
      --arg phash "$prev_hash" \
      --arg ts "$timestamp" \
      --arg actor "$actor" \
      --argjson payload "$payload_json" \
      '{event_id: $eid, event_type: $etype, prev_event_hash: $phash,
        timestamp: $ts, actor: $actor, payload: $payload}') || { rm -rf "$_lock_dir"; return 1; }

    _append_event_raw "$events_file" "$event_json"
    local _rc=$?
    rm -rf "$_lock_dir"
    return $_rc
  fi
}

# _ensure_event_log
# Seeds events.jsonl with a bootstrap event from the current state.json if
# events.jsonl is absent. Called at the top of each subcommand (after
# _require_state_file, before _verify_integrity_hash) to handle in-flight
# sessions that predate W7.
_ensure_event_log() {
  local events_file="${INSTANCE_DIR}/events.jsonl"
  [[ -f "$events_file" ]] && return 0
  local state_snap
  state_snap=$(cat "$STATE_FILE" 2>/dev/null) || return 1
  local now event_id boot_event
  now=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
  if command -v uuidgen >/dev/null 2>&1; then
    event_id=$(uuidgen | tr '[:upper:]' '[:lower:]')
  elif [[ -r /proc/sys/kernel/random/uuid ]]; then
    event_id=$(cat /proc/sys/kernel/random/uuid)
  else
    event_id="$(date +%s)-$$-bootstrap"
  fi
  boot_event=$(jq -cn \
    --arg eid "$event_id" \
    --arg ts "$now" \
    --arg actor "${_DW_CALLER:-state-transition.sh}" \
    --argjson snap "$state_snap" \
    '{event_id: $eid, event_type: "bootstrap", prev_event_hash: "GENESIS",
      timestamp: $ts, actor: $actor, payload: {state_snapshot: $snap}}') || return 1
  _append_event_raw "$events_file" "$boot_event"
}

# ---------------------------------------------------------------------------
# Integrity hash helpers
# ---------------------------------------------------------------------------

_compute_integrity_hash() {
  local sf="$1"
  local proj hash sot_digest
  # Structural digest of source_of_truth: sort array by value, hash as JSON.
  # Null/missing field hashes to the empty-array digest for pre-W9 compat.
  sot_digest=$(jq -r '(.source_of_truth // []) | sort | tojson' "$sf" 2>/dev/null \
    | { if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; \
        else shasum -a 256 | cut -d' ' -f1; fi }) || sot_digest=""
  proj=$(jq -c --arg sot_digest "$sot_digest" '{
    phase,
    team_name,
    instance_id,
    frontmatter_schema_version,
    started_at,
    source_of_truth_digest: $sot_digest,
    bar: ([.bar[]? | {id, verdict}] | sort_by(.id)),
    execute_plan_drift_detected: .execute.plan_drift_detected,
    execute_plan_hash: .execute.plan_hash
  }' "$sf" 2>/dev/null) || return 1
  if command -v sha256sum >/dev/null 2>&1; then
    hash=$(printf '%s' "$proj" | sha256sum 2>/dev/null | cut -d' ' -f1)
  elif command -v shasum >/dev/null 2>&1; then
    hash=$(printf '%s' "$proj" | shasum -a 256 2>/dev/null | cut -d' ' -f1)
  else
    return 1
  fi
  [[ -n "$hash" ]] || return 1
  printf '%s' "$hash"
}

# Validate on-disk hash against recomputed value.
# Returns 0 (pass) or 2 (mismatch / gate violation).
# Absent hash (pre-W6 instance) is treated as pass.
_verify_integrity_hash() {
  local sf="$1"
  local on_disk recomputed
  on_disk=$(jq -r '.state_integrity_hash // ""' "$sf" 2>/dev/null || echo "")
  [[ -z "$on_disk" ]] && return 0  # pre-W6 instance: pass
  recomputed=$(_compute_integrity_hash "$sf") || return 0  # hash unavailable: fail-open
  if [[ "$on_disk" != "$recomputed" ]]; then
    printf 'INTEGRITY_HASH_MISMATCH: state.json was modified outside state-transition.sh\n' >&2
    printf '  on_disk:    %s\n' "$on_disk" >&2
    printf '  recomputed: %s\n' "$recomputed" >&2
    return 2
  fi
  return 0
}

# Write with hash: applies $jq_filter (+ extra _write_state_atomic args) then
# immediately recomputes and writes the integrity hash + event_head in one atomic update.
_write_with_hash() {
  local sf="$1"; shift
  # First pass: apply the mutation filter
  _write_state_atomic "$sf" "$@" || return 4
  # Second pass: recompute integrity hash and event_head atomically
  local new_hash event_head
  new_hash=$(_compute_integrity_hash "$sf") || new_hash=""
  event_head=$(_read_event_head 2>/dev/null || echo "")
  if [[ -n "$new_hash" ]] && [[ -n "$event_head" ]]; then
    _write_state_atomic "$sf" --arg h "$new_hash" --arg eh "$event_head" \
      '.state_integrity_hash = $h | .event_head = $eh' || return 4
  elif [[ -n "$new_hash" ]]; then
    _write_state_atomic "$sf" --arg h "$new_hash" '.state_integrity_hash = $h' || return 4
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Phase-advance gate logic (shared by phase_advance subcommand and --dry-run)
# Extracted from phase-advance-gate.sh so both paths are single-source.
# Returns: 0 = pass, 2 = blocked (reason already printed to stderr)
# ---------------------------------------------------------------------------

_run_phase_advance_gate() {
  local sf="$1"
  local log_file="$2"
  local instance_dir="$3"
  local current_phase="$4"
  local proposed_phase="$5"

  # Only gate forward-progress phases
  case "$proposed_phase" in
    synthesize|critique|deliver|done|refining) ;;
    *) return 0 ;;
  esac

  # Checklist A: empirical_unknowns[*].result populated + artifact exists
  local unk_count
  unk_count=$(jq -r '.empirical_unknowns | length' "$sf" 2>/dev/null || echo "0")
  if [[ "$unk_count" =~ ^[0-9]+$ ]] && [[ "$unk_count" -gt 0 ]]; then
    local i u_id u_result u_artifact
    for i in $(seq 0 $((unk_count - 1))); do
      u_id=$(jq -r ".empirical_unknowns[$i].id // \"\"" "$sf" 2>/dev/null)
      u_result=$(jq -r ".empirical_unknowns[$i].result // \"\"" "$sf" 2>/dev/null)
      u_artifact=$(jq -r ".empirical_unknowns[$i].artifact // \"\"" "$sf" 2>/dev/null)

      if [[ -z "$u_result" || "$u_result" == "null" ]]; then
        printf 'Phase advance blocked: empirical_unknowns[%s].result is null.\n' "$u_id" >&2
        printf 'Write the empirical_results.%s.md artifact, then backfill result before advancing phase.\n' "$u_id" >&2
        printf '  current_phase=%s proposed_phase=%s\n' "$current_phase" "$proposed_phase" >&2
        return 2
      fi

      if [[ -n "$u_artifact" ]] && [[ "$u_artifact" != "null" ]]; then
        case "$u_artifact" in
          /*|*..*) printf 'Phase advance blocked: empirical_unknowns[%s].artifact path is absolute or contains traversal: %s\n' "$u_id" "$u_artifact" >&2; return 2 ;;
        esac
        if [[ ! -f "${instance_dir}/${u_artifact}" ]]; then
          printf 'Phase advance blocked: empirical_unknowns[%s].artifact missing on disk:\n  %s/%s\n' "$u_id" "$instance_dir" "$u_artifact" >&2
          return 2
        fi
      fi
    done
  fi

  # Checklist C: state.json vs log.md metadata invariants (drift class k)
  if [[ -f "$log_file" ]]; then
    local st_team st_inst log_team log_inst
    st_team=$(jq -r '.team_name // ""' "$sf" 2>/dev/null | tr -d '\n' | tr -d ' ')
    st_inst=$(jq -r '.instance_id // ""' "$sf" 2>/dev/null | tr -d '\n' | tr -d ' ')
    log_team=$(grep -m1 -E '^\*\*Team:\*\*' "$log_file" 2>/dev/null | sed -E 's/^\*\*Team:\*\* *`?([^`]*)`?.*/\1/' | tr -d '\n' | tr -d ' ')
    log_inst=$(grep -m1 -E '^\*\*Instance:\*\*' "$log_file" 2>/dev/null | sed -E 's/^\*\*Instance:\*\* *`?([^`]*)`?.*/\1/' | tr -d '\n' | tr -d ' ')

    if [[ -n "$log_team" ]] && [[ -n "$st_team" ]] && [[ "$st_team" != "$log_team" ]]; then
      printf 'Phase advance blocked (drift class k): state.json and log.md disagree on team_name.\n' >&2
      printf '  state.json: %s\n  log.md:     %s\n' "$st_team" "$log_team" >&2
      printf 'Reconcile before advancing. See proposals/v3-final.md §M1 Checklist C.\n' >&2
      return 2
    fi

    if [[ -n "$log_inst" ]] && [[ -n "$st_inst" ]] && [[ "$st_inst" != "$log_inst" ]]; then
      printf 'Phase advance blocked (drift class k): state.json and log.md disagree on instance_id.\n' >&2
      printf '  state.json: %s\n  log.md:     %s\n' "$st_inst" "$log_inst" >&2
      return 2
    fi
  fi

  # Checklist D: version-sentinel currency (M3 integration)
  if [[ "$proposed_phase" == "critique" ]]; then
    local sentinel cur_ver
    sentinel="${instance_dir}/version-sentinel.json"
    if [[ -f "$sentinel" ]]; then
      cur_ver=$(jq -r '.current_version // ""' "$sentinel" 2>/dev/null)
      if [[ -n "$cur_ver" ]]; then
        if [[ ! -f "${instance_dir}/proposals/${cur_ver}.md" ]] && [[ ! -f "${instance_dir}/proposals/${cur_ver}-final.md" ]]; then
          printf 'Phase advance blocked: version-sentinel.json says current_version=%s but no matching proposal file exists.\n' "$cur_ver" >&2
          printf '  Expected one of:\n    %s/proposals/%s.md\n    %s/proposals/%s-final.md\n' "$instance_dir" "$cur_ver" "$instance_dir" "$cur_ver" >&2
          return 2
        fi
      fi
    fi
  fi

  # Checklist B: source_of_truth[] superset (warn only — never blocks)
  if command -v grep >/dev/null 2>&1; then
    local sot_json missing="" cited path artifact
    sot_json=$(jq -r '.source_of_truth[]? // empty' "$sf" 2>/dev/null)
    for artifact in "${instance_dir}"/findings.*.md "${instance_dir}"/mechanism.*.md "${instance_dir}"/reframe.*.md "${instance_dir}"/coverage.*.md; do
      [[ -f "$artifact" ]] || continue
      cited=$(grep -oE '\]\([^)]+\)' "$artifact" 2>/dev/null | sed -E 's/^\]\((.*)\)$/\1/' | grep -E '(/|\.(md|js|json|sh|py)$)' || true)
      while IFS= read -r path; do
        [[ -z "$path" ]] && continue
        case "$path" in http*|\#*|/*|*#*) continue ;; esac
        if ! printf '%s\n' "$sot_json" | grep -Fqx "$path"; then
          missing="${missing}${path}"$'\n'
        fi
      done <<< "$cited"
    done
    if [[ -n "$missing" ]]; then
      printf 'NOTE: phase-advance-gate source_of_truth warning (non-blocking):\n' >&2
      printf '%s' "$missing" | sort -u | sed 's/^/    /' >&2
    fi
  fi

  return 0
}

# ---------------------------------------------------------------------------
# Validate STATE_FILE (required by all subcommands except init)
# ---------------------------------------------------------------------------

_require_state_file() {
  if [[ -z "${STATE_FILE:-}" ]]; then
    printf 'state-transition.sh: STATE_FILE is not set (use --state-file or discover_instance)\n' >&2
    exit 1
  fi
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'state-transition.sh: STATE_FILE not found: %s\n' "$STATE_FILE" >&2
    exit 1
  fi
  if ! jq empty "$STATE_FILE" 2>/dev/null; then
    printf 'state-transition.sh: STATE_FILE is not valid JSON: %s\n' "$STATE_FILE" >&2
    exit 1
  fi
  # Ensure INSTANCE_DIR is set (may already be set by discover_instance in hook context)
  if [[ -z "${INSTANCE_DIR:-}" ]]; then
    INSTANCE_DIR="$(dirname "$STATE_FILE")"
  fi
}

# ---------------------------------------------------------------------------
# Export sentinel before any write so hooks spawned in the same shell tree
# see the flag.
# ---------------------------------------------------------------------------
export _DW_STATE_TRANSITION_WRITER=1

# ---------------------------------------------------------------------------
# Subcommand dispatch
# ---------------------------------------------------------------------------

case "$SUBCOMMAND" in

  # ---- init ----------------------------------------------------------------
  # Write initial state JSON. Only when state.json absent or instance_id empty.
  # Accepts --json-file <path> (use "-" for stdin) or raw JSON positional arg.
  init)
    JSON_SOURCE=""
    JSON_INLINE=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --json-file) JSON_SOURCE="$2"; shift 2 ;;
        -) JSON_SOURCE="-"; shift ;;
        *) JSON_INLINE="$1"; shift ;;
      esac
    done

    [[ -n "${STATE_FILE:-}" ]] || { printf 'state-transition.sh init: STATE_FILE not set\n' >&2; exit 1; }

    # Guard: only callable when state.json doesn't exist OR has empty instance_id
    if [[ -f "$STATE_FILE" ]]; then
      existing_id=$(jq -r '.instance_id // ""' "$STATE_FILE" 2>/dev/null || echo "")
      if [[ -n "$existing_id" ]]; then
        printf 'state-transition.sh init: state.json already has instance_id=%s — init is for test fixtures only\n' "$existing_id" >&2
        exit 1
      fi
    fi

    local_json=""
    if [[ -n "$JSON_SOURCE" ]]; then
      if [[ "$JSON_SOURCE" == "-" ]]; then
        local_json=$(cat)
      else
        [[ -f "$JSON_SOURCE" ]] || { printf 'state-transition.sh init: --json-file not found: %s\n' "$JSON_SOURCE" >&2; exit 1; }
        local_json=$(cat "$JSON_SOURCE")
      fi
    elif [[ -n "$JSON_INLINE" ]]; then
      local_json="$JSON_INLINE"
    else
      printf 'state-transition.sh init: provide --json-file <path|-> or inline JSON\n' >&2
      exit 3
    fi

    # Validate JSON
    printf '%s' "$local_json" | jq empty 2>/dev/null || { printf 'state-transition.sh init: invalid JSON provided\n' >&2; exit 1; }

    # Write without hash (pre-hash state — test fixtures don't carry a hash)
    _init_tmp="${STATE_FILE}.tmp.$$"
    printf '%s\n' "$local_json" > "$_init_tmp" && mv "$_init_tmp" "$STATE_FILE" || { rm -f "$_init_tmp"; exit 4; }
    exit 0
    ;;

  # ---- phase_advance -------------------------------------------------------
  phase_advance)
    DRY_RUN=0
    TO_PHASE=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --to) TO_PHASE="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        *) shift ;;
      esac
    done

    [[ -n "$TO_PHASE" ]] || { printf 'state-transition.sh phase_advance: --to <phase> required\n' >&2; exit 3; }
    _require_state_file

    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?
    [[ $hash_rc -eq 0 ]] || exit $hash_rc

    current_phase=$(jq -r '.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
    instance_dir=$(dirname "$STATE_FILE")
    log_file="${instance_dir}/log.md"

    _run_phase_advance_gate "$STATE_FILE" "$log_file" "$instance_dir" "$current_phase" "$TO_PHASE"
    gate_rc=$?
    [[ $gate_rc -eq 0 ]] || exit $gate_rc

    [[ $DRY_RUN -eq 1 ]] && exit 0

    _ensure_event_log
    _emit_event "phase_advanced" \
      "$(jq -cn --arg fp "$current_phase" --arg tp "$TO_PHASE" '{from_phase: $fp, to_phase: $tp}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" --arg phase "$TO_PHASE" '.phase = $phase'
    rc=$?
    [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- exec_phase_advance --------------------------------------------------
  exec_phase_advance)
    TO_PHASE=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --to) TO_PHASE="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    [[ -n "$TO_PHASE" ]] || { printf 'state-transition.sh exec_phase_advance: --to <phase> required\n' >&2; exit 3; }
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc

    _current_exec_phase=$(jq -r '.execute.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
    _ensure_event_log
    _emit_event "exec_phase_advanced" \
      "$(jq -cn --arg fp "$_current_exec_phase" --arg tp "$TO_PHASE" '{from_phase: $fp, to_phase: $tp}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" --arg phase "$TO_PHASE" '.execute.phase = $phase'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- set_field -----------------------------------------------------------
  # set_field <jq-path> <json-value>
  # Logs every invocation to .hook_warnings[] for audit visibility (§8 Q3).
  set_field)
    JQ_PATH="${1:-}"
    JSON_VALUE="${2:-}"
    [[ -n "$JQ_PATH" ]] || { printf 'state-transition.sh set_field: <jq-path> required\n' >&2; exit 3; }
    [[ -n "$JSON_VALUE" ]] || { printf 'state-transition.sh set_field: <json-value> required\n' >&2; exit 3; }
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc

    NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    _ensure_event_log
    _emit_event "field_set" \
      "$(jq -cn --arg p "$JQ_PATH" --argjson v "$JSON_VALUE" '{jq_path: $p, json_value: $v}')" \
      || exit 5
    # Apply field set + audit log + hash atomically (hook_warnings kept per §9.6 Option B)
    _write_with_hash "$STATE_FILE" \
      --arg path "$JQ_PATH" \
      --argjson val "$JSON_VALUE" \
      --arg ts "$NOW" \
      --arg caller "${_DW_CALLER:-${0}}" \
      '('"$JQ_PATH"' = $val) |
       .hook_warnings += [{event: "set_field", timestamp: $ts, path: $path, caller: $caller}]'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- append_array --------------------------------------------------------
  # append_array <jq-path> <json-object>
  append_array)
    JQ_PATH="${1:-}"
    JSON_OBJ="${2:-}"
    [[ -n "$JQ_PATH" ]] || { printf 'state-transition.sh append_array: <jq-path> required\n' >&2; exit 3; }
    [[ -n "$JSON_OBJ" ]] || { printf 'state-transition.sh append_array: <json-object> required\n' >&2; exit 3; }
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc

    _ensure_event_log
    _emit_event "array_appended" \
      "$(jq -cn --arg p "$JQ_PATH" --argjson o "$JSON_OBJ" '{jq_path: $p, json_object: $o}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" \
      --argjson obj "$JSON_OBJ" \
      '('"$JQ_PATH"') += [$obj]'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- merge ---------------------------------------------------------------
  # merge <json-fragment>  — deep-merges fragment into root state
  merge)
    JSON_FRAG="${1:-}"
    [[ -n "$JSON_FRAG" ]] || { printf 'state-transition.sh merge: <json-fragment> required\n' >&2; exit 3; }
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc

    _ensure_event_log
    _emit_event "merged" \
      "$(jq -cn --argjson f "$JSON_FRAG" '{json_fragment: $f}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" \
      --argjson frag "$JSON_FRAG" \
      '. * $frag'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- halt_reason ---------------------------------------------------------
  # halt_reason --summary <text> [--blocker <text>]...
  halt_reason)
    SUMMARY=""
    BLOCKERS=()
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --summary) SUMMARY="$2"; shift 2 ;;
        --blocker) BLOCKERS+=("$2"); shift 2 ;;
        *) shift ;;
      esac
    done

    [[ -n "$SUMMARY" ]] || { printf 'state-transition.sh halt_reason: --summary <text> required\n' >&2; exit 3; }
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc

    # Build blockers JSON array
    BLOCKERS_JSON="[]"
    if [[ ${#BLOCKERS[@]} -gt 0 ]]; then
      BLOCKERS_JSON=$(printf '%s\n' "${BLOCKERS[@]}" | jq -Rs '[split("\n")[] | select(. != "")]')
    fi

    NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    _ensure_event_log
    _emit_event "halt_recorded" \
      "$(jq -cn --arg s "$SUMMARY" --argjson b "$BLOCKERS_JSON" '{summary: $s, blockers: $b}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" \
      --arg summary "$SUMMARY" \
      --argjson blockers "$BLOCKERS_JSON" \
      --arg ts "$NOW" \
      '.halt_reason = {summary: $summary, blockers: $blockers, recorded_at: $ts}'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- backfill_session ----------------------------------------------------
  # backfill_session --session-id <id>
  # One-shot backfill of placeholder "deepwork-*" session IDs.
  backfill_session)
    SESSION_ID_ARG=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --session-id) SESSION_ID_ARG="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    [[ -n "$SESSION_ID_ARG" ]] || { printf 'state-transition.sh backfill_session: --session-id <id> required\n' >&2; exit 3; }
    _require_state_file

    current_sid=$(jq -r '.session_id // ""' "$STATE_FILE" 2>/dev/null || echo "")
    # Only backfill if current session_id is a placeholder (deepwork-* prefix)
    if [[ "$current_sid" != deepwork-* ]]; then
      exit 0
    fi

    _ensure_event_log
    _emit_event "session_backfilled" \
      "$(jq -cn --arg sid "$SESSION_ID_ARG" '{session_id: $sid}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" \
      --arg sid "$SESSION_ID_ARG" \
      '.session_id = $sid'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- flaky_test_append ---------------------------------------------------
  # flaky_test_append --cmd <cmd>
  # Appends to .execute.flaky_tests only if not already present.
  flaky_test_append)
    CMD_ARG=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --cmd) CMD_ARG="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    [[ -n "$CMD_ARG" ]] || { printf 'state-transition.sh flaky_test_append: --cmd <cmd> required\n' >&2; exit 3; }
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc

    # Check if already present
    already=$(jq -r --arg cmd "$CMD_ARG" '(.execute.flaky_tests // []) | map(select(. == $cmd)) | length' "$STATE_FILE" 2>/dev/null || echo "0")
    [[ "$already" -gt 0 ]] && exit 0

    _ensure_event_log
    _emit_event "flaky_test_added" \
      "$(jq -cn --arg cmd "$CMD_ARG" '{command: $cmd}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" \
      --arg cmd "$CMD_ARG" \
      '.execute.flaky_tests = ((.execute.flaky_tests // []) + [$cmd])'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- stamp_last_updated --------------------------------------------------
  stamp_last_updated)
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc

    NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    _ensure_event_log
    _emit_event "last_updated_stamped" '{}' \
      || exit 5
    _write_with_hash "$STATE_FILE" \
      --arg now "$NOW" \
      '.last_updated = $now'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- replay ---------------------------------------------------------------
  # replay [--from-genesis] [--output <path>]
  # Reads events.jsonl, replays all events into a state object, writes state.json.
  # Verifies hash chain integrity during replay; exits non-zero on mismatch.
  # Used by /deepwork-reconcile and for self-healing after partial writes.
  #
  # TODO(W8): automatic snapshot generation every 500 events to bound replay cost.
  replay)
    # Lighter pre-check: STATE_FILE path must be set and events.jsonl must exist.
    # We do NOT require state.json to exist or be valid — replay rebuilds it from
    # events.jsonl even when state.json is missing or corrupt (the /deepwork-reconcile
    # use-case). INSTANCE_DIR is derived from STATE_FILE when not already set.
    if [[ -z "${STATE_FILE:-}" ]]; then
      printf 'state-transition.sh replay: STATE_FILE is not set (use --state-file or discover_instance)\n' >&2
      exit 1
    fi
    if [[ -z "${INSTANCE_DIR:-}" ]]; then
      INSTANCE_DIR="$(dirname "$STATE_FILE")"
    fi
    REPLAY_OUTPUT="$STATE_FILE"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --from-genesis) shift ;;  # default behaviour; accepted for explicitness
        --output) REPLAY_OUTPUT="$2"; shift 2 ;;
        *) shift ;;
      esac
    done

    _events_file="${INSTANCE_DIR}/events.jsonl"
    if [[ ! -f "$_events_file" ]]; then
      printf 'state-transition.sh replay: events.jsonl not found: %s\n' "$_events_file" >&2
      exit 1
    fi

    # --- replay engine (jq/bash) ---
    # Uses jq for all state mutations — handles nested paths and recursive merge
    # correctly. O(N) subshell spawns for sha256sum; acceptable for typical event
    # log sizes (< 1000 events). Python fast-path removed (W15 #10) because it
    # silently skipped nested field_set and array_appended paths.
    # Outputs final state JSON to REPLAY_OUTPUT.

    # _validate_jq_path <path> <event_line_number>
    # Allowlist: paths must match ^\.[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*|\[[0-9]+\])*$
    # Returns 0 when valid; exits the replay subcommand non-zero with INVALID_JQ_PATH on violation.
    _validate_jq_path() {
      local _path="$1"
      local _lineno="${2:-?}"
      if printf '%s' "$_path" | grep -qE '^\.[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*|\[[0-9]+\])*$'; then
        return 0
      fi
      printf 'state-transition.sh replay: INVALID_JQ_PATH at event %s — "%s" does not match allowlist\n' \
        "$_lineno" "$_path" >&2
      exit 1
    }

    _prev_line=""
    _event_count=0
    _working_state="{}"
    _last_event_hash=""

    while IFS= read -r _line; do
      [[ -z "$_line" ]] && continue
      _event_count=$((_event_count + 1))

      # Verify hash chain
      if [[ $_event_count -eq 1 ]]; then
        _expected_prev="GENESIS"
      else
        _expected_prev=$(_compute_event_hash "$_prev_line")
      fi

      _actual_prev=$(printf '%s' "$_line" | jq -r '.prev_event_hash // ""' 2>/dev/null || echo "")
      if [[ "$_actual_prev" != "$_expected_prev" ]]; then
        printf 'state-transition.sh replay: HASH_CHAIN_BROKEN at event %d\n' "$_event_count" >&2
        printf '  expected prev_event_hash: %s\n' "$_expected_prev" >&2
        printf '  actual   prev_event_hash: %s\n' "$_actual_prev" >&2
        printf '  event_id: %s\n' "$(printf '%s' "$_line" | jq -r '.event_id // "?"' 2>/dev/null)" >&2
        exit 1
      fi

      # Validate JSON
      if ! printf '%s' "$_line" | jq empty 2>/dev/null; then
        printf 'state-transition.sh replay: invalid JSON at line %d\n' "$_event_count" >&2
        exit 1
      fi

      _etype=$(printf '%s' "$_line" | jq -r '.event_type // ""' 2>/dev/null)
      _ts=$(printf '%s' "$_line" | jq -r '.timestamp // ""' 2>/dev/null)

      # Apply reduction rules (§4.3)
      case "$_etype" in
        bootstrap|state_snapshot)
          # state_snapshot at non-genesis position: start fresh from snapshot payload.
          # bootstrap: payload.state_snapshot is the full state.
          _working_state=$(printf '%s' "$_line" | jq -c '.payload.state_snapshot' 2>/dev/null) || {
            printf 'state-transition.sh replay: failed to extract state_snapshot at event %d\n' "$_event_count" >&2
            exit 1
          }
          ;;
        phase_advanced)
          _to=$(printf '%s' "$_line" | jq -r '.payload.to_phase // ""' 2>/dev/null)
          _working_state=$(printf '%s' "$_working_state" | jq -c --arg v "$_to" '.phase = $v' 2>/dev/null)
          ;;
        exec_phase_advanced)
          _to=$(printf '%s' "$_line" | jq -r '.payload.to_phase // ""' 2>/dev/null)
          _working_state=$(printf '%s' "$_working_state" | jq -c --arg v "$_to" '.execute.phase = $v' 2>/dev/null)
          ;;
        field_set)
          _jq_path=$(printf '%s' "$_line" | jq -r '.payload.jq_path // ""' 2>/dev/null)
          _validate_jq_path "$_jq_path" "$_event_count"
          _json_val=$(printf '%s' "$_line" | jq -c '.payload.json_value' 2>/dev/null)
          _working_state=$(printf '%s' "$_working_state" | \
            jq -c --argjson val "$_json_val" "${_jq_path} = \$val" 2>/dev/null)
          ;;
        array_appended)
          _jq_path=$(printf '%s' "$_line" | jq -r '.payload.jq_path // ""' 2>/dev/null)
          _validate_jq_path "$_jq_path" "$_event_count"
          _json_obj=$(printf '%s' "$_line" | jq -c '.payload.json_object' 2>/dev/null)
          _working_state=$(printf '%s' "$_working_state" | \
            jq -c --argjson obj "$_json_obj" "(${_jq_path}) += [\$obj]" 2>/dev/null)
          ;;
        merged)
          _frag=$(printf '%s' "$_line" | jq -c '.payload.json_fragment' 2>/dev/null)
          _working_state=$(printf '%s' "$_working_state" | \
            jq -c --argjson frag "$_frag" '. * $frag' 2>/dev/null)
          ;;
        state_reverted)
          _working_state=$(printf '%s' "$_line" | jq -c '.payload.state_snapshot' 2>/dev/null) || {
            printf 'state-transition.sh replay: failed to extract state_snapshot from state_reverted at event %d\n' "$_event_count" >&2
            exit 1
          }
          ;;
        halt_recorded)
          _summary=$(printf '%s' "$_line" | jq -r '.payload.summary // ""' 2>/dev/null)
          _blockers=$(printf '%s' "$_line" | jq -c '.payload.blockers // []' 2>/dev/null)
          _working_state=$(printf '%s' "$_working_state" | \
            jq -c --arg s "$_summary" --argjson b "$_blockers" --arg ts "$_ts" \
            '.halt_reason = {summary: $s, blockers: $b, recorded_at: $ts}' 2>/dev/null)
          ;;
        session_backfilled)
          _sid=$(printf '%s' "$_line" | jq -r '.payload.session_id // ""' 2>/dev/null)
          _working_state=$(printf '%s' "$_working_state" | \
            jq -c --arg v "$_sid" '.session_id = $v' 2>/dev/null)
          ;;
        flaky_test_added)
          _cmd=$(printf '%s' "$_line" | jq -r '.payload.command // ""' 2>/dev/null)
          _working_state=$(printf '%s' "$_working_state" | \
            jq -c --arg cmd "$_cmd" \
            'if (.execute.flaky_tests // []) | map(select(. == $cmd)) | length > 0
             then . else .execute.flaky_tests = ((.execute.flaky_tests // []) + [$cmd]) end' \
            2>/dev/null)
          ;;
        last_updated_stamped)
          _working_state=$(printf '%s' "$_working_state" | \
            jq -c --arg ts "$_ts" '.last_updated = $ts' 2>/dev/null)
          ;;
        *)
          printf 'state-transition.sh replay: unknown event type "%s" at event %d — skipping\n' \
            "$_etype" "$_event_count" >&2
          ;;
      esac

      _prev_line="$_line"
    done < "$_events_file"

    if [[ $_event_count -eq 0 ]]; then
      printf 'state-transition.sh replay: events.jsonl is empty\n' >&2
      exit 1
    fi

    # Compute event_head from the last line
    _last_event_hash=$(_compute_event_hash "$_prev_line")

    # Write reduced state with integrity hash + event_head
    _replay_tmp="${REPLAY_OUTPUT}.tmp.$$"
    printf '%s\n' "$_working_state" > "$_replay_tmp" || { rm -f "$_replay_tmp"; exit 4; }
    [[ -s "$_replay_tmp" ]] || { rm -f "$_replay_tmp"; exit 4; }
    mv "$_replay_tmp" "$REPLAY_OUTPUT" || exit 4

    # Recompute integrity hash on the written file
    _new_hash=$(_compute_integrity_hash "$REPLAY_OUTPUT") || _new_hash=""
    if [[ -n "$_new_hash" ]]; then
      _write_state_atomic "$REPLAY_OUTPUT" \
        --arg h "$_new_hash" --arg eh "$_last_event_hash" \
        '.state_integrity_hash = $h | .event_head = $eh' || true
    else
      _write_state_atomic "$REPLAY_OUTPUT" \
        --arg eh "$_last_event_hash" \
        '.event_head = $eh' || true
    fi

    printf 'replay: %d events processed, event_head=%s\n' "$_event_count" "$_last_event_hash"
    exit 0
    ;;

  # ---- grant_override -------------------------------------------------------
  # Orchestrator-only: issue a one-time-use override token stored in
  # ${INSTANCE_DIR}/override-tokens.json.  Tokens carry a granted_to field
  # that is enforced by consume_override — tokens are actor-bound.
  #
  # Usage: grant_override --id <token_id> --to <teammate> [--description <text>] [--granted-by <name>]
  grant_override)
    _require_state_file
    _OT_ID=""
    _OT_TO=""
    _OT_DESC=""
    _OT_BY="orchestrator"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) _OT_ID="$2"; shift 2 ;;
        --to) _OT_TO="$2"; shift 2 ;;
        --description) _OT_DESC="$2"; shift 2 ;;
        --granted-by) _OT_BY="$2"; shift 2 ;;
        *) printf 'grant_override: unknown arg: %s\n' "$1" >&2; exit 3 ;;
      esac
    done
    [[ -n "$_OT_ID" ]] || { printf 'grant_override: --id is required\n' >&2; exit 3; }
    [[ -n "$_OT_TO" ]] || { printf 'grant_override: --to <teammate> is required\n' >&2; exit 3; }
    _OT_FILE="${INSTANCE_DIR}/override-tokens.json"
    _OT_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    # Initialise file if absent
    [[ -f "$_OT_FILE" ]] || printf '{"tokens":[]}\n' > "$_OT_FILE"
    # Check for duplicate id
    if jq -e --arg id "$_OT_ID" '.tokens[] | select(.id == $id)' "$_OT_FILE" >/dev/null 2>&1; then
      printf 'grant_override: token id "%s" already exists\n' "$_OT_ID" >&2
      exit 1
    fi
    _OT_TMP="${_OT_FILE}.tmp.$$"
    jq --arg id "$_OT_ID" --arg to "$_OT_TO" --arg ts "$_OT_TS" --arg by "$_OT_BY" --arg desc "$_OT_DESC" \
      '.tokens += [{id: $id, granted_to: $to, granted_at: $ts, granted_by: $by, description: $desc}]' \
      "$_OT_FILE" > "$_OT_TMP" 2>/dev/null \
      && mv "$_OT_TMP" "$_OT_FILE" \
      || { rm -f "$_OT_TMP"; printf 'grant_override: failed to write token\n' >&2; exit 1; }
    printf 'grant_override: token "%s" issued to "%s" at %s\n' "$_OT_ID" "$_OT_TO" "$_OT_TS"
    exit 0
    ;;

  # ---- consume_override -----------------------------------------------------
  # Atomically validate (token exists AND granted_to == actor) and remove a
  # one-time-use token from override-tokens.json.
  # Returns 0 if token found, actor matches, and token consumed.
  # Returns 1 if token not found, already consumed, or actor mismatch.
  # Called by wave-gate.sh to validate override_token_id in task metadata.
  #
  # Usage: consume_override --id <token_id> --actor <teammate>
  consume_override)
    _require_state_file
    _CO_ID=""
    _CO_ACTOR=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) _CO_ID="$2"; shift 2 ;;
        --actor) _CO_ACTOR="$2"; shift 2 ;;
        *) printf 'consume_override: unknown arg: %s\n' "$1" >&2; exit 3 ;;
      esac
    done
    [[ -n "$_CO_ID" ]] || { printf 'consume_override: --id is required\n' >&2; exit 3; }
    [[ -n "$_CO_ACTOR" ]] || { printf 'consume_override: --actor is required\n' >&2; exit 3; }
    _OT_FILE="${INSTANCE_DIR}/override-tokens.json"
    [[ -f "$_OT_FILE" ]] || { printf 'consume_override: no override-tokens.json\n' >&2; exit 1; }
    # Check token exists
    if ! jq -e --arg id "$_CO_ID" '.tokens[] | select(.id == $id)' "$_OT_FILE" >/dev/null 2>&1; then
      printf 'consume_override: token "%s" not found or already consumed\n' "$_CO_ID" >&2
      exit 1
    fi
    # Enforce actor binding: granted_to must match the requesting actor
    _CO_GRANTED_TO=$(jq -r --arg id "$_CO_ID" '.tokens[] | select(.id == $id) | .granted_to // ""' "$_OT_FILE" 2>/dev/null || echo "")
    if [[ "$_CO_GRANTED_TO" != "$_CO_ACTOR" ]]; then
      printf 'consume_override: token "%s" is granted to "%s", not "%s"\n' "$_CO_ID" "$_CO_GRANTED_TO" "$_CO_ACTOR" >&2
      exit 1
    fi
    _CO_TMP="${_OT_FILE}.tmp.$$"
    jq --arg id "$_CO_ID" '.tokens = [.tokens[] | select(.id != $id)]' \
      "$_OT_FILE" > "$_CO_TMP" 2>/dev/null \
      && mv "$_CO_TMP" "$_OT_FILE" \
      || { rm -f "$_CO_TMP"; printf 'consume_override: failed to remove token\n' >&2; exit 1; }
    printf 'consume_override: token "%s" consumed by "%s"\n' "$_CO_ID" "$_CO_ACTOR"
    exit 0
    ;;

  # ---- emit_revert_event -----------------------------------------------------
  # emit_revert_event --reason <text> --reverted_to_event <event_id>
  # Appends a state_reverted event to events.jsonl. The payload carries the
  # current (post-revert) state as a snapshot so replay can reconstruct it.
  # Called by state-drift-marker.sh after it cp's .state-snapshot over state.json.
  emit_revert_event)
    _RE_REASON=""
    _RE_TO_EVENT=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --reason) _RE_REASON="$2"; shift 2 ;;
        --reverted_to_event) _RE_TO_EVENT="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ -n "$_RE_REASON" ]] || { printf 'emit_revert_event: --reason is required\n' >&2; exit 3; }
    [[ -n "$_RE_TO_EVENT" ]] || { printf 'emit_revert_event: --reverted_to_event is required\n' >&2; exit 3; }
    _require_state_file
    _ensure_event_log
    _REVERT_SNAP=$(cat "$STATE_FILE" 2>/dev/null) || { printf 'emit_revert_event: cannot read STATE_FILE\n' >&2; exit 1; }
    printf '%s' "$_REVERT_SNAP" | jq empty 2>/dev/null || { printf 'emit_revert_event: STATE_FILE is not valid JSON\n' >&2; exit 1; }
    _emit_event "state_reverted" \
      "$(jq -cn --arg reason "$_RE_REASON" --arg rte "$_RE_TO_EVENT" \
          --argjson snap "$_REVERT_SNAP" \
          '{reason: $reason, reverted_to_event: $rte, state_snapshot: $snap}')" \
      || exit 5
    exit 0
    ;;

  # ---- bar_add ---------------------------------------------------------------
  # bar_add --id <id> --statement <text> [--categorical-ban]
  # Appends to .bars[] (or .bar[] for compat), emits bar_added event.
  bar_add)
    _BA_ID=""
    _BA_STMT=""
    _BA_CAT_BAN="false"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) _BA_ID="$2"; shift 2 ;;
        --statement) _BA_STMT="$2"; shift 2 ;;
        --categorical-ban) _BA_CAT_BAN="true"; shift ;;
        *) shift ;;
      esac
    done
    [[ -n "$_BA_ID" ]] || { printf 'bar_add: --id <id> required\n' >&2; exit 3; }
    [[ -n "$_BA_STMT" ]] || { printf 'bar_add: --statement <text> required\n' >&2; exit 3; }
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc
    _ensure_event_log
    _emit_event "bar_added" \
      "$(jq -cn --arg id "$_BA_ID" --arg stmt "$_BA_STMT" --argjson cat "$_BA_CAT_BAN" \
          '{id: $id, statement: $stmt, categorical_ban: $cat}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" \
      --arg id "$_BA_ID" \
      --arg stmt "$_BA_STMT" \
      --argjson cat "$_BA_CAT_BAN" \
      '.bar = ((.bar // []) + [{id: $id, criterion: $stmt, verdict: null, categorical_ban: $cat, evidence_required: "user-specified criterion"}])'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- bar_remove ------------------------------------------------------------
  # bar_remove --id <id>
  # Removes from .bar[], emits bar_removed event.
  bar_remove)
    _BR_ID=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --id) _BR_ID="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ -n "$_BR_ID" ]] || { printf 'bar_remove: --id <id> required\n' >&2; exit 3; }
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc
    _ensure_event_log
    _emit_event "bar_removed" \
      "$(jq -cn --arg id "$_BR_ID" '{id: $id}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" \
      --arg id "$_BR_ID" \
      '.bar = [(.bar // [])[] | select(.id != $id)]'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- guardrail_add ---------------------------------------------------------
  # guardrail_add --statement <text> [--source <src>]
  # Appends to .guardrails[], emits guardrail_added event.
  guardrail_add)
    _GA_STMT=""
    _GA_SRC="user"
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --statement) _GA_STMT="$2"; shift 2 ;;
        --source) _GA_SRC="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ -n "$_GA_STMT" ]] || { printf 'guardrail_add: --statement <text> required\n' >&2; exit 3; }
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc
    _NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    _ensure_event_log
    _emit_event "guardrail_added" \
      "$(jq -cn --arg stmt "$_GA_STMT" --arg src "$_GA_SRC" '{statement: $stmt, source: $src}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" \
      --arg stmt "$_GA_STMT" \
      --arg src "$_GA_SRC" \
      --arg ts "$_NOW" \
      '.guardrails = ((.guardrails // []) + [{rule: $stmt, source: $src, timestamp: $ts}])'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- guardrail_replace -----------------------------------------------------
  # guardrail_replace --index <n> --statement <text> [--source <src>]
  # Replaces .guardrails[n], emits guardrail_replaced event.
  guardrail_replace)
    _GRP_IDX=""
    _GRP_STMT=""
    _GRP_SRC=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --index) _GRP_IDX="$2"; shift 2 ;;
        --statement) _GRP_STMT="$2"; shift 2 ;;
        --source) _GRP_SRC="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ -n "$_GRP_IDX" ]] || { printf 'guardrail_replace: --index <n> required\n' >&2; exit 3; }
    [[ -n "$_GRP_STMT" ]] || { printf 'guardrail_replace: --statement <text> required\n' >&2; exit 3; }
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc
    _NOW=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
    _ensure_event_log
    _emit_event "guardrail_replaced" \
      "$(jq -cn --argjson idx "$_GRP_IDX" --arg stmt "$_GRP_STMT" --arg src "$_GRP_SRC" \
          '{index: $idx, statement: $stmt, source: $src}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" \
      --argjson idx "$_GRP_IDX" \
      --arg stmt "$_GRP_STMT" \
      --arg src "$_GRP_SRC" \
      --arg ts "$_NOW" \
      'if ($idx < 0) or ($idx >= ((.guardrails // []) | length)) then
         error("guardrail_replace: index \($idx) out of range")
       else
         .guardrails[$idx].rule = $stmt
         | if $src == "" then .
           else .guardrails[$idx].source = $src
                | .guardrails[$idx].timestamp = $ts
           end
       end'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- guardrail_remove ------------------------------------------------------
  # guardrail_remove --index <n>
  # Removes .guardrails[n], emits guardrail_removed event.
  guardrail_remove)
    _GRM_IDX=""
    while [[ $# -gt 0 ]]; do
      case "$1" in
        --index) _GRM_IDX="$2"; shift 2 ;;
        *) shift ;;
      esac
    done
    [[ -n "$_GRM_IDX" ]] || { printf 'guardrail_remove: --index <n> required\n' >&2; exit 3; }
    _require_state_file
    _verify_integrity_hash "$STATE_FILE"; hash_rc=$?; [[ $hash_rc -eq 0 ]] || exit $hash_rc
    _ensure_event_log
    _emit_event "guardrail_removed" \
      "$(jq -cn --argjson idx "$_GRM_IDX" '{index: $idx}')" \
      || exit 5
    _write_with_hash "$STATE_FILE" \
      --argjson idx "$_GRM_IDX" \
      'del(.guardrails[$idx])'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  # ---- archive_state ---------------------------------------------------------
  # archive_state
  # Emits state_archived event, renames state.json → state.archived.json,
  # renames events.jsonl → events.archived.jsonl.
  archive_state)
    _require_state_file
    _ensure_event_log
    _emit_event "state_archived" '{}' \
      || exit 5
    # Stamp event_head in state.json before renaming so the archived copy
    # reflects the state_archived event that was just appended.
    _arch_event_head=$(_read_event_head 2>/dev/null || echo "")
    if [[ -n "$_arch_event_head" ]]; then
      _write_state_atomic "$STATE_FILE" --arg eh "$_arch_event_head" '.event_head = $eh' || true
    fi
    _ARCHIVE_JSON="${INSTANCE_DIR}/state.archived.json"
    _EVENTS_FILE="${INSTANCE_DIR}/events.jsonl"
    _EVENTS_ARCHIVE="${INSTANCE_DIR}/events.archived.jsonl"
    mv "$STATE_FILE" "$_ARCHIVE_JSON" || { printf 'archive_state: failed to rename state.json\n' >&2; exit 4; }
    [[ -f "$_EVENTS_FILE" ]] && mv "$_EVENTS_FILE" "$_EVENTS_ARCHIVE" || true
    exit 0
    ;;

  *)
    printf 'state-transition.sh: unknown subcommand: %s\n' "$SUBCOMMAND" >&2
    printf 'Valid subcommands: init, phase_advance, exec_phase_advance, set_field, append_array, merge, halt_reason, backfill_session, flaky_test_append, stamp_last_updated, replay, grant_override, consume_override, emit_revert_event, bar_add, bar_remove, guardrail_add, guardrail_replace, guardrail_remove, archive_state\n' >&2
    exit 3
    ;;
esac
