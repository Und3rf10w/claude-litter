#!/usr/bin/env bash
# hook-graph.sh — Auto-generates the deepwork hook dependency graph.
#
# Usage:
#   bash plugins/deepwork/scripts/hook-graph.sh
#       Print full markdown to stdout.
#   bash plugins/deepwork/scripts/hook-graph.sh --check
#       Diff stdout against references/hook-architecture.md; exit 0 if identical,
#       exit 2 with diff on stderr if drift detected.
#
# Dependencies: jq, grep, awk, sort, find (all standard on deepwork targets).
# Pure bash 3.2+. No network. No timestamps in output (deterministic diffing).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOOKS_DIR="${PLUGIN_ROOT}/hooks"
EXECUTE_HOOKS_DIR="${HOOKS_DIR}/execute"
HOOKS_JSON="${HOOKS_DIR}/hooks.json"
SETUP_SCRIPT="${PLUGIN_ROOT}/scripts/setup-deepwork.sh"

# ----------------------------------------------------------------------------
# --check mode
# ----------------------------------------------------------------------------
CHECK_MODE=false
if [[ "${1:-}" == "--check" ]]; then
  CHECK_MODE=true
fi

SNAPSHOT_TARGET="${PLUGIN_ROOT}/references/hook-architecture.md"

if [[ "$CHECK_MODE" == "true" ]]; then
  TMPFILE=$(mktemp /tmp/hook-graph-check-XXXXXX.md)
  bash "${BASH_SOURCE[0]}" > "$TMPFILE" 2>/dev/null
  if diff -u "$SNAPSHOT_TARGET" "$TMPFILE" >/dev/null 2>&1; then
    rm -f "$TMPFILE"
    exit 0
  else
    diff -u "$SNAPSHOT_TARGET" "$TMPFILE" >&2 || true
    rm -f "$TMPFILE"
    exit 2
  fi
fi

# ----------------------------------------------------------------------------
# Helper: mermaid-safe label (escape < > ( ) [ ] and truncate if needed)
# ----------------------------------------------------------------------------
mermaid_label() {
  printf '%s' "$1" \
    | sed -e 's/</\&lt;/g' -e 's/>/\&gt;/g' \
          -e 's/(/\&#40;/g' -e 's/)/\&#41;/g' \
          -e 's/\[/\&#91;/g' -e 's/\]/\&#93;/g'
}

