#!/bin/bash

# Swarm Loop Stop Hook
# The heartbeat of the swarm-loop system.
# On each Stop event, this hook:
#   1. Reads structured state from .claude/swarm-loop.local.state.json
#   2. Checks if the completion promise was fulfilled
#   3. Runs verification if promise detected
#   4. Checks for sentinel file (.claude/swarm-loop.local.next-iteration)
#      - Sentinel present: consume it and re-inject orchestrator prompt
#      - Sentinel absent + stop_hook_active=true: allow idle (prevents starving teammate messages)
#      - Sentinel absent + stop_hook_active=false: check for timeout, force re-inject if exceeded
#   5. Sentinel timeout: if no sentinel after sentinel_timeout seconds AND hook wasn't already
#      blocking, force re-inject with a timeout warning message

set -euo pipefail

# Require jq — all state parsing depends on it
if ! command -v jq >/dev/null 2>&1; then
  echo "⚠️  Swarm loop: jq is required but not found — skipping stop hook" >&2
  exit 0
fi

# Read hook input from stdin
HOOK_INPUT=$(cat)

STATE_FILE=".claude/swarm-loop.local.state.json"
LOG_FILE=".claude/swarm-loop.local.log.md"
SENTINEL=".claude/swarm-loop.local.next-iteration"

# Read stop_hook_active — true if the hook already blocked on the previous turn.
# Used to prevent sentinel timeout from re-firing immediately after a forced re-inject,
# which would starve teammate message delivery during MONITOR.
STOP_HOOK_ACTIVE=$(echo "$HOOK_INPUT" | jq -r '.stop_hook_active // false')

# Clean up orphaned temp files on unexpected exit
trap 'rm -f "${STATE_FILE}.tmp.$$" ".claude/settings.local.json.tmp.$$"' EXIT

# If this is a subagent/teammate (not the orchestrator), do not interfere.
# Plugin Stop hooks are converted to SubagentStop for teammates — bail out early.
HOOK_AGENT_ID=$(echo "$HOOK_INPUT" | jq -r '.agent_id // ""')
if [[ -n "$HOOK_AGENT_ID" ]]; then
  exit 0
fi

# No active swarm loop — allow exit
if [[ ! -f "$STATE_FILE" ]]; then
  exit 0
fi

# Read and cache the state file to avoid repeated disk reads
STATE_JSON=$(cat "$STATE_FILE" 2>/dev/null)

# Guard against empty or corrupt state file — if jq can't parse it, clean up and exit
if [[ -z "$STATE_JSON" ]] || ! echo "$STATE_JSON" | jq empty 2>/dev/null; then
  echo "⚠️  Swarm loop: State file is empty or corrupt — cleaning up" >&2
  rm -f "$STATE_FILE"
  exit 0
fi

# Session isolation: only the session that started the loop should be looped
STATE_SESSION=$(echo "$STATE_JSON" | jq -r '.session_id // ""')
HOOK_SESSION=$(echo "$HOOK_INPUT" | jq -r '.session_id // ""')

# A session_id starting with "swarm-" is a generated placeholder from setup
# (CLAUDE_CODE_SESSION_ID was unavailable). Replace it with the real session_id.
IS_PLACEHOLDER=false
if [[ "$STATE_SESSION" == swarm-* ]]; then
  IS_PLACEHOLDER=true
fi

if { [[ -z "$STATE_SESSION" ]] || [[ "$IS_PLACEHOLDER" == true ]]; } && [[ -n "$HOOK_SESSION" ]]; then
  # Backfill: lock the loop to the first session that triggers the hook.
  TEMP_FILE="${STATE_FILE}.tmp.$$"
  jq --arg sid "$HOOK_SESSION" '.session_id = $sid' "$STATE_FILE" > "$TEMP_FILE"
  if [[ -s "$TEMP_FILE" ]]; then
    mv "$TEMP_FILE" "$STATE_FILE"
  else
    rm -f "$TEMP_FILE"
  fi
  STATE_SESSION="$HOOK_SESSION"
  # Re-cache after update
  STATE_JSON=$(cat "$STATE_FILE" 2>/dev/null)
elif [[ -n "$STATE_SESSION" ]] && [[ "$IS_PLACEHOLDER" == false ]] && [[ "$STATE_SESSION" != "$HOOK_SESSION" ]]; then
  exit 0
fi

