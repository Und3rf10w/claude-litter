#!/usr/bin/env bash
# test-schema-reverse-invariant.sh — reverse schema invariant: every state.json field
# reference in skills/, profiles/, hooks/, and scripts/ resolves against a known schema.
#
# Complements test-consumer-invariant.sh (which checks every schema field has a consumer).
# This test checks the other direction: every consumer reference names a real field.
#
# Scanning:
#   - .sh files: extracts full dotted jq path expressions (jq -r '.X.Y', jq '.X', etc.)
#   - SKILL.md files: extracts backtick-quoted execute.X path references
#
# Resolution rules:
#   - execute.X or execute.X.Y → must appear as sub-key in profiles/execute/state-schema.json .execute
#   - .X or X (top-level)      → must appear as top-level key in either state-schema.json
#   - Bare execute sub-keys    → also check as execute sub-keys (hooks read execute obj into var)
#   - Array projection (.X[])  → check .X exists (strip [])
#
# Exempt paths — see EXEMPT_PREFIXES below for per-entry rationale.
#
# Exit 0 = all references resolve; Exit 1 = one or more unresolved references.

set +e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"

DEFAULT_SCHEMA="${PLUGIN_ROOT}/profiles/default/state-schema.json"
EXECUTE_SCHEMA="${PLUGIN_ROOT}/profiles/execute/state-schema.json"

PASS=0
FAIL=0

if ! command -v python3 &>/dev/null; then
  printf 'FAIL: python3 required for schema parsing\n' >&2
  exit 1
fi
if ! command -v jq &>/dev/null; then
  printf 'FAIL: jq required\n' >&2
  exit 1
fi

# ── Schema key sets (newline-separated) ──
DEFAULT_KEYS=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
for k in d.keys():
    print(k)
" "$DEFAULT_SCHEMA" 2>/dev/null)

EXECUTE_TOP_KEYS=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
for k in d.keys():
    print(k)
" "$EXECUTE_SCHEMA" 2>/dev/null)