# ----------------------------------------------------------------------------
# Parse registration data from setup-deepwork.sh
# Returns lines of: <hook_file> <event> <matcher> <mode>
# mode = design | execute | shared
# ----------------------------------------------------------------------------
parse_registrations() {
  # Design-mode block (lines ~499-661): extract matcher from HOOK= declarations
  # and event from add_hook_event(.; "<Event>"; attach_dw(...)) calls.
  # We correlate variable names: e.g., DELIVER_GATE_HOOK var → deliver-gate.sh.

  # Static mapping: bash variable stem -> hook script basename, event, matcher, mode
  # Derived by reading setup-deepwork.sh variable declarations and the jq block.
  # Format: VAR_STEM:hook_file:event:matcher:mode  (colon delimiter — safe, no matcher uses colon)
  cat <<'REGTABLE'
PERMISSION_REQUEST_HOOK:incident-detector.sh:PermissionRequest:.*:design
SUBAGENT_STOP_HOOK:incident-detector.sh:SubagentStop:.*:design
SESSION_START_HOOK:session-context.sh:SessionStart:clear|compact:design
TASK_COMPLETED_HOOK:task-completed-gate.sh:TaskCompleted:.*:design
PERMISSION_DENIED_HOOK:incident-detector.sh:PermissionDenied:.*:design
DELIVER_GATE_HOOK:deliver-gate.sh:PreToolUse:ExitPlanMode:design
FRONTMATTER_GATE_HOOK:frontmatter-gate.sh:PreToolUse:Write|Edit:design
DRIFT_MARKER_HOOK:state-drift-marker.sh:PreToolUse:Write|Edit:design
DRIFT_MARKER_HOOK:state-drift-marker.sh:PostToolUse:Write|Edit:design
PHASE_ADVANCE_GATE_HOOK:phase-advance-gate.sh:PreToolUse:Edit|Write:design
VERDICT_GATE_HOOK:verdict-version-gate.sh:PreToolUse:SendMessage:design
VERSION_BUMP_NOTIFY_HOOK:version-bump-notify.sh:FileChanged:^v[0-9]+(-final)?\.md$:design
STALE_WARN_HOOK:stale-warn.sh:FileChanged:^v[0-9]+(-final)?\.md$:design
CRITIQUE_VERSION_GATE_HOOK:critique-version-gate.sh:TaskCompleted:.*:design
STOP_HALT_GATE_HOOK:halt-gate.sh:Stop:.*:design
STOP_ARCHIVE_HOOK:approve-archive.sh:Stop:.*:design
WIKI_LOG_HOOK:wiki-log-append.sh:FileChanged:.claude/deepwork:design
REGTABLE
  # hooks.json static registrations (TeammateIdle, PreCompact)
  cat <<'REGTABLE'
HOOKS_JSON_STATIC:teammate-idle-gate.sh:TeammateIdle:.*:design
HOOKS_JSON_STATIC:pre-compact.sh:PreCompact:(none):design
REGTABLE
  # Execute-mode block
  cat <<'REGTABLE'
EXEC_PRE_WRITE:plan-citation-gate.sh:PreToolUse:Write|Edit:execute
EXEC_POST_WRITE:retest-dispatch.sh:PostToolUse:Write|Edit:execute
EXEC_PRE_BASH:bash-gate.sh:PreToolUse:Bash:execute
EXEC_POST_BASH:test-capture.sh:PostToolUse:Bash:execute
EXEC_FC_SRC:file-changed-retest.sh:FileChanged:src/**:execute
EXEC_FC_PLAN:plan-drift-detector.sh:FileChanged:<plan_ref>:execute
EXEC_TC:task-scope-gate.sh:TaskCreated:.*:execute
EXEC_STOP:stop-hook.sh:Stop:.*:execute
REGTABLE
}

# ----------------------------------------------------------------------------
# Extract state.json reads from a hook script
# Patterns: jq -r '...' "$FILE", echo "$VAR" | jq -r '...', printf ... | jq '...'
# ----------------------------------------------------------------------------
# Hook-input payload fields (PreToolUse/PostToolUse base schema, event metadata) —
# these are local per-invocation data, not cross-hook state.json dependencies.
# Prefix patterns tool_input.* and tool_result.* block all sub-fields.
# Hook-input payload fields (PreToolUse/PostToolUse base schema, event metadata,
# task payload fields, and internal-blob fields from test-results/pending-change) —
# these are local per-invocation or internal-file data, not cross-hook state.json deps.
# Prefix patterns tool_input.* and tool_result.* block all sub-fields.
_HOOK_FIELD_BLOCKLIST='^\.(tool_name|tool_use_id|hook_event_name|cwd|session_id|transcript_path|permission_mode|agent_id|agent_type|matcher|prompt|message|event|file_path|teammate_name|task_id|task_subject|task_description|exit_code|to|stop_hook_active|result|output|n|0|1|2|tool_input|tool_input\..+|tool_result|tool_result\..+|taskId|status|subject|owner|command|files|flaky_suspected|rule|length|keys|values|type|empty|error|env|ascii_downcase|ascii_upcase|ltrimstr|rtrimstr|startswith|endswith|test|match|capture|scan|split|join|flatten|unique|sort|reverse|first|last|tostring|tonumber|floor|ceil|fabs|nan|infinite|isinfinite|isnan|isnormal|sort_by|group_by|unique_by|min_by|max_by|add|any|all|recurse|path|leaf_paths|paths|del|to_entries|from_entries|with_entries|select|map|map_values|arrays|objects|iterables|booleans|numbers|strings|nulls|not|if|then|else|elif|try|catch|reduce|label|break|until|while|limit|first|last|nth|range|input|inputs|debug|stderr|env|builtins|modulemeta|ascii|explode|implode|tojson|fromjson|format|@base64|@base64d|@uri|@csv|@tsv|@html|@json|@text|@sh|@sh_d)$'

extract_state_reads() {
  local file="$1"
  # Pattern 1: jq [-flags] 'expr' "$FILE_VAR" — file arg form
  grep -oE "jq[[:space:]]+-[a-z]*r?[a-z]*[[:space:]]+'[^']*'" "$file" 2>/dev/null \
    | grep -oE '\.[a-zA-Z_][a-zA-Z0-9_.]*' \
    | grep -vE "$_HOOK_FIELD_BLOCKLIST" \
    | sort -u
  # Pattern 2: jq 'expr' without -r flags
  grep -oE "jq[[:space:]]+'[^']*'" "$file" 2>/dev/null \
    | grep -oE '\.[a-zA-Z_][a-zA-Z0-9_.]*' \
    | grep -vE "$_HOOK_FIELD_BLOCKLIST" \
    | sort -u
  # Pattern 3: echo/printf VAR | jq -r/n 'expr'  (session-context.sh pattern)
  grep -oE '(echo|printf)[[:space:]]+[^|]+\|[[:space:]]*jq[[:space:]]+-?[a-z]*[[:space:]]+'"'"'[^'"'"']*'"'" "$file" 2>/dev/null \
    | grep -oE "jq[[:space:]]+-?[a-z]*[[:space:]]+'[^']*'" \
    | grep -oE '\.[a-zA-Z_][a-zA-Z0-9_.]*' \
    | grep -vE "$_HOOK_FIELD_BLOCKLIST" \
    | sort -u
}

# ----------------------------------------------------------------------------
# Extract state.json writes from a hook script
# Patterns: jq '... .field = ...' via --arg, --argjson, or assignment
# ----------------------------------------------------------------------------
extract_state_writes() {
  local file="$1"
  grep -oE '\.[a-zA-Z_][a-zA-Z0-9_.]*[[:space:]]*=[[:space:]]*\$[a-zA-Z_]' "$file" 2>/dev/null \
    | grep -oE '\.[a-zA-Z_][a-zA-Z0-9_.]+'  \
    | sort -u
  grep -oE '\.[a-zA-Z_][a-zA-Z0-9_.]*[[:space:]]*\+=[[:space:]]' "$file" 2>/dev/null \
    | grep -oE '\.[a-zA-Z_][a-zA-Z0-9_.]+'  \
    | sort -u
}

# ----------------------------------------------------------------------------
# Extract marker-file reads
# ----------------------------------------------------------------------------
# Shared helper: extract a filename from a path containing INSTANCE_DIR
_extract_instance_filename() {
  # Input: one line containing $INSTANCE_DIR/... or ${INSTANCE_DIR}/...
  # Outputs: the filename portion (everything after the last /)
  grep -oE '\$\{?INSTANCE_DIR\}?/[^"'"'"' $}{>|;&,]+' \
    | sed 's|\${INSTANCE_DIR}/||; s|\$INSTANCE_DIR/||' \
    | sed 's|["/'"'"',].*||' \
    | grep -v '^$'
}

extract_marker_reads() {
  local file="$1"
  # Direct: [[ -f "${INSTANCE_DIR}/name" ]] or [[ -f "$INSTANCE_DIR/name" ]]
  grep -oE '\[\[[[:space:]]+-f[[:space:]]+"[^"]*\$\{?INSTANCE_DIR\}?/[^"]+' "$file" 2>/dev/null \
    | _extract_instance_filename | sort -u
  # Direct: test -f "${INSTANCE_DIR}/name"
  grep -oE 'test -f "[^"]*\$\{?INSTANCE_DIR\}?/[^"]+' "$file" 2>/dev/null \
    | _extract_instance_filename | sort -u
  # Direct: cat / jq ... "${INSTANCE_DIR}/name"
  grep -oE '(cat|jq)[[:space:]]+[^$]*"[^"]*\$\{?INSTANCE_DIR\}?/[^"]+' "$file" 2>/dev/null \
    | _extract_instance_filename | sort -u
  # Indirect: VAR="${INSTANCE_DIR}/name" or VAR="$INSTANCE_DIR/name"
  # Then the var is read via cat, jq, [[ -f etc. Capture the name from the assignment.
  grep -oE '[A-Z_]+="[^"]*\$\{?INSTANCE_DIR\}?/[^"]+' "$file" 2>/dev/null \
    | _extract_instance_filename | sort -u
  # Unquoted: $INSTANCE_DIR/name (no surrounding quotes)
  grep -oE '\$\{?INSTANCE_DIR\}?/[^"'"'"' $}{>|;&,]+' "$file" 2>/dev/null \
    | sed 's|\${INSTANCE_DIR}/||; s|\$INSTANCE_DIR/||' \
    | sed 's|[/"'"'"',].*||; s|[")].*||' \
    | grep -v '^$' | sort -u
}

# ----------------------------------------------------------------------------
# Extract marker-file writes
# ----------------------------------------------------------------------------
extract_marker_writes() {
  local file="$1"
  # Direct: > "${INSTANCE_DIR}/name" or >> "${INSTANCE_DIR}/name" or mv src "${INSTANCE_DIR}/name"
  grep -oE '(>>?|mv[[:space:]]+[^[:space:]]+)[[:space:]]+"[^"]*\$\{?INSTANCE_DIR\}?/[^"]+' "$file" 2>/dev/null \
    | _extract_instance_filename | sort -u
  # Direct: cp src "${INSTANCE_DIR}/name"
  grep -oE 'cp[[:space:]]+[^[:space:]]+[[:space:]]+"[^"]*\$\{?INSTANCE_DIR\}?/[^"]+' "$file" 2>/dev/null \
    | _extract_instance_filename | sort -u
  # Indirect via named variable: VAR="${INSTANCE_DIR}/name", then >> "$VAR"
  # Collect assignments like FOO="${INSTANCE_DIR}/test-results.jsonl"
  while IFS= read -r _assign; do
    local _v _fname
    _v=$(printf '%s' "$_assign" | grep -oE '^[A-Z_]+')
    _fname=$(printf '%s' "$_assign" | _extract_instance_filename)
    [[ -n "$_v" ]] && [[ -n "$_fname" ]] || continue
    # Only emit if a write operation uses this var
    if grep -qE '(>>?[[:space:]]+"?\$\{?'"$_v"'\}?"?|printf[[:space:]][^>]+(>[[:space:]]+"?\$\{?'"$_v"'\}?"?))' "$file" 2>/dev/null; then
      printf '%s\n' "$_fname"
    fi
  done < <(grep -oE '[A-Z_]+="[^"]*\$\{?INSTANCE_DIR\}?/[^"]+' "$file" 2>/dev/null)
  # Unquoted writes: >> $INSTANCE_DIR/name
  grep -oE '>>?[[:space:]]+\$\{?INSTANCE_DIR\}?/[^"'"'"' $}{;&,]+' "$file" 2>/dev/null \
    | sed 's|>>*[[:space:]]*||' \
    | sed 's|\${INSTANCE_DIR}/||; s|\$INSTANCE_DIR/||' \
    | sed 's|[/"'"'"',].*||; s|[")].*||' \
    | grep -v '^$' | sort -u
}

# ----------------------------------------------------------------------------
# Extract orchestrator obligation comments
# ----------------------------------------------------------------------------
extract_orchestrator_obligations() {
  local file="$1"
  grep -E '#[[:space:]]*(Orchestrator obligation:|Depends on: orchestrator)' "$file" 2>/dev/null \
    | sed 's/^[^#]*#[[:space:]]*//' \
    | sort -u
}