# Read state fields from cached content
ITERATION=$(echo "$STATE_JSON" | jq -r '.iteration // 1')
COMPLETION_PROMISE=$(echo "$STATE_JSON" | jq -r '.completion_promise // ""')
SOFT_BUDGET=$(echo "$STATE_JSON" | jq -r '.soft_budget // 10')
GOAL=$(echo "$STATE_JSON" | jq -r '.goal // ""')
TEAM_NAME=$(echo "$STATE_JSON" | jq -r '.team_name // ""')

# Sanitize user-supplied values to prevent shell expansion in heredocs/double-quoted strings.
# Only GOAL and COMPLETION_PROMISE come from user input; other fields are setup-controlled.
_sanitize() { printf '%s' "$1" | sed 's/[$`\\!]/\\&/g'; }
GOAL_SAFE=$(_sanitize "$GOAL")
PROMISE_SAFE=$(_sanitize "$COMPLETION_PROMISE")
TEAMMATES_ISOLATION=$(echo "$STATE_JSON" | jq -r '.teammates_isolation // "shared"')
TEAMMATES_MAX_COUNT=$(echo "$STATE_JSON" | jq -r '.teammates_max_count // 8')
PERMISSION_FAILURES=$(echo "$STATE_JSON" | jq '[.permission_failures[]?] | length' 2>/dev/null || echo "0")
AUTONOMY_HEALTH=$(echo "$STATE_JSON" | jq -r '.autonomy_health // "healthy"')
SENTINEL_TIMEOUT=$(echo "$STATE_JSON" | jq -r '.sentinel_timeout // 300')

# Load profile
MODE=$(echo "$STATE_JSON" | jq -r '.mode // "default"')
_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/profile-lib.sh"
load_profile "$MODE" "$_PLUGIN_ROOT"
MODE="$RESOLVED_MODE"

# Source profile scripts
source "${PROFILE_DIR}/completion.sh"
source "${PROFILE_DIR}/reinject.sh"

