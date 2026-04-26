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
# Integrity hash helpers
# ---------------------------------------------------------------------------

_compute_integrity_hash() {
  local sf="$1"
  local proj hash
  proj=$(jq -c '{
    phase,
    team_name,
    instance_id,
    frontmatter_schema_version,
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
# immediately recomputes and writes the integrity hash in one atomic update.
_write_with_hash() {
  local sf="$1"; shift
  # First pass: apply the mutation filter
  _write_state_atomic "$sf" "$@" || return 4
  # Second pass: recompute and write hash
  local new_hash
  new_hash=$(_compute_integrity_hash "$sf") || return 0  # hash unavailable: leave absent
  _write_state_atomic "$sf" --arg h "$new_hash" '.state_integrity_hash = $h' || return 4
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
    # Apply field set + audit log + hash atomically
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
    _write_with_hash "$STATE_FILE" \
      --arg now "$NOW" \
      '.last_updated = $now'
    rc=$?; [[ $rc -eq 0 ]] || exit 4
    exit 0
    ;;

  *)
    printf 'state-transition.sh: unknown subcommand: %s\n' "$SUBCOMMAND" >&2
    printf 'Valid subcommands: init, phase_advance, exec_phase_advance, set_field, append_array, merge, halt_reason, backfill_session, flaky_test_append, stamp_last_updated\n' >&2
    exit 3
    ;;
esac