# ----------------------------------------------------------------------------
# Bash 3.2-compatible map emulation via flat variables.
# _map_set <namespace> <key> <value>   — set key (key sanitized to safe var chars)
# _map_get <namespace> <key>           — print value or ""
# _map_get_raw <varname>               — used internally
# Key sanitization: replace non-alphanumeric with '_'
# ----------------------------------------------------------------------------
_map_key() {
  printf '%s' "$1" | sed 's/[^a-zA-Z0-9]/_/g'
}
_map_set() {
  local _ns="$1" _raw_key="$2" _val="$3"
  local _k
  _k=$(_map_key "$_raw_key")
  eval "_MAP_${_ns}__${_k}=\$_val"
}
_map_get() {
  local _ns="$1" _raw_key="$2"
  local _k
  _k=$(_map_key "$_raw_key")
  eval "printf '%s' \"\${_MAP_${_ns}__${_k}:-}\""
}

# ----------------------------------------------------------------------------
# Collect all unique events and hooks
# Maps: EVENTS, MATCHERS, MODES, STATE_READS, STATE_WRITES, MARKER_READS,
#       MARKER_WRITES, OBLIGATIONS
# ----------------------------------------------------------------------------
ALL_EVENTS_SET=""   # newline-separated event names (deduped)
ALL_HOOKS_SET=""    # newline-separated hook basenames

