#!/bin/bash
# pre-compact.sh — Injects swarm-loop orchestrator context into compaction
#
# Called by the PreCompact hook in hooks.json.
# Reads the swarm loop state file and outputs compact instructions that help
# the compacted context retain orchestrator knowledge.
#
# Exits 0 with stdout = custom compact instructions appended to default ones.
# Exits 2 = block compaction entirely (not used here).
# Subagent sessions are skipped (bail early on agent_id).

set -euo pipefail

# Require jq
if ! command -v jq >/dev/null 2>&1; then
  exit 0
fi

HOOK_INPUT=$(cat)

# Bail early if subagent — don't interfere with teammate compaction
HOOK_AGENT_ID=$(printf '%s' "$HOOK_INPUT" | jq -r '.agent_id // ""' 2>/dev/null || echo "")
if [[ -n "$HOOK_AGENT_ID" ]]; then
  exit 0
fi

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

HOOK_SESSION=$(printf '%s' "$HOOK_INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
if ! discover_instance "$HOOK_SESSION" 2>/dev/null; then
  exit 0
fi

# Read state
STATE_JSON=$(cat "$STATE_FILE" 2>/dev/null)
if [[ -z "$STATE_JSON" ]] || ! printf '%s' "$STATE_JSON" | jq empty 2>/dev/null; then
  exit 0
fi

GOAL=$(printf '%s' "$STATE_JSON" | jq -r '.goal // ""')
ITERATION=$(printf '%s' "$STATE_JSON" | jq -r '.iteration // 1')
PROMISE=$(printf '%s' "$STATE_JSON" | jq -r '.completion_promise // ""')
TEAM_NAME=$(printf '%s' "$STATE_JSON" | jq -r '.team_name // ""')
MODE=$(printf '%s' "$STATE_JSON" | jq -r '.mode // "default"')

# Count task statuses from task directory
SANITIZED_TEAM=$(printf '%s' "$TEAM_NAME" | sed 's/[^a-zA-Z0-9_-]/-/g')
TASK_DIR="$HOME/.claude/tasks/${SANITIZED_TEAM}"
TASKS_TOTAL=0
TASKS_COMPLETED=0
TASKS_IN_PROGRESS=0
TASKS_PENDING=0

if [[ -d "$TASK_DIR" ]]; then
  for tf in "${TASK_DIR}"/*.json; do
    [[ -f "$tf" ]] || continue
    TF_JSON=""
    for _retry in 1 2 3; do
      TF_JSON=$(jq '.' "$tf" 2>/dev/null) && break
      TF_JSON=""
      [[ $_retry -lt 3 ]] && sleep 0.05
    done
    [[ -z "$TF_JSON" ]] && continue
    tf_status=$(printf '%s' "$TF_JSON" | jq -r '.status // ""' 2>/dev/null || echo "")
    [[ "$tf_status" == "deleted" ]] && continue
    TASKS_TOTAL=$((TASKS_TOTAL + 1))
    case "$tf_status" in
      completed)    TASKS_COMPLETED=$((TASKS_COMPLETED + 1)) ;;
      in_progress)  TASKS_IN_PROGRESS=$((TASKS_IN_PROGRESS + 1)) ;;
      pending)      TASKS_PENDING=$((TASKS_PENDING + 1)) ;;
    esac
  done
fi

printf 'CRITICAL CONTEXT — SWARM LOOP ORCHESTRATOR:\n'
printf 'You are the swarm loop orchestrator (iteration %s, %s profile).\n' "$ITERATION" "$MODE"
printf 'Team: %s\n' "$TEAM_NAME"
printf 'Goal: %s\n' "$GOAL"
printf 'Completion Promise: %s\n' "$PROMISE"
printf 'Task Status: %s/%s completed, %s in progress, %s pending\n' \
  "$TASKS_COMPLETED" "$TASKS_TOTAL" "$TASKS_IN_PROGRESS" "$TASKS_PENDING"
printf 'State file: %s\n' "$STATE_FILE"
printf 'Log file: %s\n' "$LOG_FILE"
printf '\n'
printf 'Preserve all swarm orchestration context. After compaction, read the state and log files to recover full context.\n'

exit 0
