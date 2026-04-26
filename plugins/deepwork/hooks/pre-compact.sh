#!/usr/bin/env bash
# hooks/pre-compact.sh — PreCompact hook: flushes a freshness stamp to state.json and
# log.md before compaction, then emits compact instructions for context retention.
#
# Registered statically in hooks/hooks.json (PreCompact; session-agnostic).
# Gracefully no-ops when no active deepwork session exists.
# Subagent sessions are skipped (bail on agent_id presence).
# Exit 0 always — never blocks compaction; flush failures silently degrade.

set +e

command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)

# Bail early if subagent — only orchestrator sessions get the flush
AGENT_ID=$(printf '%s' "$INPUT" | jq -r '.agent_id // ""' 2>/dev/null || echo "")
if [[ -n "$AGENT_ID" ]]; then
  exit 0
fi

_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
if ! discover_instance "$SESSION_ID" 2>/dev/null; then
  exit 0
fi

[[ -f "$STATE_FILE" ]] || exit 0

NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")
[[ -z "$NOW" ]] && exit 0

# Stamp last_updated and record audit entry via state-transition.sh
STATE_FILE="$STATE_FILE" bash "${_PLUGIN_ROOT}/scripts/state-transition.sh" merge \
  "{\"last_updated\":\"${NOW}\"}" 2>/dev/null || true
STATE_FILE="$STATE_FILE" bash "${_PLUGIN_ROOT}/scripts/state-transition.sh" \
  append_array .hook_warnings \
  "\"PreCompact fired at ${NOW} — state.json stamped\"" 2>/dev/null || true

# Append freshness marker to log.md
if [[ -f "$LOG_FILE" ]]; then
  PHASE=$(jq -r '.phase // "unknown"' "$STATE_FILE" 2>/dev/null || echo "unknown")
  ARTIFACT_LIST=$(ls "${INSTANCE_DIR}"/*.md 2>/dev/null | xargs -I{} basename {} | paste -sd ',' - 2>/dev/null || echo "")
  printf '> [PreCompact %s] phase=%s | artifacts:%s\n' "$NOW" "$PHASE" "$ARTIFACT_LIST" >> "$LOG_FILE" 2>/dev/null || true
fi

# Emit compact instructions — stdout is captured by the compaction engine
GOAL=$(jq -r '.goal // ""' "$STATE_FILE" 2>/dev/null || echo "")
PHASE=$(jq -r '.phase // "unknown"' "$STATE_FILE" 2>/dev/null || echo "unknown")
INSTANCE_ID=$(jq -r '.instance_id // ""' "$STATE_FILE" 2>/dev/null || echo "")

printf 'CRITICAL CONTEXT — DEEPWORK ORCHESTRATOR:\n'
printf 'You are the deepwork orchestrator (phase: %s, instance: %s).\n' "$PHASE" "$INSTANCE_ID"
printf 'Goal: %s\n' "$GOAL"
printf 'State file: %s\n' "$STATE_FILE"
printf 'Log file: %s\n' "$LOG_FILE"
printf 'Instance dir: %s\n' "$INSTANCE_DIR"
printf '\n'
printf 'After compaction, read state.json and log.md to recover full session context.\n'
printf 'Preserve all archetype verdicts, bar criteria, and empirical results.\n'

exit 0