# Process registration table
while IFS=':' read -r _var _hook _event _matcher _mode; do
  [[ -n "$_hook" ]] || continue
  # Track events
  if ! printf '%s\n' "$ALL_EVENTS_SET" | grep -qxF "$_event"; then
    ALL_EVENTS_SET="${ALL_EVENTS_SET}"$'\n'"$_event"
  fi
  # Track hooks
  if ! printf '%s\n' "$ALL_HOOKS_SET" | grep -qxF "$_hook"; then
    ALL_HOOKS_SET="${ALL_HOOKS_SET}"$'\n'"$_hook"
  fi
  # Events for this hook (accumulate, dedup)
  _cur_events=$(_map_get EVENTS "$_hook")
  if [[ -z "$_cur_events" ]]; then
    _map_set EVENTS "$_hook" "$_event"
  elif ! printf '%s\n' "${_cur_events}" | tr ' ' '\n' | grep -qxF "$_event"; then
    _map_set EVENTS "$_hook" "${_cur_events} ${_event}"
  fi
  # Matchers for this hook
  _cur_matchers=$(_map_get MATCHERS "$_hook")
  if [[ -z "$_cur_matchers" ]]; then
    _map_set MATCHERS "$_hook" "$_matcher"
  elif ! printf '%s\n' "${_cur_matchers}" | tr ' ' '\n' | grep -qxF "$_matcher"; then
    _map_set MATCHERS "$_hook" "${_cur_matchers} ${_matcher}"
  fi
  # Mode (design + execute = shared)
  _cur_mode=$(_map_get MODES "$_hook")
  if [[ -z "$_cur_mode" ]]; then
    _map_set MODES "$_hook" "$_mode"
  elif [[ "$_cur_mode" != "$_mode" ]] && [[ "$_cur_mode" != "shared" ]]; then
    _map_set MODES "$_hook" "shared"
  fi
