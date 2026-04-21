#!/bin/bash
# execute/completion.sh — Execute-mode completion criterion.
#
# Returns 0 (complete) when all of the following hold:
#   1. state.json.execute.phase == "halt"
#   2. All change_log entries have critic_verdict == "APPROVED"
#   3. plan_drift_detected == false
#
# Returns non-zero otherwise, with a reason written to stderr.
# Used by swarm-loop profiles/deepplan/completion.sh pattern as precedent (line 32),
# but execute mode is phase-gated not promise-gated — no perl promise extraction.
#
# Environment:
#   STATE_FILE — path to instance state.json (set by caller, or derived from INSTANCE_DIR)
#   INSTANCE_DIR — absolute path to instance directory (fallback for STATE_FILE)

set +e

# Resolve state file
if [[ -z "$STATE_FILE" ]]; then
  if [[ -n "$INSTANCE_DIR" ]]; then
    STATE_FILE="${INSTANCE_DIR}/state.json"
  else
    echo "completion.sh: STATE_FILE or INSTANCE_DIR not set" >&2
    exit 1
  fi
fi

if [[ ! -f "$STATE_FILE" ]]; then
  echo "completion.sh: state file not found: ${STATE_FILE}" >&2
  exit 1
fi

# Check 1: execute phase must be "halt"
phase=$(jq -r '.execute.phase // "unknown"' "$STATE_FILE" 2>/dev/null)
if [[ "$phase" != "halt" ]]; then
  echo "completion.sh: execute phase is '${phase}', not 'halt'" >&2
  exit 2
fi

# Check 2: plan_drift_detected must be false
drift=$(jq -r '.execute.plan_drift_detected // false' "$STATE_FILE" 2>/dev/null)
if [[ "$drift" == "true" ]]; then
  echo "completion.sh: plan_drift_detected is true — drift must be resolved before completion" >&2
  exit 3
fi

# Check 3: all change_log entries must have critic_verdict == "APPROVED"
pending_count=$(jq '
  (.execute.change_log // [])
  | map(select(.critic_verdict != "APPROVED"))
  | length
' "$STATE_FILE" 2>/dev/null)

if [[ -z "$pending_count" ]]; then
  echo "completion.sh: could not read change_log from state" >&2
  exit 4
fi

if [[ "$pending_count" -gt 0 ]]; then
  echo "completion.sh: ${pending_count} change_log entries do not have verdict APPROVED" >&2
  exit 5
fi

# All checks passed
exit 0
