#!/bin/bash
# wave-gate.sh — Teammate phase-authority gate on TaskCreated.
#
# Prevents teammates from creating tasks for phases they don't own.
#
# INPUT SHAPE (verified via logging probe before implementation):
#   Confirmed fields from CC source cli_formatted_2.1.116.js:265837 and live probe:
#     task_id, task_subject, task_description, metadata.*
#   Also present (same team-event pattern as TaskCompleted/TaskUpdated):
#     teammate_name — actor identity (may be absent on orchestrator-originated tasks)
#     team_name     — team anchor used for instance discovery
#   Fallback: if teammate_name is absent, read task file owner field by task_id.
#   If actor identity cannot be determined: fail-open (exit 0).
#
# Authority model:
#   - Orchestrator/team-lead (teammate_name == "team-lead" or empty) → allowed any phase.
#   - Teammates → task metadata.wave must match the active phase:
#       design mode:  state.phase
#       execute mode: state.execute.phase
#   - No metadata.wave on teammate-originated task → MISSING_WAVE_METADATA (block, exit 2)
#   - metadata.wave != active phase, no override_reason → WAVE_MISMATCH (block, exit 2)
#   - metadata.wave != active phase, with override_reason → WAVE_OVERRIDE (allow + audit)
#
# Exit conventions (hooks.ts:236):
#   0 — allow / fail-open
#   2 — block (stderr shown to teammate)
#
# Fail-open conditions: malformed state, no active instance, actor identity unavailable.

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

TEAM_NAME=$(printf '%s' "$INPUT" | jq -r '.team_name // ""' 2>/dev/null || echo "")
TASK_ID=$(printf '%s' "$INPUT" | jq -r '.task_id // ""' 2>/dev/null || echo "")
TEAMMATE=$(printf '%s' "$INPUT" | jq -r '.teammate_name // ""' 2>/dev/null || echo "")

# Need a team_name to find the instance
[[ -n "$TEAM_NAME" ]] || exit 0

if ! discover_instance_by_team_name "$TEAM_NAME" 2>/dev/null; then
  exit 0
fi

# Read state — fail-open on unreadable/malformed
STATE_CONTENT=$(cat "$STATE_FILE" 2>/dev/null) || exit 0
printf '%s' "$STATE_CONTENT" | jq -e . >/dev/null 2>&1 || exit 0

# Determine active phase: execute mode takes precedence
PHASE_EXEC=$(printf '%s' "$STATE_CONTENT" | jq -r '.execute.phase // ""' 2>/dev/null || echo "")
PHASE_TOP=$(printf '%s' "$STATE_CONTENT" | jq -r '.phase // ""' 2>/dev/null || echo "")

if [[ -n "$PHASE_EXEC" ]]; then
  ACTIVE_PHASE="$PHASE_EXEC"
  PHASE_SOURCE="execute"
elif [[ -n "$PHASE_TOP" ]]; then
  ACTIVE_PHASE="$PHASE_TOP"
  PHASE_SOURCE="design"
else
  exit 0
fi

# Actor identity resolution:
# 1. teammate_name from input
# 2. owner field from task file
# 3. fail-open if neither available
ACTOR="$TEAMMATE"

if [[ -z "$ACTOR" ]] && [[ -n "$TASK_ID" ]]; then
  SANITIZED_TEAM=$(printf '%s' "$TEAM_NAME" | sed 's/[^a-zA-Z0-9_-]/-/g')
  TASK_DIR="$HOME/.claude/tasks/${SANITIZED_TEAM}"
  TASK_ID_SAFE=$(printf '%s' "$TASK_ID" | sed 's/[^a-zA-Z0-9_-]/_/g')
  TASK_FILE="${TASK_DIR}/${TASK_ID_SAFE}.json"
  if [[ -f "$TASK_FILE" ]]; then
    ACTOR=$(jq -r '.owner // ""' "$TASK_FILE" 2>/dev/null || echo "")
  fi
fi

# If actor identity still unknown, fail-open
[[ -n "$ACTOR" ]] || exit 0

# Orchestrator/team-lead bypass — allowed to create tasks for any phase
if [[ "$ACTOR" == "team-lead" ]] || [[ "$ACTOR" == "orchestrator" ]]; then
  exit 0
fi

# Read task metadata
WAVE=$(printf '%s' "$INPUT" | jq -r '.metadata.wave // ""' 2>/dev/null || echo "")
OVERRIDE_REASON=$(printf '%s' "$INPUT" | jq -r '.metadata.override_reason // ""' 2>/dev/null || echo "")

# MISSING_WAVE_METADATA: teammate created a task without metadata.wave
if [[ -z "$WAVE" ]]; then
  printf 'wave-gate MISSING_WAVE_METADATA: teammate=%s created task without metadata.wave.\n' "$ACTOR" >&2
  printf 'Set metadata.wave to the phase this task belongs to (active phase: %s/%s).\n' "$PHASE_SOURCE" "$ACTIVE_PHASE" >&2
  printf 'Only orchestrator/team-lead may create tasks without metadata.wave.\n' >&2
  exit 2
fi

# If wave matches active phase, allow
if [[ "$WAVE" == "$ACTIVE_PHASE" ]]; then
  exit 0
fi

# WAVE_MISMATCH with override_reason: allow + audit entry
if [[ -n "$OVERRIDE_REASON" ]]; then
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  printf '> ⚠️ wave-gate override: teammate=%s task=%s wave=%s active_phase=%s reason=%s (%s)\n' \
    "$ACTOR" "$TASK_ID" "$WAVE" "$ACTIVE_PHASE" "$OVERRIDE_REASON" "$TS" \
    >> "$LOG_FILE" 2>/dev/null || true
  exit 0
fi

# WAVE_MISMATCH: wave != active phase, no override
printf 'wave-gate WAVE_MISMATCH: teammate=%s task=%s wave=%s != active_phase=%s (%s mode).\n' \
  "$ACTOR" "$TASK_ID" "$WAVE" "$ACTIVE_PHASE" "$PHASE_SOURCE" >&2
printf 'Teammates may only create tasks for the current active phase.\n' >&2
printf 'To override, set metadata.override_reason with a justification.\n' >&2
exit 2