done < <(parse_registrations)

# Sort collected data
ALL_EVENTS_SORTED=$(printf '%s\n' $ALL_EVENTS_SET | sort -u | grep -v '^$')
ALL_HOOKS_SORTED=$(printf '%s\n' $ALL_HOOKS_SET | sort -u | grep -v '^$')

# For each hook, extract reads/writes/markers/obligations from source
while IFS= read -r _hook; do
  [[ -n "$_hook" ]] || continue

  # Determine script path
  case "$(_map_get MODES "$_hook")" in
    execute)
      _hookpath="${EXECUTE_HOOKS_DIR}/${_hook}"
      ;;
    *)
      _hookpath="${HOOKS_DIR}/${_hook}"
      ;;
  esac

  # shared mode hooks exist in design dir (they are design hooks also used in execute context)
  if [[ ! -f "$_hookpath" ]] && [[ -f "${HOOKS_DIR}/${_hook}" ]]; then
    _hookpath="${HOOKS_DIR}/${_hook}"
  fi

  [[ -f "$_hookpath" ]] || continue

  _map_set STATE_READS  "$_hook" "$(extract_state_reads  "$_hookpath" | sort -u | tr '\n' ' ' | sed 's/ $//')"
  _map_set STATE_WRITES "$_hook" "$(extract_state_writes "$_hookpath" | sort -u | tr '\n' ' ' | sed 's/ $//')"
  _map_set MARKER_READS  "$_hook" "$(extract_marker_reads  "$_hookpath" | sort -u | tr '\n' ' ' | sed 's/ $//')"
  _map_set MARKER_WRITES "$_hook" "$(extract_marker_writes "$_hookpath" | sort -u | tr '\n' ' ' | sed 's/ $//')"
  _map_set OBLIGATIONS  "$_hook" "$(extract_orchestrator_obligations "$_hookpath" | tr '\n' '|' | sed 's/|$//')"
done <<< "$ALL_HOOKS_SORTED"

# Collect all unique state fields across all hooks
ALL_STATE_FIELDS=""
for _h in $(printf '%s\n' $ALL_HOOKS_SORTED | sort); do
  for _f in $(_map_get STATE_READS "$_h") $(_map_get STATE_WRITES "$_h"); do
    [[ -n "$_f" ]] || continue
    if ! printf '%s\n' "$ALL_STATE_FIELDS" | grep -qxF "$_f"; then
      ALL_STATE_FIELDS="${ALL_STATE_FIELDS}"$'\n'"$_f"
    fi
  done
done
ALL_STATE_FIELDS_SORTED=$(printf '%s\n' $ALL_STATE_FIELDS | sort -u | grep -v '^$')

# Collect all unique marker files
ALL_MARKERS=""
for _h in $(printf '%s\n' $ALL_HOOKS_SORTED | sort); do
  for _m in $(_map_get MARKER_READS "$_h") $(_map_get MARKER_WRITES "$_h"); do
    [[ -n "$_m" ]] || continue
    if ! printf '%s\n' "$ALL_MARKERS" | grep -qxF "$_m"; then
      ALL_MARKERS="${ALL_MARKERS}"$'\n'"$_m"
    fi
  done
done
ALL_MARKERS_SORTED=$(printf '%s\n' $ALL_MARKERS | sort -u | grep -v '^$')

# ----------------------------------------------------------------------------
# Build Mermaid node IDs (safe identifiers, no spaces, no special chars)
# ----------------------------------------------------------------------------
mermaid_id() {
  printf '%s' "$1" \
    | sed -e 's/\.sh$//' \
          -e 's/[^a-zA-Z0-9]/_/g' \
          -e 's/__*/_/g' \
          -e 's/^_//' \
          -e 's/_$//'
}