EXECUTE_SUB_KEYS=$(python3 -c "
import json, sys
with open(sys.argv[1]) as f:
    d = json.load(f)
for k in d.get('execute', {}).keys():
    print(k)
" "$EXECUTE_SCHEMA" 2>/dev/null)

_key_in_default()     { printf '%s\n' "$DEFAULT_KEYS"      | grep -qxF "$1"; }
_key_in_execute_top() { printf '%s\n' "$EXECUTE_TOP_KEYS"  | grep -qxF "$1"; }
_key_in_execute_sub() { printf '%s\n' "$EXECUTE_SUB_KEYS"  | grep -qxF "$1"; }

# ── Exemption list — one prefix per line; prefix-matched against bare path ──
#
# [hook-input]       Hook envelope fields: PostToolUse/PreToolUse/Stop input JSON, not state.json
# [task]             Team-overlord task object fields
# [pending]          pending-change.json fields (non-state runtime file)
# [test-result]      test-results.jsonl entry fields written by retest-dispatch.sh, not state.json
# [incident]         incidents.jsonl / discoveries.jsonl internal objects
# [config]           Non-state config file fields (frontmatter-backfill config, etc.)
# [state-extra]      Fields written to state.json by setup but not in declarative schema
# [other]            Other cross-section refs not in state.json
EXEMPT_PREFIXES="session_id
tool_name
tool_input
tool_result
stop_hook_active
transcript_path
agent_id
task_id
task_subject
task_description
team_name
teammate_name
owner
status
subject
taskId
id
metadata
change_id
plan_section
files
no_test_reason
command
exit_code
passed_count
failed_count
flaky_suspected
duration_ms
covering_files
stdout_tail
stderr_tail
timestamp
current_version
file_path
event
rule
source
incident_ref
ref
type
result
resolution
version
n
k
idx
i
ts
fp
sh
hooks
Stop
field
classifiers
extras
default_root
instance_depth
template
carve_outs
carve_out_rel_paths
artifact_type
elapsed_ms
blocked
tool
last_updated
setup_flags_snapshot
verdict
bar_id
source_of_truth
content
path
plan
mode
instance_id
team_name
bar
scope
wave
override_reason
cross_check_required
commit_sha
scope_items
scope_strict
artifact
goal
frontmatter_schema_version
event_head
event_id
event_type
prev_event_hash
payload
custom_e2e
X"

_is_exempt() {
  local p="$1"
  # Strip array projections before prefix matching
  local pbare="${p//\[\]/}"
  local ex
  while IFS= read -r ex; do
    [[ -z "$ex" ]] && continue
    if [[ "$pbare" == "$ex" ]] || [[ "$pbare" == "${ex}."* ]]; then
      return 0
    fi
  done <<< "$EXEMPT_PREFIXES"
  return 1
}

_resolve_path() {
  local raw="$1"
  local p="${raw#.}"
  # Strip array projections
  p="${p//\[\]/}"

  [[ -z "$p" ]] && return 0

  if [[ "$p" == execute.* ]]; then
    local sub="${p#execute.}"
    local first_seg="${sub%%.*}"
    _key_in_execute_sub "$first_seg" && return 0
    return 1
  fi

  local first_seg="${p%%.*}"
  _key_in_default      "$first_seg" && return 0
  _key_in_execute_top  "$first_seg" && return 0
  # Bare execute sub-key: hooks often read state.execute into a variable then
  # query sub-keys without the execute. prefix (e.g. jq -r '.authorized_force_push')
  _key_in_execute_sub  "$first_seg" && return 0
  return 1
}

# ── Extract full jq paths from a .sh file ──
# Uses a full dotted-path regex so .tool_input.message stays as one token
# (and is thus exempt via the tool_input prefix) rather than splitting into
# .tool_input and .message separately.
_extract_sh_paths() {
  local file="$1"
  # Form 1: jq -r 'expr', jq -e 'expr', jq -rs 'expr', etc.
  grep -oE "jq[[:space:]]+-[a-zA-Z]+[[:space:]]+'[^']+'" "$file" 2>/dev/null \
    | grep -oE "\.[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*(\[\])?"
  # Form 2: jq 'expr' (no flags)
  grep -oE "jq[[:space:]]+'[^']+'" "$file" 2>/dev/null \
    | grep -oE "\.[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*(\[\])?"
}

# ── Extract execute.X paths from SKILL.md files ──
_extract_md_paths() {
  local file="$1"
  # Backtick form: `execute.something` or `execute.something[]`
  grep -oE '`execute\.[a-zA-Z_][a-zA-Z0-9_.]*(\[\])?`' "$file" 2>/dev/null \
    | tr -d '`'
  # Paren+backtick: (`execute.authorized_flags`)
  grep -oE '\(`execute\.[a-zA-Z_][a-zA-Z0-9_.]*(\[\])?`\)' "$file" 2>/dev/null \
    | grep -oE 'execute\.[a-zA-Z_][a-zA-Z0-9_.]*(\[\])?'
  # state.json.execute.X reference form
  grep -oE '`state\.json\.execute\.[a-zA-Z_][a-zA-Z0-9_.]*(\[\])?`' "$file" 2>/dev/null \
    | tr -d '`' | sed 's/^state\.json\.//'
}

# ── Write all references to temp file ──
TMPFILE=$(mktemp /tmp/schema-reverse-invariant.XXXXXX)
trap 'rm -f "$TMPFILE"' EXIT

# .sh files
for shfile in $(find "${PLUGIN_ROOT}/skills" "${PLUGIN_ROOT}/hooks" "${PLUGIN_ROOT}/scripts" -name "*.sh" 2>/dev/null); do
  src="${shfile#${PLUGIN_ROOT}/}"
  for rawpath in $(_extract_sh_paths "$shfile"); do
    p="${rawpath#.}"
    [[ -z "$p" ]] && continue
    printf '%s\t%s\n' "$p" "$src"
  done
done >> "$TMPFILE"

# SKILL.md files
for mdfile in $(find "${PLUGIN_ROOT}/skills" "${PLUGIN_ROOT}/profiles" -name "SKILL.md" 2>/dev/null); do
  src="${mdfile#${PLUGIN_ROOT}/}"
  for rawpath in $(_extract_md_paths "$mdfile"); do
    p="${rawpath#.}"
    [[ -z "$p" ]] && continue
    printf '%s\t%s\n' "$p" "$src"
  done
done >> "$TMPFILE"

# Deduplicate by first field (path)
DEDUPED_FILE=$(mktemp /tmp/schema-reverse-deduped.XXXXXX)
trap 'rm -f "$TMPFILE" "$DEDUPED_FILE"' EXIT
sort -t$'\t' -k1,1 -u "$TMPFILE" > "$DEDUPED_FILE"

TOTAL=$(wc -l < "$DEDUPED_FILE" | tr -d ' ')

echo "── Reverse schema invariant: checking ${TOTAL} unique path references ──"
echo ""

GAPS_FILE=$(mktemp /tmp/schema-gaps.XXXXXX)
trap 'rm -f "$TMPFILE" "$DEDUPED_FILE" "$GAPS_FILE"' EXIT

while IFS=$'\t' read -r path src; do
  [[ -z "$path" ]] && continue

  if _is_exempt "$path"; then
    printf 'skip: %s (exempt)\n' "$path"
    continue
  fi

  if _resolve_path "$path"; then
    printf 'pass: %s [%s]\n' "$path" "$src"
    PASS=$((PASS + 1))
  else
    printf 'FAIL: %s — not found in either schema [%s]\n' "$path" "$src" >&2
    FAIL=$((FAIL + 1))
    printf '  - %s (%s)\n' "$path" "$src" >> "$GAPS_FILE"
  fi
done < "$DEDUPED_FILE"

echo ""
echo "─────────────────────────────────────"
printf 'Passed: %d | Failed: %d\n' "$PASS" "$FAIL"

if [[ -s "$GAPS_FILE" ]]; then
  echo ""
  echo "Unresolved references (reverse invariant violations):"
  cat "$GAPS_FILE"
fi

if [[ $FAIL -gt 0 ]]; then
  exit 1
fi
exit 0
