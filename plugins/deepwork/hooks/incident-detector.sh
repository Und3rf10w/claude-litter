#!/bin/bash
# incident-detector.sh — Auto-append guardrails to state.json on failure events.
#
# Implements principle 5 (institutional memory lives in prompts). When a teammate
# crashes or a permission is denied, we extract what happened and append a
# guardrail entry to state.json.guardrails[]. Subsequent teammate spawns render
# the updated list into their prompts.
#
# Wired by setup-deepwork.sh to:
#   - SubagentStop — fires after each teammate session ends (exit code in payload)
#   - PermissionDenied — fires when a permission was denied
#   - TeammateIdle — max-retries also appends a guardrail (done by teammate-idle-gate.sh itself)
#
# Invoked with: `bash incident-detector.sh --event <EventName>`
# Reads the hook payload from stdin.

set +e

command -v jq >/dev/null 2>&1 || exit 0

EVENT_NAME=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --event)
      EVENT_NAME="$2"
      shift 2
      ;;
    *)
      shift
      ;;
  esac
done

[[ -n "$EVENT_NAME" ]] || exit 0

INPUT=$(cat)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

# Discovery: for teammate-origin events, discover by team_name. For orchestrator-
# origin events (PermissionDenied in orchestrator session), discover by session_id.
TEAM_NAME=$(echo "$INPUT" | jq -r '.team_name // ""' 2>/dev/null || echo "")
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")

if [[ -n "$TEAM_NAME" ]]; then
  discover_instance_by_team_name "$TEAM_NAME" 2>/dev/null || exit 0
elif [[ -n "$SESSION_ID" ]]; then
  discover_instance "$SESSION_ID" 2>/dev/null || exit 0
else
  exit 0
fi

# Derive the guardrail rule from the event
RULE=""
SOURCE="incident"
INCIDENT_REF=""

case "$EVENT_NAME" in
  SubagentStop)
    EXIT_CODE=$(echo "$INPUT" | jq -r '.exit_code // 0' 2>/dev/null || echo "0")
    TEAMMATE_NAME=$(echo "$INPUT" | jq -r '.teammate_name // ""' 2>/dev/null || echo "")
    # Belt-and-suspenders sanitize (team names are already sanitized at TeamCreate;
    # this defends against future extensions that might allow teammate self-rename).
    TEAMMATE_NAME=$(printf '%s' "$TEAMMATE_NAME" | tr -cd 'a-zA-Z0-9_-' | head -c 64)
    # Only treat non-zero exits as incidents
    if [[ "$EXIT_CODE" == "0" ]] || [[ -z "$EXIT_CODE" ]]; then
      exit 0
    fi
    RULE="teammate '${TEAMMATE_NAME:-unknown}' exited with code ${EXIT_CODE}; if respawning, inspect the teammate's last SendMessage + transcript for the failure mode and add an explicit guard to the new spawn's stance"
    INCIDENT_REF="SubagentStop/${TEAMMATE_NAME:-unknown}/exit${EXIT_CODE}"
    ;;
  PermissionDenied)
    TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null || echo "unknown")
    TOOL_INPUT=$(echo "$INPUT" | jq -rc '.tool_input // {}' 2>/dev/null || echo "{}")
    # Truncate tool_input for the rule
    TOOL_INPUT_SHORT=$(printf '%s' "$TOOL_INPUT" | head -c 120)
    RULE="a ${TOOL_NAME} call was denied (input snippet: ${TOOL_INPUT_SHORT}); agents should not retry the same operation — either request permission escalation or propose an alternative"
    INCIDENT_REF="PermissionDenied/${TOOL_NAME}"
    ;;
  *)
    exit 0
    ;;
esac

[[ -n "$RULE" ]] || exit 0

# Append to incidents.jsonl (append-only, atomic via O_APPEND — no lock needed).
# Dedup on incident_ref: if the same ref is already present, skip the append.
# render_guardrails() consolidates state.json.guardrails[] + incidents.jsonl
# into the {{HARD_GUARDRAILS}} render, deduped by incident_ref.
NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
INCIDENTS_FILE="${INSTANCE_DIR}/incidents.jsonl"

# Dedup: quick grep for the literal incident_ref string
if [[ -f "$INCIDENTS_FILE" ]] && grep -Fq "\"incident_ref\":\"${INCIDENT_REF}\"" "$INCIDENTS_FILE" 2>/dev/null; then
  # Already recorded — skip
  exit 0
fi

# Compose the incident record and append atomically
INCIDENT_JSON=$(jq -cn --arg rule "$RULE" --arg src "$SOURCE" --arg ts "$NOW_TS" --arg ref "$INCIDENT_REF" \
  '{rule: $rule, source: $src, timestamp: $ts, incident_ref: $ref}')

if [[ -n "$INCIDENT_JSON" ]]; then
  printf '%s\n' "$INCIDENT_JSON" >> "$INCIDENTS_FILE" 2>/dev/null || true
fi

# Log for observability
printf '\n> ⚠️ Incident appended: %s (%s)\n' "$EVENT_NAME" "$INCIDENT_REF" \
  >> "$LOG_FILE" 2>/dev/null || true

exit 0