# ----------------------------------------------------------------------------
# Emit Mermaid subgraph: Events
# ----------------------------------------------------------------------------
emit_mermaid() {
  printf '```mermaid\n'
  printf 'flowchart LR\n'

  # Events subgraph
  printf '  subgraph Events\n'
  while IFS= read -r _ev; do
    [[ -n "$_ev" ]] || continue
    _id=$(mermaid_id "$_ev")
    printf '    %s["%s"]\n' "$_id" "$(mermaid_label "$_ev")"
  done <<< "$ALL_EVENTS_SORTED"
  printf '  end\n'

  # Design hooks subgraph
  printf '  subgraph Hooks_Design\n'
  while IFS= read -r _h; do
    [[ -n "$_h" ]] || continue
    _mode=$(_map_get MODES "$_h"); _mode="${_mode:-design}"
    [[ "$_mode" == "design" || "$_mode" == "shared" ]] || continue
    _id=$(mermaid_id "$_h")
    _label=$(mermaid_label "${_h%.sh}")
    printf '    %s["%s"]\n' "$_id" "$_label"
  done <<< "$ALL_HOOKS_SORTED"
  printf '  end\n'

  # Execute hooks subgraph
  printf '  subgraph Hooks_Execute\n'
  while IFS= read -r _h; do
    [[ -n "$_h" ]] || continue
    _mode=$(_map_get MODES "$_h"); _mode="${_mode:-design}"
    [[ "$_mode" == "execute" || "$_mode" == "shared" ]] || continue
    _id=$(mermaid_id "$_h")
    _label=$(mermaid_label "${_h%.sh}")
    printf '    %s["%s"]\n' "$_id" "$_label"
  done <<< "$ALL_HOOKS_SORTED"
  printf '  end\n'

  # State fields subgraph
  if [[ -n "$ALL_STATE_FIELDS_SORTED" ]]; then
    printf '  subgraph State\n'
    while IFS= read -r _f; do
      [[ -n "$_f" ]] || continue
      _id=$(mermaid_id "$_f")
      _label=$(mermaid_label "$_f")
      printf '    %s((["%s"]))\n' "$_id" "$_label"
    done <<< "$ALL_STATE_FIELDS_SORTED"
    printf '  end\n'
  fi

  # Markers subgraph
  if [[ -n "$ALL_MARKERS_SORTED" ]]; then
    printf '  subgraph Markers\n'
    while IFS= read -r _m; do
      [[ -n "$_m" ]] || continue
      _id=$(mermaid_id "$_m")
      _label=$(mermaid_label "$_m")
      printf '    %s[/"  %s"/]\n' "$_id" "$_label"
    done <<< "$ALL_MARKERS_SORTED"
    printf '  end\n'
  fi

  # Event → Hook edges (sorted by event then hook)
  while IFS= read -r _ev; do
    [[ -n "$_ev" ]] || continue
    _ev_id=$(mermaid_id "$_ev")
    while IFS= read -r _h; do
      [[ -n "$_h" ]] || continue
      _events=$(_map_get EVENTS "$_h")
      if printf ' %s ' " $_events " | grep -qF " ${_ev} "; then
        _h_id=$(mermaid_id "$_h")
        _matcher=$(_map_get MATCHERS "$_h")
        # Pick matcher relevant to this event (first if multiple)
        _mlabel=$(printf '%s' "$_matcher" | tr ' ' '\n' | head -1)
        if [[ -n "$_mlabel" ]] && [[ "$_mlabel" != ".*" ]] && [[ "$_mlabel" != "(none)" ]]; then
          printf '  %s -->|"%s"| %s\n' "$_ev_id" "$(mermaid_label "$_mlabel")" "$_h_id"
        else
          printf '  %s --> %s\n' "$_ev_id" "$_h_id"
        fi
      fi
    done <<< "$ALL_HOOKS_SORTED"
  done <<< "$ALL_EVENTS_SORTED"

  # Hook → State read edges (dashed)
  while IFS= read -r _h; do
    [[ -n "$_h" ]] || continue
    _h_id=$(mermaid_id "$_h")
    for _f in $(printf '%s\n' $(_map_get STATE_READS "$_h") | sort -u); do
      [[ -n "$_f" ]] || continue
      _f_id=$(mermaid_id "$_f")
      printf '  %s -.->|"reads"| %s\n' "$_h_id" "$_f_id"
    done
  done <<< "$ALL_HOOKS_SORTED"

  # Hook → State write edges (solid)
  while IFS= read -r _h; do
    [[ -n "$_h" ]] || continue
    _h_id=$(mermaid_id "$_h")
    for _f in $(printf '%s\n' $(_map_get STATE_WRITES "$_h") | sort -u); do
      [[ -n "$_f" ]] || continue
      _f_id=$(mermaid_id "$_f")
      printf '  %s -->|"writes"| %s\n' "$_h_id" "$_f_id"
    done
  done <<< "$ALL_HOOKS_SORTED"

  # Hook → Marker read edges
  while IFS= read -r _h; do
    [[ -n "$_h" ]] || continue
    _h_id=$(mermaid_id "$_h")
    for _m in $(printf '%s\n' $(_map_get MARKER_READS "$_h") | sort -u); do
      [[ -n "$_m" ]] || continue
      _m_id=$(mermaid_id "$_m")
      printf '  %s -.->|"reads"| %s\n' "$_h_id" "$_m_id"
    done
  done <<< "$ALL_HOOKS_SORTED"

  # Hook → Marker write edges
  while IFS= read -r _h; do
    [[ -n "$_h" ]] || continue
    _h_id=$(mermaid_id "$_h")
    for _m in $(printf '%s\n' $(_map_get MARKER_WRITES "$_h") | sort -u); do
      [[ -n "$_m" ]] || continue
      _m_id=$(mermaid_id "$_m")
      printf '  %s -->|"writes"| %s\n' "$_h_id" "$_m_id"
    done
  done <<< "$ALL_HOOKS_SORTED"

  printf '```\n'
}

