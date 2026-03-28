#!/bin/bash
# notify-task-complete.sh — Async TaskCompleted hook for external notifications
#
# Called when a task is marked complete (async, non-blocking). POSTs task completion
# info to a configured webhook URL for external monitoring (Slack, etc.).
#
# Reads the webhook URL from .claude/swarm-loop.local.md (notifications.channel in YAML frontmatter).
# Silently exits if no webhook is configured.

# Don't fail on errors — this is a non-critical notification hook
set +e

STATE_FILE=".claude/swarm-loop.local.state.json"
CONFIG_FILE=".claude/swarm-loop.local.md"

# Only notify if a swarm loop is active
[[ -f "$STATE_FILE" ]] || exit 0

# Require jq and curl
command -v jq >/dev/null 2>&1 || exit 0
command -v curl >/dev/null 2>&1 || exit 0

# Read webhook URL from config file (YAML frontmatter)
WEBHOOK_URL=""
if [[ -f "$CONFIG_FILE" ]]; then
  WEBHOOK_URL=$(sed -n '/^---$/,/^---$/{ /^---$/d; p; }' "$CONFIG_FILE" | grep -E '^\s*channel:' | sed 's/.*channel:[[:space:]]*//' | tr -d "'" | tr -d '"' || true)
fi

# No webhook configured — nothing to do
if [[ -z "$WEBHOOK_URL" ]] || [[ "$WEBHOOK_URL" == "null" ]]; then
  exit 0
fi

# Strip whitespace and validate protocol (prevent SSRF via file://, ftp://, internal URLs)
WEBHOOK_URL=$(echo "$WEBHOOK_URL" | tr -d '[:space:]')
if [[ "$WEBHOOK_URL" != https://* ]]; then
  exit 0
fi

# Read hook input from stdin
INPUT=$(cat)
TASK_ID=$(echo "$INPUT" | jq -r '.task_id // "unknown"' 2>/dev/null)
TASK_SUBJECT=$(echo "$INPUT" | jq -r '.task_subject // "unknown"' 2>/dev/null)
TEAMMATE_NAME=$(echo "$INPUT" | jq -r '.teammate_name // "unknown"' 2>/dev/null)
TEAM_NAME=$(echo "$INPUT" | jq -r '.team_name // "unknown"' 2>/dev/null)

# Read state for context
STATE_JSON=$(cat "$STATE_FILE" 2>/dev/null)
GOAL=$(echo "$STATE_JSON" | jq -r '.goal // ""' 2>/dev/null)
ITERATION=$(echo "$STATE_JSON" | jq -r '.iteration // 1' 2>/dev/null)

# Build notification payload
PAYLOAD=$(jq -n \
  --arg task_id "$TASK_ID" \
  --arg task_subject "$TASK_SUBJECT" \
  --arg teammate "$TEAMMATE_NAME" \
  --arg team "$TEAM_NAME" \
  --arg goal "$GOAL" \
  --argjson iteration "$ITERATION" \
  --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  '{
    event: "task_completed",
    task_id: $task_id,
    task_subject: $task_subject,
    teammate: $teammate,
    team: $team,
    goal: $goal,
    iteration: $iteration,
    timestamp: $timestamp
  }')

# POST to webhook (timeout 10s, silent)
curl -s -X POST \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --connect-timeout 5 \
  --max-time 10 \
  "$WEBHOOK_URL" >/dev/null 2>&1

exit 0