# Normalize promise whitespace to match the perl extraction normalization (trim + collapse)
if [[ -n "$COMPLETION_PROMISE" ]]; then
  COMPLETION_PROMISE=$(echo "$COMPLETION_PROMISE" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//;s/[[:space:]]\{1,\}/ /g')
fi

# Validate iteration is numeric
if [[ ! "$ITERATION" =~ ^[0-9]+$ ]]; then
  echo "⚠️  Swarm loop: State file corrupted (iteration='$ITERATION')" >&2
  echo "   Cleaning up and stopping." >&2
  rm -f "$STATE_FILE"
  exit 0
fi

# Get the last assistant message — use the new Stop hook API field if available,
# fall back to transcript parsing
LAST_OUTPUT=$(echo "$HOOK_INPUT" | jq -r '.last_assistant_message // ""')

if [[ -z "$LAST_OUTPUT" ]]; then
  # Fallback: read from transcript (best-effort — format may vary across versions).
  # WARNING: This scans the full transcript and returns the last assistant text block.
  # On long transcripts, this could match an older message containing a <promise> tag
  # from a previous iteration. The primary last_assistant_message field (above) is the
  # reliable path; this fallback exists only for older Claude Code versions that lack it.
  TRANSCRIPT_PATH=$(echo "$HOOK_INPUT" | jq -r '.transcript_path // ""')
  if [[ -n "$TRANSCRIPT_PATH" ]] && [[ -f "$TRANSCRIPT_PATH" ]]; then
    LAST_LINES=$(grep -E '"role"\s*:\s*"assistant"' "$TRANSCRIPT_PATH" | tail -n 100)
    if [[ -n "$LAST_LINES" ]]; then
      set +e
      # Try both possible content paths — .message.content and .content
      LAST_OUTPUT=$(echo "$LAST_LINES" | jq -rs '
        map(
          (.message.content[]? // .content[]?) | select(.type == "text") | .text
        ) | last // ""
      ' 2>/dev/null)
      set -e
    fi
  fi
fi

# Delegate completion detection to profile
COMPLETION_DETECTED="false"
COMPLETION_BLOCK_REASON=""
check_completion

if [[ "$COMPLETION_DETECTED" == "true" ]]; then
  # Promise verified — do final cleanup (this stays in stop-hook, not in profile)
  printf '✅ Swarm loop: Completion promise verified! <promise>%s</promise>\n' "$COMPLETION_PROMISE"

  # Final log entry
  echo "" >> "$LOG_FILE"
  echo "---" >> "$LOG_FILE"
  echo "" >> "$LOG_FILE"
  echo "## ✅ COMPLETED — Iteration $ITERATION" >> "$LOG_FILE"
  echo "" >> "$LOG_FILE"
  printf 'Completion promise verified: `%s`\n' "$COMPLETION_PROMISE" >> "$LOG_FILE"
  echo "Finished at: $(date -u +%Y-%m-%dT%H:%M:%SZ)" >> "$LOG_FILE"

  rm -f "$STATE_FILE"
  rm -f .claude/swarm-loop.local.verify.sh
  rm -f .claude/swarm-loop.local.heartbeat.json
  rm -f "$SENTINEL"

  # Clean up deepplan intermediate files (preserve .claude/deepplan.local.plan.md)
  if [[ "$MODE" == "deepplan" ]]; then
    rm -f .claude/deepplan.local.findings.arch.md
    rm -f .claude/deepplan.local.findings.files.md
    rm -f .claude/deepplan.local.findings.risk.md
    rm -f .claude/deepplan.local.draft.md
    rm -f .claude/deepplan.local.critique.pragmatist.md
    rm -f .claude/deepplan.local.critique.strategist.md
  fi

  # Restore original settings.local.json from backup
  SETTINGS_LOCAL=".claude/settings.local.json"
  if [[ -f "${SETTINGS_LOCAL}.swarm-backup" ]]; then
    mv "${SETTINGS_LOCAL}.swarm-backup" "$SETTINGS_LOCAL"
  elif [[ -f "$SETTINGS_LOCAL" ]]; then
    jq '
      .permissions.allow = ([.permissions.allow[]? | select(test("swarm-loop|deepplan") | not)] | unique) |
      if .hooks then
        .hooks |= with_entries(
          .value = [.value[]? | select(._swarm != true)] |
          select(.value | length > 0)
        ) |
        if (.hooks | length) == 0 then del(.hooks) else . end
      else . end
    ' "$SETTINGS_LOCAL" > "${SETTINGS_LOCAL}.tmp.$$"
    if [[ -s "${SETTINGS_LOCAL}.tmp.$$" ]]; then
      mv "${SETTINGS_LOCAL}.tmp.$$" "$SETTINGS_LOCAL"
    else
      rm -f "${SETTINGS_LOCAL}.tmp.$$"
    fi
  fi

  exit 0
fi

if [[ -n "$COMPLETION_BLOCK_REASON" ]]; then
  # Profile wants to block with feedback (e.g., verification failure, plan rejection).
  # Some profiles (default) already update state before setting COMPLETION_BLOCK_REASON;
  # others (deepplan rejected) do not. Check if the profile already incremented iteration
  # to avoid double-incrementing, but ensure state is always reset before re-inject.
  CURRENT_ITER=$(jq -r '.iteration // 0' "$STATE_FILE" 2>/dev/null || echo "0")
  if [[ "$CURRENT_ITER" == "$ITERATION" ]]; then
    # Profile did not update state — do it now
    _TEMP="${STATE_FILE}.tmp.$$"
    jq --argjson iter "$((ITERATION + 1))" \
       --arg phase "working" \
       --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
       '.iteration = $iter | .phase = $phase | .last_updated = $now' \
       "$STATE_FILE" > "$_TEMP"
    if [[ -s "$_TEMP" ]]; then
      mv "$_TEMP" "$STATE_FILE"
    else
      rm -f "$_TEMP"
    fi
  fi
  jq -n \
    --arg reason "$COMPLETION_BLOCK_REASON" \
    --arg msg "🔄 Swarm iteration $((ITERATION + 1)) | Verification failed" \
    '{"decision": "block", "reason": $reason, "systemMessage": $msg}'
  exit 0
fi

# Sentinel check: consume sentinel to trigger re-inject, or allow idle for teammate messages
STUCK_TIMEOUT_MSG=""
if [[ -f "$SENTINEL" ]]; then
  rm -f "$SENTINEL"
  # Fall through to build orchestrator prompt and block
else
  # No sentinel present.
  # If the hook already blocked on the previous turn (stop_hook_active=true),
  # skip the timeout check and allow idle. This prevents the sentinel timeout
  # from re-firing immediately after a forced re-inject, which would starve
  # teammate message delivery during MONITOR.
  FORCE_REINJECT=false
  STUCK_TIMEOUT_MSG=""
  if [[ "$STOP_HOOK_ACTIVE" != "true" ]] && [[ "$SENTINEL_TIMEOUT" =~ ^[0-9]+$ ]] && [[ "$SENTINEL_TIMEOUT" -gt 0 ]]; then
    LAST_UPDATE=$(echo "$STATE_JSON" | jq -r '.last_updated // .started_at // ""')
    if [[ -n "$LAST_UPDATE" ]] && [[ "$LAST_UPDATE" != "null" ]]; then
      # Parse ISO 8601 timestamp to epoch seconds
      LAST_UPDATE_SECS=$(date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$LAST_UPDATE" +%s 2>/dev/null \
        || date -u -d "$LAST_UPDATE" +%s 2>/dev/null \
        || echo "")
      if [[ -n "$LAST_UPDATE_SECS" ]]; then
        NOW_SECS=$(date +%s)
        AGE_SECS=$((NOW_SECS - LAST_UPDATE_SECS))
        if [[ $AGE_SECS -gt $SENTINEL_TIMEOUT ]]; then
          echo "⚠️  Swarm loop: No sentinel after ${AGE_SECS}s (timeout=${SENTINEL_TIMEOUT}s). Forcing re-inject." >&2
          FORCE_REINJECT=true
          STUCK_TIMEOUT_MSG="
⚠️ SENTINEL TIMEOUT: The orchestrator has not signaled readiness for the next iteration in ${AGE_SECS} seconds (timeout=${SENTINEL_TIMEOUT}s).
This usually means the orchestrator is still waiting for teammate messages, or got stuck.
If teammates are still working, continue monitoring. If you are ready to proceed, Write .claude/swarm-loop.local.next-iteration (Write tool, empty content)."
        fi
      fi
    fi
  fi

  if [[ "$FORCE_REINJECT" != "true" ]]; then
    # Allow idle — teammates may still be delivering messages.
    # Write heartbeat with team_active status.
    # Read progress from progress_history (v2 — tasks are in native system, not state file)
    LAST_PROGRESS=$(echo "$STATE_JSON" | jq '.progress_history[-1] // {}' 2>/dev/null)
    TASKS_COMPLETED=$(echo "$LAST_PROGRESS" | jq '.tasks_completed // 0' 2>/dev/null || echo "0")
    TASKS_TOTAL=$(echo "$LAST_PROGRESS" | jq '.tasks_total // 0' 2>/dev/null || echo "0")
    jq -n \
      --argjson iteration "$ITERATION" \
      --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
      --argjson tasks_completed "$TASKS_COMPLETED" \
      --argjson tasks_total "$TASKS_TOTAL" \
      --arg phase "team_active" \
      --arg last_tool "stop-hook" \
      --arg goal "$GOAL" \
      --arg team_name "$TEAM_NAME" \
      --arg autonomy_health "$AUTONOMY_HEALTH" \
      --argjson permission_failure_count "$PERMISSION_FAILURES" \
      --argjson sentinel_timeout "$SENTINEL_TIMEOUT" \
      '{iteration: $iteration, timestamp: $timestamp, tasks_completed: $tasks_completed, tasks_total: $tasks_total, phase: $phase, last_tool: $last_tool, goal: $goal, team_name: $team_name, team_active: true, autonomy_health: $autonomy_health, permission_failure_count: $permission_failure_count, sentinel_timeout: $sentinel_timeout}' \
      > .claude/swarm-loop.local.heartbeat.json 2>/dev/null || true
    exit 0
  fi
fi

# Not complete — continue the loop
NEXT_ITERATION=$((ITERATION + 1))

# Write heartbeat file for external monitoring (CI, watch scripts, dashboards)
# Read progress from progress_history (v2 — tasks are in native system, not state file)
LAST_PROGRESS_RE=$(echo "$STATE_JSON" | jq '.progress_history[-1] // {}' 2>/dev/null)
TASKS_COMPLETED=$(echo "$LAST_PROGRESS_RE" | jq '.tasks_completed // 0' 2>/dev/null || echo "0")
TASKS_TOTAL=$(echo "$LAST_PROGRESS_RE" | jq '.tasks_total // 0' 2>/dev/null || echo "0")
PHASE=$(echo "$STATE_JSON" | jq -r '.phase // "working"')
jq -n \
  --argjson iteration "$NEXT_ITERATION" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --argjson tasks_completed "$TASKS_COMPLETED" \
  --argjson tasks_total "$TASKS_TOTAL" \
  --arg phase "$PHASE" \
  --arg last_tool "stop-hook" \
  --arg goal "$GOAL" \
  --arg team_name "$TEAM_NAME" \
  --arg autonomy_health "$AUTONOMY_HEALTH" \
  --argjson permission_failure_count "$PERMISSION_FAILURES" \
  --argjson sentinel_timeout "$SENTINEL_TIMEOUT" \
  '{
    iteration: $iteration,
    timestamp: $timestamp,
    tasks_completed: $tasks_completed,
    tasks_total: $tasks_total,
    phase: $phase,
    last_tool: $last_tool,
    goal: $goal,
    team_name: $team_name,
    autonomy_health: $autonomy_health,
    permission_failure_count: $permission_failure_count,
    sentinel_timeout: $sentinel_timeout
  }' > .claude/swarm-loop.local.heartbeat.json 2>/dev/null || true

# Stuck detection: check if tasks_completed is unchanged across the last 3 iterations.
# unique count == 1 means all three values are identical (no progress). The select(. > 0)
# guard avoids false positives when history is sparse or all entries report zero tasks.
STUCK_MSG=""
if [[ $ITERATION -ge 3 ]]; then
  HISTORY_LEN=$(echo "$STATE_JSON" | jq -r '.progress_history | length' 2>/dev/null || echo "0")
  if [[ "$HISTORY_LEN" -ge 3 ]]; then
    PREV_COMPLETED=$(echo "$STATE_JSON" | jq -r '
      .progress_history[-3:] | map(.tasks_completed // 0) |
      if (map(select(. > 0)) | length) == 0 then 0
      else (unique | length) end
    ' 2>/dev/null || echo "0")
    if [[ "$PREV_COMPLETED" == "1" ]]; then
      STUCK_MSG="
⚠️ STUCK DETECTION: No task progress in the last 3 iterations. Consider:
  - Changing your decomposition strategy
  - Tackling a different subtask first
  - Simplifying the current approach
  - Investigating what's blocking progress"
    fi
  fi
fi

# Permission-specific escalation: if stuck AND permission failures exist
if [[ -n "$STUCK_MSG" ]] && [[ "$PERMISSION_FAILURES" -gt 0 ]]; then
  FAILURE_DETAILS=$(echo "$STATE_JSON" | jq -r '.permission_failures[]? | "  - [\(.iteration)] \(.teammate // "unknown"): \(.operation // "unknown")"' 2>/dev/null || echo "  (unable to read failure details)")
  STUCK_MSG="
⚠️ PERMISSION ESCALATION — The loop is stuck and permission blocks have been recorded.

Recent permission failures:
$FAILURE_DETAILS

Options:
  1. REDESIGN: Restructure blocked tasks to avoid the blocked operations.
     Common alternatives: use Edit/Write instead of Bash redirects,
     use git commit instead of git push, avoid downloading external code.
  2. EXPAND: If the blocked operation is legitimately needed, ask the user
     to add it to .claude/settings.local.json permissions.allow.
  3. SKIP: Mark the blocked task as 'blocked' with a reason and continue
     with other tasks.

Choose one of these approaches, update the state file, and continue."
fi

# Soft budget warning
BUDGET_MSG=""
if [[ $SOFT_BUDGET -gt 0 ]] && [[ $NEXT_ITERATION -eq $SOFT_BUDGET ]]; then
  BUDGET_MSG="
📊 CHECKPOINT (iteration $SOFT_BUDGET): Take stock of your progress.
  - How much of the goal is complete?
  - Is your current strategy working?
  - Should you pivot or continue?
  This is NOT a stop — just a moment to reflect."
fi

# Update state
TEMP_FILE="${STATE_FILE}.tmp.$$"
NOW_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq --argjson iter "$NEXT_ITERATION" \
   --arg phase "working" \
   --arg now "$NOW_TS" \
   '.iteration = $iter | .phase = $phase | .last_updated = $now' "$STATE_FILE" > "$TEMP_FILE"
if [[ -s "$TEMP_FILE" ]]; then
  mv "$TEMP_FILE" "$STATE_FILE"
else
  rm -f "$TEMP_FILE"
fi

# Build re-inject prompt via profile
COMPACT_MODE=$(echo "$STATE_JSON" | jq -r '.compact_on_iteration // false')
build_reinject_prompt
ORCHESTRATOR_PROMPT="$REINJECT_PROMPT"

# System message with iteration info
if [[ -n "$COMPLETION_PROMISE" ]] && [[ "$COMPLETION_PROMISE" != "null" ]]; then
  SYSTEM_MSG="🔄 Swarm iteration $NEXT_ITERATION | Promise: <promise>$PROMISE_SAFE</promise> when done"
else
  SYSTEM_MSG="🔄 Swarm iteration $NEXT_ITERATION"
fi

jq -n \
  --arg reason "$ORCHESTRATOR_PROMPT" \
  --arg msg "$SYSTEM_MSG" \
  '{"decision": "block", "reason": $reason, "systemMessage": $msg}'

exit 0