# ----------------------------------------------------------------------------
# Build adjacency list JSON
# ----------------------------------------------------------------------------
emit_adjacency_json() {
  printf '```json\n'
  printf '{\n'
  printf '  "hooks": {\n'

  _first_hook=true
  while IFS= read -r _h; do
    [[ -n "$_h" ]] || continue

    # Build triggered_by array
    _events_arr=$(printf '%s\n' $(_map_get EVENTS "$_h") | sort -u \
      | awk '{printf "      \"%s\",\n", $0}' \
      | sed '$s/,$//')

    # Build mode
    _mode=$(_map_get MODES "$_h"); _mode="${_mode:-design}"

    # Build state reads array
    _state_reads_arr=$(printf '%s\n' $(_map_get STATE_READS "$_h") | sort -u \
      | awk '{printf "          \"%s\",\n", $0}' \
      | sed '$s/,$//')

    # Build state writes array
    _state_writes_arr=$(printf '%s\n' $(_map_get STATE_WRITES "$_h") | sort -u \
      | awk '{printf "          \"%s\",\n", $0}' \
      | sed '$s/,$//')

    # Build marker reads array
    _marker_reads_arr=$(printf '%s\n' $(_map_get MARKER_READS "$_h") | sort -u \
      | awk '{printf "          \"%s\",\n", $0}' \
      | sed '$s/,$//')

    # Build marker writes array
    _marker_writes_arr=$(printf '%s\n' $(_map_get MARKER_WRITES "$_h") | sort -u \
      | awk '{printf "          \"%s\",\n", $0}' \
      | sed '$s/,$//')

    # Orchestrator obligations
    _obl=$(_map_get OBLIGATIONS "$_h")
    if [[ -n "$_obl" ]]; then
      _obl_json=$(printf '%s' "$_obl" | sed 's/|/", "/g')
      _obl_field="\"orchestrator_obligation\": \"${_obl_json}\","
    else
      _obl_field=""
    fi

    # Source ref: determine path
    _mode_for_src=$(_map_get MODES "$_h"); _mode_for_src="${_mode_for_src:-design}"
    case "$_mode_for_src" in
      execute) _src_rel="hooks/execute/${_h}" ;;
      *)        _src_rel="hooks/${_h}" ;;
    esac
    if [[ ! -f "${PLUGIN_ROOT}/${_src_rel}" ]] && [[ -f "${HOOKS_DIR}/${_h}" ]]; then
      _src_rel="hooks/${_h}"
    fi

    [[ "$_first_hook" == "true" ]] || printf ',\n'
    _first_hook=false

    printf '    "%s": {\n' "$_h"
    printf '      "triggered_by": [\n'
    [[ -n "$_events_arr" ]] && printf '%s\n' "$_events_arr"
    printf '      ],\n'
    printf '      "mode": "%s",\n' "$_mode"
    printf '      "reads": {\n'
    printf '        "state": [\n'
    [[ -n "$_state_reads_arr" ]] && printf '%s\n' "$_state_reads_arr"
    printf '        ],\n'
    printf '        "markers": [\n'
    [[ -n "$_marker_reads_arr" ]] && printf '%s\n' "$_marker_reads_arr"
    printf '        ]\n'
    printf '      },\n'
    printf '      "writes": {\n'
    printf '        "state": [\n'
    [[ -n "$_state_writes_arr" ]] && printf '%s\n' "$_state_writes_arr"
    printf '        ],\n'
    printf '        "markers": [\n'
    [[ -n "$_marker_writes_arr" ]] && printf '%s\n' "$_marker_writes_arr"
    printf '        ]\n'
    printf '      }'
    if [[ -n "$_obl_field" ]]; then
      printf ',\n      %s' "$_obl_field"
      printf '\n      "source_refs": ["%s"]\n' "$_src_rel"
    else
      printf ',\n      "source_refs": ["%s"]\n' "$_src_rel"
    fi
    printf '    }'
  done <<< "$ALL_HOOKS_SORTED"

  printf '\n  },\n'
  printf '  "orchestrator_writes": {\n'
  printf '    "version-sentinel.json": ["supersede-vN macro (plan mode)"],\n'
  printf '    "state.archived.json": ["approve-archive.sh (on phase=done Stop)"],\n'
  printf '    "pending-change.json": ["EXECUTOR (execute mode, before write cycle)"],\n'
  printf '    "execute-done.sentinel": ["EXECUTOR (execute mode, on completion)"]\n'
  printf '  }\n'
  printf '}\n'
  printf '```\n'
}

