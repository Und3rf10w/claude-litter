#!/bin/bash
# task-scope-gate.sh — TaskCreated hook for execute-mode scope enforcement.
#
# Fires on all TaskCreated events. Checks whether the new task's subject/description
# falls within the approved plan scope (as defined in state.execute.plan_ref). If the
# task appears to introduce scope expansion not covered by the plan, it is rejected
# via exit 2 and a discovery entry is appended to discoveries.jsonl.
#
# Scope classification uses keyword matching against the plan file content:
# - If any significant noun/verb from the task subject appears in the plan, allow.
# - If the task subject appears to reference work not mentioned in the plan, block.
# - Fail-open on ambiguity (exit 0) — a false negative is safer than blocking legitimate work.
#
# Per plan §7: out-of-scope discoveries are appended to ${INSTANCE_DIR}/discoveries.jsonl
# with type=scope-delta and proposed_outcome=escalate, directing to /deepwork-execute-amend.
#
# CC source: cli_formatted_2.1.116.js:51984 (TaskCreated in event enum),
# :265837 (TaskCreated hook schema — stdin fields: task_id, task_subject, task_description, team_name?, teammate_name? — no metadata),
# :564690 (exit 2 → blockingError).
# Fail-open if no active execute instance.

set +e

command -v jq >/dev/null 2>&1 || exit 0

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"
_parse_hook_input

discover_instance "$SESSION_ID" 2>/dev/null || exit 0

# Only active execute instances
EXEC_PHASE=$(jq -r '.execute.phase // ""' "$STATE_FILE" 2>/dev/null || echo "")
[[ -n "$EXEC_PHASE" ]] || exit 0

TASK_ID=$(printf '%s' "$INPUT" | jq -r '.task_id // ""' 2>/dev/null || echo "")
TASK_SUBJECT=$(printf '%s' "$INPUT" | jq -r '.task_subject // ""' 2>/dev/null || echo "")
TASK_DESC=$(printf '%s' "$INPUT" | jq -r '.task_description // ""' 2>/dev/null || echo "")
TEAM_NAME=$(printf '%s' "$INPUT" | jq -r '.team_name // ""' 2>/dev/null || echo "")

# Read task metadata from task file (W11 H7: not from hook INPUT — no metadata in v2.1.118 schema)
TASK_SCOPE=""
if [[ -n "$TEAM_NAME" && -n "$TASK_ID" ]]; then
  if _load_task_file "$TEAM_NAME" "$TASK_ID" 2>/dev/null; then
    TASK_SCOPE=$(printf '%s' "$TASK_JSON" | jq -r '.metadata.scope // ""' 2>/dev/null || echo "")
  fi
fi

[[ -n "$TASK_SUBJECT" ]] || exit 0

PLAN_REF=$(jq -r '.execute.plan_ref // ""' "$STATE_FILE" 2>/dev/null || echo "")

# If no plan_ref, fail-open — cannot check scope without a plan
[[ -n "$PLAN_REF" ]] || exit 0
[[ -f "$PLAN_REF" ]] || exit 0

# Read plan content for scope matching
PLAN_CONTENT=$(cat "$PLAN_REF" 2>/dev/null || echo "")
[[ -n "$PLAN_CONTENT" ]] || exit 0

# Scope check: extract meaningful words from task subject (4+ chars, not common stop words)
STOP_WORDS="this that with from have will make into what when where"
SUBJECT_WORDS=()
while IFS= read -r _word; do
  _word_lower=$(printf '%s' "$_word" | tr '[:upper:]' '[:lower:]' | tr -cd '[:alpha:]')
  [[ ${#_word_lower} -lt 4 ]] && continue
  printf '%s' "$STOP_WORDS" | grep -qw "$_word_lower" && continue
  SUBJECT_WORDS+=("$_word_lower")
done <<< "$(printf '%s' "$TASK_SUBJECT" | tr ' /:.,;()[]' '\n')"

# If no significant words extracted, fail-open
[[ ${#SUBJECT_WORDS[@]} -eq 0 ]] && exit 0

# Check if any significant words appear in the plan content
PLAN_LOWER=$(printf '%s' "$PLAN_CONTENT" | tr '[:upper:]' '[:lower:]')
MATCH_COUNT=0
for _w in "${SUBJECT_WORDS[@]}"; do
  printf '%s' "$PLAN_LOWER" | grep -q "$_w" && MATCH_COUNT=$((MATCH_COUNT + 1))
done

# Require at least one significant word match in the plan
# If metadata.scope is explicitly set, also check it against plan content
SCOPE_MATCH=true
if [[ -n "$TASK_SCOPE" ]]; then
  SCOPE_LOWER=$(printf '%s' "$TASK_SCOPE" | tr '[:upper:]' '[:lower:]')
  if ! printf '%s' "$PLAN_LOWER" | grep -q "$SCOPE_LOWER"; then
    SCOPE_MATCH=false
  fi
fi

if [[ $MATCH_COUNT -eq 0 ]] || [[ "$SCOPE_MATCH" == "false" ]]; then
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Append discovery entry
  DISCOVERY_ENTRY=$(jq -n \
    --arg ts "$TS" \
    --arg task_id "$TASK_ID" \
    --arg subject "$TASK_SUBJECT" \
    --arg scope "$TASK_SCOPE" \
    '{
      timestamp: $ts,
      type: "scope-delta",
      task_id: $task_id,
      task_subject: $subject,
      metadata_scope: $scope,
      proposed_outcome: "escalate",
      note: "Task subject does not match approved plan scope. Use /deepwork-execute-amend to extend the plan before creating this task."
    }' 2>/dev/null)

  if [[ -n "$DISCOVERY_ENTRY" ]]; then
    printf '%s\n' "$DISCOVERY_ENTRY" >> "${INSTANCE_DIR}/discoveries.jsonl"
  fi

  printf 'BLOCKED (scope-gate): task "%s" does not appear to be within the approved plan scope at %s.\n' "$TASK_SUBJECT" "$PLAN_REF" >&2
  printf 'No significant words from the task subject were found in the plan.\n' >&2
  printf 'Use /deepwork-execute-amend to extend the approved scope before creating this task.\n' >&2
  printf 'Discovery logged to %s/discoveries.jsonl (type=scope-delta, proposed_outcome=escalate).\n' "$INSTANCE_DIR" >&2
  exit 2
fi

exit 0
