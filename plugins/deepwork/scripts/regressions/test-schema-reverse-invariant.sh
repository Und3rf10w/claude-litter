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
# Lines beginning with `#` are treated as comments (skipped by _is_exempt).
# Use category headers to group entries by rationale; every entry must fall
# under one of the documented categories below.
#
# Category legend:
#   [hook-input]   Hook envelope fields: PostToolUse/PreToolUse/Stop input JSON,
#                  TeammateIdle/TaskCreated/TaskCompleted/TaskUpdate payloads,
#                  PostToolUseFailure (.error/.is_interrupt/.tool_response.*),
#                  CC env vars (_deepwork_instance) — not state.json.
#   [hook-output]  CC hook output schema fields (hookSpecificOutput.*) —
#                  written to stdout, not state.json.
#   [task]         Team-overlord task object fields (id/owner/status/subject/
#                  metadata/blockedBy/etc.) read from ~/.claude/tasks/*.json,
#                  not state.json.
#   [pending]      pending-change.json fields (plan_section/files/rationale/
#                  no_test_reason/change_id) — non-state runtime file.
#   [test-result]  test-results.jsonl entry fields (passed_count/failed_count/
#                  flaky_suspected/duration_ms/stdout_tail/stderr_tail/etc.)
#                  written by retest-dispatch.sh, not state.json.
#   [incident]     incidents.jsonl / discoveries.jsonl internal objects.
#   [config]       Non-state config file fields: frontmatter-backfill config,
#                  hook-manifest.json (hooks/Stop/matcher/event/etc.).
#   [state-extra]  Fields written to state.json by setup-deepwork.sh and the
#                  state-transition.sh init/replay paths but not declared in
#                  the partial state-schema.json (which is a minimal spec
#                  of declaratively-managed fields, not exhaustive).
#                  This includes: instance_id, session_id, team_name, goal,
#                  phase, frontmatter_schema_version, event_head, last_updated,
#                  state_integrity_hash (alias integrity_hash), feature flags
#                  (batch_gate_enabled, execute.scope_gate_strict), and
#                  change_log/test_manifest entry sub-fields.
#   [event-log]    events.jsonl entry fields (event_id/event_type/payload/
#                  prev_event_hash) — append-only log, not state.json.
#   [literal]      Bash-grep false positives: regex literals, file extensions,
#                  internal vars (md, jq_path), placeholder X used in tests.
#   [other]        Cross-plugin references (_other_plugin) and sentinels
#                  that don't fit a more specific category.
#
# Each entry below is filed under the category prefixed in the leading `#` line.
# Lines beginning with `# [` are category section markers (no semantic effect).
EXEMPT_PREFIXES="
# [hook-input] PreToolUse / PostToolUse / Stop / SessionStart envelope
session_id
tool_name
tool_input
tool_result
tool_use_id
tool_calls
tool_response.data.file_path
tool_response.data.interrupted
tool_response.data.stderr
tool_response.data.stdout
stop_hook_active
transcript_path
is_interrupt
error
# [hook-input] TeammateIdle / TaskCreated / TaskUpdate / TaskCompleted envelope
agent_id
task_id
task_subject
task_description
teammate_name
# [hook-input] CC-injected env / instance hints
_deepwork_instance

# [hook-output] CC hookSpecificOutput stdout schema (PreToolUse / SessionStart / PermissionRequest)
hookSpecificOutput.additionalContext
hookSpecificOutput.hookEventName
hookSpecificOutput.permissionDecision
hookSpecificOutput.permissionDecisionReason
hookSpecificOutput.watchPaths

# [task] Team-overlord task object fields
owner
status
subject
taskId
id
metadata
artifact
artifact_type
bar_id
cross_check_required
scope_items
scope_strict

# [pending] pending-change.json fields
change_id
plan_section
files
rationale
no_test_reason

# [test-result] test-results.jsonl entry fields written by retest-dispatch.sh
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
last_result
last_run_at

# [incident] incidents.jsonl / discoveries.jsonl entry fields
event
rule
source
source_file
incident_ref
ref
type
result
resolution
reason
banner_type

# [config] hook-manifest.json + frontmatter-backfill config + setup snapshots
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
current_version
setup_flags_snapshot

# [state-extra] state.json fields written by setup/init/replay but not in declarative schema
instance_id
team_name
bar
goal
mode
phase
plan
scope
wave
last_updated
frontmatter_schema_version
integrity_hash
override_reason
commit_sha
verdict
critic_verdict
merged_at
batch_gate_enabled
execute.scope_gate_strict
source_of_truth
content
path
file_path

# [event-log] events.jsonl entry fields (append-only log, not state.json)
event_head
event_id
event_type
prev_event_hash
payload

# [literal] Bash-grep false positives: regex literals / file extensions / internal vars / placeholders
n
k
idx
i
ts
fp
sh
md
jq_path
tool
elapsed_ms
blocked
custom_e2e
custom_field
X

# [other] Cross-plugin schema references and sentinels
_other_plugin
"

_is_exempt() {
  local p="$1"
  # Strip array projections before prefix matching
  local pbare="${p//\[\]/}"
  local ex
  while IFS= read -r ex; do
    # Skip blank lines and category headers (any line starting with `#`).
    [[ -z "$ex" ]] && continue
    [[ "$ex" == \#* ]] && continue
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