# ----------------------------------------------------------------------------
# Count nodes and edges for comment header
# ----------------------------------------------------------------------------
count_nodes() {
  local n=0
  while IFS= read -r _h; do [[ -n "$_h" ]] && n=$((n+1)); done <<< "$ALL_HOOKS_SORTED"
  while IFS= read -r _e; do [[ -n "$_e" ]] && n=$((n+1)); done <<< "$ALL_EVENTS_SORTED"
  while IFS= read -r _f; do [[ -n "$_f" ]] && n=$((n+1)); done <<< "$ALL_STATE_FIELDS_SORTED"
  while IFS= read -r _m; do [[ -n "$_m" ]] && n=$((n+1)); done <<< "$ALL_MARKERS_SORTED"
  printf '%d' "$n"
}

count_edges() {
  local e=0
  # Event->Hook edges
  while IFS= read -r _ev; do
    [[ -n "$_ev" ]] || continue
    while IFS= read -r _h; do
      [[ -n "$_h" ]] || continue
      _events=$(_map_get EVENTS "$_h")
      printf ' %s ' " $_events " | grep -qF " ${_ev} " && e=$((e+1))
    done <<< "$ALL_HOOKS_SORTED"
  done <<< "$ALL_EVENTS_SORTED"
  # Hook->State read
  for _h in $(printf '%s\n' $ALL_HOOKS_SORTED | sort); do
    for _f in $(_map_get STATE_READS "$_h"); do [[ -n "$_f" ]] && e=$((e+1)); done
  done
  # Hook->State write
  for _h in $(printf '%s\n' $ALL_HOOKS_SORTED | sort); do
    for _f in $(_map_get STATE_WRITES "$_h"); do [[ -n "$_f" ]] && e=$((e+1)); done
  done
  # Hook->Marker read
  for _h in $(printf '%s\n' $ALL_HOOKS_SORTED | sort); do
    for _m in $(_map_get MARKER_READS "$_h"); do [[ -n "$_m" ]] && e=$((e+1)); done
  done
  # Hook->Marker write
  for _h in $(printf '%s\n' $ALL_HOOKS_SORTED | sort); do
    for _m in $(_map_get MARKER_WRITES "$_h"); do [[ -n "$_m" ]] && e=$((e+1)); done
  done
  printf '%d' "$e"
}

# ----------------------------------------------------------------------------
# Main output
# ----------------------------------------------------------------------------
_NODE_COUNT=$(count_nodes)
_EDGE_COUNT=$(count_edges)

cat <<HEADER
<!-- AUTO-GENERATED BY scripts/hook-graph.sh — DO NOT EDIT BY HAND -->
<!-- Regenerate: bash plugins/deepwork/scripts/hook-graph.sh > plugins/deepwork/references/hook-architecture.md -->
<!-- Check for drift (pre-commit): bash plugins/deepwork/scripts/hook-graph.sh --check -->

# Hook Architecture (Current Snapshot)

Source: plugins/deepwork/hooks/ + plugins/deepwork/scripts/setup-deepwork.sh
Graph: ${_NODE_COUNT} nodes, ${_EDGE_COUNT} edges

## Mermaid Flowchart

HEADER

emit_mermaid

cat <<SECTION

## Adjacency List

SECTION

emit_adjacency_json

cat <<TAIL

## Invariants (advisory — enforced by other tests)

- halt-gate.sh Stop-array index < approve-archive.sh Stop-array index
- every reader of version-sentinel.json has a corresponding orchestrator-write edge
- no hook both reads AND writes the same state field in the same event (TOCTOU safety)

## Output determinism

All lists are sorted alphabetically. JSON is pretty-printed with 2-space indent.
Mermaid edges are sorted by source-then-target. Re-running the generator against
unchanged input produces byte-identical output.

## Limitations

- Fields written via sourced instance-lib.sh helpers (STATE_FILE, INSTANCE_DIR, LOG_FILE,
  PROJECT_ROOT, INSTANCE_ID) are not captured as state.json writes; they are env vars.
- Dynamic state reads inside eval strings or heredocs are not captured by static grep.
- execute.test_manifest[], execute.change_log[], execute.env_attestations[] are accessed
  via complex jq queries in bash-gate.sh/stop-hook.sh; only top-level field names extracted.
- Fields written by the orchestrator outside hooks (direct jq+tmp+mv) are not reflected
  here; see orchestrator_writes section for known examples.
- plan-drift-detector.sh matcher is dynamic (absolute plan_ref path); shown as <plan_ref>.
TAIL
