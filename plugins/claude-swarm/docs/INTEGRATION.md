# Claude Swarm Integration Guide

This guide covers integrating Claude Swarm with external systems, tools, and workflows.

## Table of Contents

1. [Overview](#overview)
2. [CC Native Compatibility](#cc-native-compatibility)
3. [Integration Patterns](#integration-patterns)
4. [File-Based Integration](#file-based-integration)
5. [Environment Variables](#environment-variables)
6. [Hooks Integration](#hooks-integration)
7. [Webhook Notifications](#webhook-notifications)
8. [Message-Based Communication](#message-based-communication)
9. [Task System Integration](#task-system-integration)
10. [CI/CD Integration](#cicd-integration)
10. [Custom Tooling](#custom-tooling)
11. [Monitoring and Observability](#monitoring-and-observability)

---

## Overview

Claude Swarm is designed with extensibility in mind. Teams can integrate with external systems through multiple mechanisms:

- **File-based interfaces** - Read/write JSON configuration and task files
- **Environment variables** - Access team context in spawned Claude Code instances
- **Message passing** - Asynchronous communication between agents and external systems
- **Hooks** - Respond to lifecycle events (session start/stop, tool use, plan mode exit)
- **Status files** - Monitor agent health and activity

This flexibility allows you to:

- Monitor swarm activity from external dashboards
- Trigger team actions from CI/CD pipelines
- Coordinate with other tools and services
- Build custom workflows and automation

---

## CC Native Compatibility

Claude Code 2.1.39+ includes native team and task tools (`TeamCreate`, `TaskCreate`, `SendMessage`, etc.). Claude Swarm writes config and task files that are compatible with both systems by using dual field names.

### Team Config Field Mapping

| Field | CC Native | Swarm Legacy | Read Pattern |
|-------|-----------|--------------|--------------|
| Team name | `name` | `teamName` | `(.name // .teamName)` |
| Member type | `agentType` | `type` | `(.agentType // .type)` |
| Join timestamp | `joinedAt` | `lastSeen` | Both written |
| Team creation | `createdAt` (ISO string) | `createdAt` (ISO string) | Same format |
| Team lead | `leadAgentId` | `leadAgentId` | Same field |

**Swarm writes both field names** in `create_team()` and `add_member()` so configs are readable by both CC native tools and swarm commands.

### Task Status Values

| Status | CC Native | Swarm | Notes |
|--------|-----------|-------|-------|
| `pending` | Yes | Yes | Identical |
| `in_progress` | Yes | Yes | Swarm also accepts `in-progress` on read |
| `completed` | Yes | Yes | Identical |
| `blocked` | No | Yes | Swarm extension |
| `in_review` | No | Yes | Swarm extension; also accepts `in-review` on read |

CC native only uses `pending`, `in_progress`, and `completed`. Swarm extends this with `blocked` and `in_review` for richer workflow tracking. The core library (`08-tasks.sh`, `06-status.sh`) accepts both hyphenated and underscored formats for backwards compatibility.

### Task File Schema

Task files are largely compatible between systems:

| Field | CC Native | Swarm | Compatible |
|-------|-----------|-------|------------|
| `id` | Yes | Yes | Yes |
| `subject` | Yes | Yes | Yes |
| `description` | Yes | Yes | Yes |
| `status` | Yes | Yes | Yes (see status table above) |
| `owner` | Yes | `assigned_to` | Swarm uses `owner` in jq, `assigned_to` in JSON |
| `blocks` | Yes | Yes | Yes |
| `blockedBy` | Yes | `blocked_by` | Both field names supported |
| `comments` | No | Yes | Swarm extension |

### CC-Only Fields (Not Written by Swarm)

These fields exist in CC native team configs but are not written by swarm. CC reads configs generically with `JSON.parse` so their absence does not cause errors:

- `leadSessionId` - CC session ID for the team lead
- `tmuxPaneId` - Tmux pane identifier (CC uses tmux internally)
- `cwd` - Working directory per member
- `subscriptions` - CC notification subscriptions
- `backendType` - CC backend type identifier

### Reading Configs Safely

When writing integrations that read swarm config files, always use fallback patterns:

```bash
# Team name - use CC native first, fall back to swarm legacy
team_name=$(jq -r '.name // .teamName' config.json)

# Member type - use CC native first, fall back to swarm legacy
jq -r '.members[] | "\(.name) (\(.agentType // .type))"' config.json

# Archive metadata
jq -r '.name // .teamName' archive_metadata.json
```

### Teammate Spawn Command

Swarm respects the `CLAUDE_CODE_TEAMMATE_COMMAND` environment variable (introduced in CC 2.1.20). When set, swarm uses this as the binary path instead of `claude`:

```bash
# Default behavior (uses 'claude')
export CLAUDE_CODE_TEAMMATE_COMMAND=""

# Custom binary path
export CLAUDE_CODE_TEAMMATE_COMMAND="/usr/local/bin/claude-dev"
```

The resolved command is available as `SWARM_CLAUDE_CMD` in the library (defined in `00-globals.sh`).

### Spawn Mechanism Differences

CC native and swarm use different mechanisms to pass team context to spawned teammates:

| Mechanism | CC Native | Swarm |
|-----------|-----------|-------|
| Team context | CLI args (`--agent-id`, `--agent-name`, `--team-name`, `--agent-color`) | Both CLI args AND env vars (`CLAUDE_CODE_TEAM_NAME`, etc.) |
| Binary command | `CLAUDE_CODE_TEAMMATE_COMMAND` or `process.execPath` | `SWARM_CLAUDE_CMD` (reads `CLAUDE_CODE_TEAMMATE_COMMAND`, falls back to `claude`) |
| Backend | tmux panes (internal `PaneBackendExecutor`) | kitty windows/tabs/splits OR tmux sessions |

Swarm passes team context via both CLI args (for CC native features like the prompt line and agent color) and environment variables (for bash scripts and hooks that read `$CLAUDE_CODE_TEAM_NAME` etc.). This dual approach ensures compatibility with both systems.

---

## Integration Patterns

### Pattern 1: External Task Creation

Create tasks from external systems by writing directly to the task directory:

```bash
# From external system
cat > ~/.claude/tasks/my-team/5.json <<EOF
{
  "id": 5,
  "subject": "Deploy to staging",
  "description": "Deploy latest changes to staging environment",
  "status": "pending",
  "assigned_to": null,
  "created_at": "2025-12-16T10:00:00Z",
  "blocked_by": [4],
  "comments": []
}
EOF

# Team-lead is notified of new task
/claude-swarm:task-list
```

**Use case:** Integrate bug tracking systems, issue queues, or project management tools.

### Pattern 2: Status Monitoring

Read team configuration and status for monitoring:

```bash
# From external monitoring system
cat ~/.claude/teams/my-team/config.json | jq '.members[] | {name, status, lastSeen}'

# Display in custom dashboard
watch -n 5 'cat ~/.claude/teams/my-team/config.json | jq ".members[] | {name, status}"'
```

**Use case:** Build dashboards, Slack bots, or health checks.

### Pattern 3: Message-Driven Workflows

External systems send messages to teammates:

```bash
# From CI/CD pipeline
cat > ~/.claude/teams/my-team/inboxes/backend-dev.json <<EOF
{
  "id": "msg-1234",
  "from": "ci-pipeline",
  "subject": "Test failures in feature-branch",
  "body": "Tests failed. See: https://ci.example.com/runs/12345",
  "timestamp": "2025-12-16T10:00:00Z",
  "read": false
}
EOF

# Teammate is notified when they run /claude-swarm:swarm-inbox
```

**Use case:** Notify teammates of test failures, deployment status, or urgent issues.

### Pattern 4: Webhook Integration

Respond to external events by creating tasks or sending messages:

```bash
#!/bin/bash
# Webhook handler for GitHub issues

issue_number=$1
issue_title=$2
team_name=$3

# Create task for the issue
/claude-swarm:task-create "Issue #$issue_number: $issue_title" \
  "Review and address: https://github.com/owner/repo/issues/$issue_number"

# Notify team-lead
/claude-swarm:swarm-message team-lead "New GitHub issue: $issue_title"
```

**Use case:** GitHub webhooks, deployment notifications, monitoring alerts.

---

## File-Based Integration

### Team Configuration

**Location:** `~/.claude/teams/<team>/config.json`

**CC Native Compatibility:** Config files include both CC native and swarm field names for cross-compatibility. When reading, use `(.name // .teamName)` for team name and `(.agentType // .type)` for member type.

```json
{
  "name": "my-team",
  "teamName": "my-team",
  "description": "Building authentication system",
  "status": "active",
  "leadAgentId": "uuid-1",
  "members": [
    {
      "agentId": "uuid-1",
      "name": "team-lead",
      "agentType": "team-lead",
      "type": "team-lead",
      "color": "cyan",
      "model": "sonnet",
      "status": "active",
      "joinedAt": "2025-12-16T10:00:00Z",
      "lastSeen": "2025-12-16T10:05:00Z"
    },
    {
      "agentId": "uuid-2",
      "name": "backend-dev",
      "agentType": "backend-developer",
      "type": "backend-developer",
      "color": "blue",
      "model": "sonnet",
      "status": "active",
      "joinedAt": "2025-12-16T10:01:00Z",
      "lastSeen": "2025-12-16T10:05:00Z"
    },
    {
      "agentId": "uuid-3",
      "name": "frontend-dev",
      "type": "frontend-developer",
      "color": "blue",
      "model": "sonnet",
      "status": "offline",
      "lastSeen": "2025-12-16T09:55:00Z"
    }
  ],
  "createdAt": "2025-12-16T10:00:00Z",
  "suspendedAt": null,
  "resumedAt": null
}
```

**Read this to:**
- Check team member status
- Monitor `lastSeen` timestamps for health checks
- Build status dashboards
- Verify team composition
- Access `leadAgentId` for team-lead identification

### Task Files

**Location:** `~/.claude/tasks/<team>/<id>.json`

```json
{
  "id": 1,
  "subject": "Implement login endpoint",
  "description": "Create POST /auth/login with JWT support",
  "status": "in_progress",
  "assigned_to": "backend-dev",
  "created_at": "2025-12-16T10:00:00Z",
  "updated_at": "2025-12-16T10:15:00Z",
  "blocked_by": [],
  "blocked_by_tasks": [],
  "comments": [
    {
      "author": "backend-dev",
      "text": "Working on authentication middleware",
      "timestamp": "2025-12-16T10:15:00Z"
    }
  ]
}
```

**Read this to:**
- Track task progress
- Check task assignments
- Monitor blockers and dependencies
- Build sprint boards

**Write to this to:**
- Update task status from external systems
- Add comments from monitoring/CI systems
- Manage task dependencies programmatically

### Message Files (Inboxes)

**Location:** `~/.claude/teams/<team>/inboxes/<agent>.json`

```json
[
  {
    "from": "team-lead",
    "text": "Shift focus to API optimization",
    "color": "cyan",
    "read": false,
    "timestamp": "2025-12-16T10:00:00Z"
  },
  {
    "from": "ci-pipeline",
    "text": "All tests passing on feature-branch",
    "color": "blue",
    "read": false,
    "timestamp": "2025-12-16T10:05:00Z"
  }
]
```

**Read this to:**
- Monitor inter-agent communication
- Track team coordination
- Build communication logs

**Write to this to:**
- Send messages from external systems
- Alert teammates of events
- Integrate with notifications systems

---

## Environment Variables

When teammates are spawned, these variables are automatically set in their Claude Code session:

```bash
# Inside teammate's Claude Code session
echo $CLAUDE_CODE_TEAM_NAME        # "my-team"
echo $CLAUDE_CODE_AGENT_ID         # "uuid-2"
echo $CLAUDE_CODE_AGENT_NAME       # "backend-dev"
echo $CLAUDE_CODE_AGENT_TYPE       # "backend-developer"
echo $CLAUDE_CODE_TEAM_LEAD_ID     # "uuid-1" (team lead's UUID)
echo $CLAUDE_CODE_AGENT_COLOR      # "blue"
echo $KITTY_LISTEN_ON              # "unix:/tmp/kitty-user-12345" (kitty only)
```

**Use these to:**
- Access team context in custom commands
- Coordinate with external systems
- Track work in monitoring systems
- Build audit logs
- Enable InboxPoller with team lead ID

### User-Configurable Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `SWARM_MULTIPLEXER` | Force "tmux" or "kitty" | Auto-detect |
| `SWARM_KITTY_MODE` | Kitty spawn mode: split, tab, window | `split` |
| `KITTY_LISTEN_ON` | Override kitty socket path | Auto-discovered |
| `SWARM_KEEP_ALIVE` | Keep teammates running when team-lead exits | `false` |
| `CLAUDE_CODE_TEAMMATE_COMMAND` | Override claude binary path for spawning | `claude` |

### Setting Custom Variables

Pass additional context when spawning teammates:

```bash
# From a script that sets up context
/claude-swarm:swarm-spawn backend-dev backend-developer sonnet \
  "Focus on REST API implementation. See task #1 and #2 for details."
```

The spawned teammate will have this context in their initial session and can access team information through the swarm commands.

---

## Hooks Integration

Claude Swarm provides 5 lifecycle hooks for custom automation:

### SessionStart Hook

**Trigger:** When a teammate's Claude Code session starts

**Location:** `plugins/claude-swarm/hooks/session-start.sh`

**Use for:**
- Auto-deliver unread messages
- Initialize teammate with task context
- Trigger external notifications

### SessionEnd Hook

**Trigger:** When a teammate's session ends

**Location:** `plugins/claude-swarm/hooks/session-stop.sh`

**Use for:**
- Notify team-lead of completion
- Archive session logs
- Update external monitoring systems

### Notification Hook

**Trigger:** Periodic notifications during operation

**Location:** `plugins/claude-swarm/hooks/notification-heartbeat.sh`

**Use for:**
- Update `lastSeen` timestamps
- Detect stale/hung agents
- Send periodic status updates

### ExitPlanMode Hook

**Trigger:** When Claude exits plan mode

**Location:** `plugins/claude-swarm/hooks/exit-plan-swarm.sh`

**Use for:**
- Automatically create teams from approved plans
- Spawn teammates based on plan recommendations
- Coordinate complex multi-agent tasks

### PreToolUse:Task Hook

**Trigger:** Before spawning a subagent with the Task tool

**Location:** `plugins/claude-swarm/hooks/task-team-context.sh`

**Use for:**
- Inject team context into subagents
- Ensure proper coordination across nested agents
- Track nested task execution

---

## Webhook Notifications

Claude Swarm supports outbound webhook notifications for key team events, enabling real-time integration with external systems.

### Overview

Webhooks provide push-based notifications when important events occur in your swarm:

- **Team lifecycle** - Team created, suspended, resumed
- **Teammate changes** - Members joining or leaving
- **Task updates** - Tasks created or completed
- **Communication** - Messages sent between teammates

### Configuring Webhooks

Use the `/swarm-webhooks` command to manage webhook endpoints:

```bash
# Add webhook for all events
/swarm-webhooks my-team add https://example.com/webhook

# Add webhook for specific event type
/swarm-webhooks my-team add https://example.com/tasks task.created

# List configured webhooks
/swarm-webhooks my-team list

# Remove webhook
/swarm-webhooks my-team remove https://example.com/webhook

# Test webhook delivery
/swarm-webhooks my-team test https://example.com/webhook
```

### Webhook Payload Format

All webhooks receive POST requests with JSON payloads in this format:

```json
{
  "team": "my-team",
  "event": "task.created",
  "timestamp": "2025-12-16T10:00:00Z",
  "data": {
    "teamName": "my-team",
    "taskId": "5",
    "subject": "Implement feature X"
  }
}
```

**Headers:**
- `Content-Type: application/json`
- `User-Agent: Claude-Swarm/1.0`

### Event Types

| Event Type | Description | Data Fields |
|------------|-------------|-------------|
| `team.created` | Team was created | `teamName`, `description` |
| `team.suspended` | Team was suspended | `teamName` |
| `team.resumed` | Team was resumed | `teamName` |
| `teammate.joined` | New teammate joined | `teamName`, `teammate`, `type` |
| `teammate.left` | Teammate left team | `teamName`, `teammate` |
| `task.created` | New task created | `teamName`, `taskId`, `subject` |
| `task.completed` | Task marked completed | `teamName`, `taskId`, `owner` |
| `message.sent` | Message sent | `teamName`, `from`, `to`, `preview` |
| `webhook.test` | Test event | `message`, `timestamp` |

### Event Filtering

Configure webhooks to receive only specific event types:

```bash
# Only task events
/swarm-webhooks my-team add https://example.com/tasks task.created

# Only team lifecycle events
/swarm-webhooks my-team add https://example.com/lifecycle team.suspended

# All events (default)
/swarm-webhooks my-team add https://example.com/all "*"
```

### Webhook Handler Examples

#### Node.js / Express

```javascript
const express = require('express');
const app = express();

app.use(express.json());

app.post('/webhook', (req, res) => {
  const { team, event, timestamp, data } = req.body;

  console.log(`Received ${event} for team ${team}`);

  switch (event) {
    case 'task.completed':
      console.log(`Task #${data.taskId} completed by ${data.owner}`);
      // Trigger notification, update dashboard, etc.
      break;

    case 'teammate.joined':
      console.log(`${data.teammate} joined as ${data.type}`);
      // Send welcome message, update roster, etc.
      break;

    case 'team.suspended':
      console.log(`Team ${data.teamName} suspended`);
      // Archive data, notify stakeholders, etc.
      break;
  }

  res.status(200).json({ received: true });
});

app.listen(3000);
```

#### Python / Flask

```python
from flask import Flask, request, jsonify
import logging

app = Flask(__name__)

@app.route('/webhook', methods=['POST'])
def webhook():
    payload = request.get_json()
    team = payload.get('team')
    event = payload.get('event')
    data = payload.get('data', {})

    logging.info(f"Received {event} for team {team}")

    if event == 'task.completed':
        task_id = data.get('taskId')
        owner = data.get('owner')
        logging.info(f"Task #{task_id} completed by {owner}")
        # Send notification, update metrics, etc.

    elif event == 'teammate.joined':
        teammate = data.get('teammate')
        logging.info(f"{teammate} joined the team")
        # Update roster, send welcome message, etc.

    return jsonify({'received': True}), 200

if __name__ == '__main__':
    app.run(port=3000)
```

#### Bash Script

```bash
#!/bin/bash
# Simple webhook handler using netcat

PORT=3000

while true; do
  {
    # Read HTTP request
    read request
    read -r headers

    # Read JSON payload
    payload=""
    while read -r line; do
      [[ -z "$line" ]] && break
      payload="$payload$line"
    done

    # Extract event details
    event=$(echo "$payload" | jq -r '.event')
    team=$(echo "$payload" | jq -r '.team')

    echo "Received event: $event for team: $team"

    # Respond with 200 OK
    echo -e "HTTP/1.1 200 OK\r"
    echo -e "Content-Type: application/json\r"
    echo -e "\r"
    echo -e '{"received":true}\r'
  } | nc -l -p $PORT
done
```

### Integration Examples

#### Slack Notifications

```bash
#!/bin/bash
# Webhook handler that posts to Slack

# Expects JSON payload from Claude Swarm
payload=$(cat)

event=$(echo "$payload" | jq -r '.event')
team=$(echo "$payload" | jq -r '.team')
data=$(echo "$payload" | jq -r '.data')

# Build Slack message based on event
case "$event" in
  "task.completed")
    task_id=$(echo "$data" | jq -r '.taskId')
    owner=$(echo "$data" | jq -r '.owner')
    message="✅ Task #$task_id completed by $owner in team $team"
    ;;

  "teammate.joined")
    teammate=$(echo "$data" | jq -r '.teammate')
    message="👋 $teammate joined team $team"
    ;;

  "team.suspended")
    message="⏸️ Team $team suspended"
    ;;

  *)
    message="📢 Event $event in team $team"
    ;;
esac

# Post to Slack
curl -X POST "$SLACK_WEBHOOK_URL" \
  -H 'Content-Type: application/json' \
  -d "{\"text\": \"$message\"}"

# Respond to webhook
echo '{"received": true}'
```

#### GitHub Issues Integration

```bash
#!/bin/bash
# Create GitHub issues when tasks are completed

payload=$(cat)
event=$(echo "$payload" | jq -r '.event')

if [[ "$event" == "task.completed" ]]; then
  task_id=$(echo "$payload" | jq -r '.data.taskId')
  subject=$(echo "$payload" | jq -r '.data.subject')
  owner=$(echo "$payload" | jq -r '.data.owner')

  # Create GitHub issue for completed task
  gh issue create \
    --title "Task #$task_id completed: $subject" \
    --body "Completed by: $owner" \
    --label "swarm-completed"
fi

echo '{"received": true}'
```

#### Prometheus Metrics

```bash
#!/bin/bash
# Export swarm events as Prometheus metrics

payload=$(cat)
event=$(echo "$payload" | jq -r '.event')
team=$(echo "$payload" | jq -r '.team')

# Increment event counter
echo "swarm_events_total{team=\"$team\",event=\"$event\"} 1" >> /var/lib/prometheus/swarm_metrics.prom

# Update last event timestamp
timestamp=$(date +%s)
echo "swarm_last_event_timestamp{team=\"$team\"} $timestamp" >> /var/lib/prometheus/swarm_metrics.prom

echo '{"received": true}'
```

### Webhook Security

#### Authentication

Add authentication to your webhook handlers:

```javascript
// Express with bearer token
app.post('/webhook', (req, res) => {
  const token = req.headers.authorization?.split(' ')[1];

  if (token !== process.env.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Process webhook...
});
```

**Note:** Claude Swarm currently sends webhooks without authentication headers. Consider:
- Using HTTPS URLs
- IP allowlisting
- URL secrets (e.g., `https://example.com/webhook/secret-token`)
- Network-level restrictions

#### HTTPS

Always use HTTPS endpoints for webhook URLs:

```bash
# Good
/swarm-webhooks my-team add https://example.com/webhook

# Avoid (insecure)
/swarm-webhooks my-team add http://example.com/webhook
```

### Webhook Delivery

**Delivery guarantees:**
- Best-effort delivery (fire-and-forget)
- 10-second timeout per request
- No automatic retries
- Asynchronous (non-blocking)

**Failure handling:**
- Failed deliveries are silently ignored
- No delivery confirmation or status tracking
- Implement your own retry logic if needed

### Testing Webhooks

Use the test command to verify webhook configuration:

```bash
# Send test event
/swarm-webhooks my-team test https://example.com/webhook
```

Test payload:
```json
{
  "team": "my-team",
  "event": "webhook.test",
  "timestamp": "2025-12-16T10:00:00Z",
  "data": {
    "message": "This is a test webhook from Claude Swarm",
    "timestamp": "2025-12-16T10:00:00Z"
  }
}
```

Use tools like [webhook.site](https://webhook.site) or [RequestBin](https://requestbin.com) for testing:

```bash
# Get a test URL from webhook.site
TEST_URL="https://webhook.site/unique-id"

# Add webhook
/swarm-webhooks my-team add "$TEST_URL"

# Send test event
/swarm-webhooks my-team test "$TEST_URL"

# Check webhook.site to see the payload
```

### Configuration Storage

Webhooks are stored in the team configuration file:

**Location:** `~/.claude/teams/<team>/config.json`

```json
{
  "teamName": "my-team",
  "webhooks": [
    {
      "url": "https://example.com/webhook",
      "events": "*",
      "enabled": true,
      "addedAt": "2025-12-16T10:00:00Z"
    },
    {
      "url": "https://example.com/tasks",
      "events": "task.created",
      "enabled": true,
      "addedAt": "2025-12-16T10:05:00Z"
    }
  ]
}
```

### Programmatic Webhook Management

Manage webhooks via file editing:

```bash
#!/bin/bash
# Add webhook programmatically

team="my-team"
config="$HOME/.claude/teams/$team/config.json"
webhook_url="https://example.com/webhook"

# Add webhook using jq
jq --arg url "$webhook_url" \
   --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
   '.webhooks += [{url: $url, events: "*", enabled: true, addedAt: $timestamp}]' \
   "$config" > "$config.tmp" && mv "$config.tmp" "$config"
```

---

## Message-Based Communication

### Sending Messages from External Systems

```bash
#!/bin/bash
# Script to send notifications from external services

team_name=$1
recipient=$2
message=$3

# Create message file
msg_file="$HOME/.claude/teams/$team_name/inboxes/$recipient.json"

# Append message to inbox (ensure valid JSON)
# Note: In production, use a proper JSON tool like jq
echo "{\"id\":\"msg-$(date +%s)\",\"from\":\"external-system\",\"subject\":\"Alert\",\"body\":\"$message\",\"timestamp\":\"$(date -Iseconds)\",\"read\":false}" >> "$msg_file"

echo "Message sent to $recipient"
```

### Reading Messages in Custom Code

```bash
#!/bin/bash
# Custom command to check for specific message types

team_name="my-team"
agent_name="backend-dev"
inbox="$HOME/.claude/teams/$team_name/inboxes/$agent_name.json"

if [ -f "$inbox" ]; then
  # Check for unread CI/deployment messages
  cat "$inbox" | jq '.[] | select(.from == "ci-pipeline" and .read == false)'
fi
```

---

## Task System Integration

### Programmatic Task Management

```bash
#!/bin/bash
# Create tasks from GitHub issues

github_token=$1
repo=$2
team_name=$3

# Fetch open issues from GitHub
issues=$(curl -s -H "Authorization: token $github_token" \
  "https://api.github.com/repos/$repo/issues?state=open" \
  | jq -r '.[] | "\(.number)|\(.title)|\(.html_url)"')

# Create task for each issue
while IFS='|' read -r number title url; do
  /claude-swarm:task-create \
    "Issue #$number: $title" \
    "Review and implement: $url"
done <<< "$issues"
```

### Task Dependency Chains

```bash
#!/bin/bash
# Create tasks with dependencies

team_name="feature-launch"

# Create feature tasks
/claude-swarm:task-create "Design API schema" "Define REST endpoints"
/claude-swarm:task-create "Implement API" "Build endpoints from design"
/claude-swarm:task-create "Write API tests" "Comprehensive test suite"
/claude-swarm:task-create "Frontend integration" "Connect UI to API"

# Set up dependencies (task #2 blocked by #1, #3 blocked by #2, etc)
/claude-swarm:task-update 2 --blocked-by 1
/claude-swarm:task-update 3 --blocked-by 2
/claude-swarm:task-update 4 --blocked-by 2
```

---

## CI/CD Integration

### GitHub Actions

```yaml
name: Swarm Coordination

on:
  pull_request:
    types: [opened, synchronize]

jobs:
  assign-reviewers:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Notify swarm of PR
        run: |
          #!/bin/bash
          TEAM="code-review"
          PR_NUMBER=${{ github.event.number }}
          PR_URL=${{ github.event.pull_request.html_url }}

          # Message reviewers about new PR
          echo "Sending PR notification to swarm..."
          # Note: In production, integrate with actual Claude Code instance
          echo "PR #$PR_NUMBER ready for review: $PR_URL"

  test-results:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: npm test

      - name: Notify team of results
        if: always()
        run: |
          # On test failure, create task for debugging
          if [ $? -ne 0 ]; then
            echo "Tests failed - would notify swarm team"
          fi
```

### GitLab CI

```yaml
stages:
  - test
  - notify-swarm

test:
  stage: test
  script:
    - npm test

notify-team:
  stage: notify-swarm
  script:
    - |
      if [ "$CI_JOB_STATUS" == "failed" ]; then
        echo "Creating task for test failures"
        # Integrate with swarm task creation
      fi
```

---

## Custom Tooling

### Swarm Dashboard Script

```bash
#!/bin/bash
# Simple dashboard for monitoring swarms

watch -n 5 "
echo '=== Active Swarms ==='; \
ls ~/.claude/teams/ | while read team; do
  echo \"\\n$team:\"; \
  cat ~/.claude/teams/\$team/config.json | jq '{status, members: (.members | length), updated: .members[0].lastSeen}' 2>/dev/null; \
done; \
echo \"\\n=== Recent Tasks ===\"; \
for task in ~/.claude/tasks/*/\* .json 2>/dev/null | head -5; do
  echo \"\$task:\"; \
  cat \"\$task\" 2>/dev/null | jq '{subject, status, assigned_to}'; \
done
"
```

### Health Check Script

```bash
#!/bin/bash
# Monitor swarm health and alert on issues

team_name=$1
config="$HOME/.claude/teams/$team_name/config.json"

if [ ! -f "$config" ]; then
  echo "Team not found: $team_name"
  exit 1
fi

# Check for stale lastSeen timestamps (> 5 minutes old)
now=$(date +%s)

cat "$config" | jq -r '.members[] | "\(.name)|\(.lastSeen)|\(.status)"' | while IFS='|' read -r name last_seen status; do
  if [ "$status" = "active" ]; then
    # Convert ISO timestamp (handle both macOS and Linux)
    member_time=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$last_seen" +%s 2>/dev/null || date -d "$last_seen" +%s 2>/dev/null)
    age=$((now - member_time))

    if [ $age -gt 300 ]; then
      echo "ALERT: $name lastSeen stale (${age}s old)"
    fi
  fi
done
```

---

## Monitoring and Observability

### Heartbeat Monitoring (lastSeen)

Claude Swarm automatically updates `lastSeen` timestamps for all active team members via the Notification hook. Use this for:

- Detecting hung or crashed agents
- Monitoring long-running operations
- Alerting on session timeouts

```bash
#!/bin/bash
# Check agent health

check_agent_health() {
  local team=$1
  local agent=$2
  local max_age_seconds=600  # 10 minutes

  config="$HOME/.claude/teams/$team/config.json"
  last_seen=$(cat "$config" | jq -r ".members[] | select(.name==\"$agent\") | .lastSeen")

  if [ -z "$last_seen" ]; then
    echo "Agent not found"
    return 1
  fi

  current=$(date +%s)
  # Convert ISO timestamp to epoch (macOS vs Linux)
  last_seen_time=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$last_seen" +%s 2>/dev/null || date -d "$last_seen" +%s 2>/dev/null)
  age=$((current - last_seen_time))

  if [ $age -gt $max_age_seconds ]; then
    echo "UNHEALTHY: Agent inactive for ${age}s"
    return 1
  else
    echo "HEALTHY: Last seen ${age}s ago"
    return 0
  fi
}

check_agent_health "my-team" "backend-dev"
```

### Activity Logging

Track all team activity through message and task files:

```bash
#!/bin/bash
# Generate activity report

team=$1
report_file="/tmp/swarm-activity-$team.log"

echo "=== Team Activity Report: $team ===" > "$report_file"
echo "Generated: $(date)" >> "$report_file"
echo "" >> "$report_file"

echo "=== Task Activity ===" >> "$report_file"
for task in ~/.claude/tasks/$team/*.json; do
  cat "$task" | jq '{id, subject, status, assigned_to, updated_at}' >> "$report_file"
done

echo "" >> "$report_file"
echo "=== Messages ===" >> "$report_file"
for inbox in ~/.claude/teams/$team/inboxes/*.json; do
  agent=$(basename "$inbox" .json)
  echo "Messages for $agent:" >> "$report_file"
  cat "$inbox" | jq '.[] | {from, subject, timestamp}' >> "$report_file"
done

echo "Report saved to: $report_file"
cat "$report_file"
```

### Integration with External Monitoring

```bash
#!/bin/bash
# Export swarm metrics to Prometheus or similar

team=$1

# Count metrics
config="$HOME/.claude/teams/$team/config.json"
total_members=$(cat "$config" | jq '.members | length')
active_members=$(cat "$config" | jq '[.members[] | select(.status=="active")] | length')
offline_members=$(cat "$config" | jq '[.members[] | select(.status=="offline")] | length')

# Task metrics
open_tasks=$(ls ~/.claude/tasks/$team/ 2>/dev/null | wc -l)
in_progress=$(grep -l '"status":"in_progress"' ~/.claude/tasks/$team/*.json 2>/dev/null | wc -l)
resolved=$(grep -l '"status":"resolved"' ~/.claude/tasks/$team/*.json 2>/dev/null | wc -l)

# Output metrics (Prometheus format)
echo "# HELP swarm_members Total team members"
echo "swarm_members{team=\"$team\"} $total_members"
echo "# HELP swarm_members_active Active members"
echo "swarm_members_active{team=\"$team\"} $active_members"
echo "# HELP swarm_tasks_open Open tasks"
echo "swarm_tasks_open{team=\"$team\"} $open_tasks"
echo "# HELP swarm_tasks_in_progress Tasks in progress"
echo "swarm_tasks_in_progress{team=\"$team\"} $in_progress"
```

---

## Best Practices

1. **Always use JSON-aware tools** - Use `jq` or similar for manipulating JSON files to prevent corruption
2. **Atomic writes** - Write to temporary files and move them atomically to prevent partial reads
3. **Respect file ownership** - Don't directly modify plugin files; use commands instead
4. **Monitor lastSeen** - Regularly check for stale `lastSeen` timestamps to detect issues
5. **Version your integrations** - Track what external systems are interacting with swarms
6. **Error handling** - Implement proper error handling for file-based operations
7. **Backup important files** - Back up team configs and task files before bulk operations
8. **Use versioning** - Store integration scripts in version control for reproducibility

---

## Examples

### Example 1: Auto-Create Team from CI Pipeline

```bash
#!/bin/bash
# Called from CI when starting a test suite

test_id=$1
feature_branch=$2

# Create team for this test run
/claude-swarm:swarm-create "test-$test_id" "Testing $feature_branch"

# Create analysis and testing tasks
/claude-swarm:task-create "Run test suite" "Execute full test suite for $feature_branch"
/claude-swarm:task-create "Analyze failures" "Categorize and prioritize failures"

# Spawn testers
/claude-swarm:swarm-spawn test-runner tester haiku "Run tests for $feature_branch"
```

### Example 2: Slack Integration

```bash
#!/bin/bash
# Webhook handler for Slack commands

slack_command=$1
team_name=$2
action=$3

case $slack_command in
  "team-status")
    status=$(/claude-swarm:swarm-status $team_name)
    curl -X POST $SLACK_WEBHOOK -d "payload={\"text\": \"$status\"}"
    ;;
  "list-tasks")
    tasks=$(/claude-swarm:task-list)
    curl -X POST $SLACK_WEBHOOK -d "payload={\"text\": \"$tasks\"}"
    ;;
  "message-team")
    /claude-swarm:swarm-message team-lead "Slack notification: $action"
    ;;
esac
```

### Example 3: Deployment Coordination

```bash
#!/bin/bash
# Called before/after deployments

deployment_env=$1
version=$2
team_name="deployment-$deployment_env"

# Create team for deployment
/claude-swarm:swarm-create "$team_name" "Deploying v$version to $deployment_env"

# Create deployment tasks
/claude-swarm:task-create "Deploy backend" "Deploy backend services to $deployment_env"
/claude-swarm:task-create "Deploy frontend" "Deploy frontend to CDN"
/claude-swarm:task-create "Smoke tests" "Run smoke tests against deployment"

# Assign to specialists
/claude-swarm:swarm-spawn backend-deployer backend-developer sonnet
/claude-swarm:task-update 1 --assign backend-deployer
```

---

## Troubleshooting Integration Issues

**Problem:** Tasks not appearing in team view

- Check that JSON files are valid: `jq . ~/.claude/tasks/my-team/*.json`
- Verify file permissions: `chmod 644 ~/.claude/tasks/my-team/*.json`
- Check team name consistency

**Problem:** Messages not delivered to teammates

- Verify inbox file format is valid JSON
- Ensure teammate can run `/claude-swarm:swarm-inbox`
- Check file permissions on inbox directory

**Problem:** Stale lastSeen timestamps detected

- Check if Claude Code instances are still running
- Verify no zombie processes are blocking updates
- Use `/claude-swarm:swarm-verify` to refresh status

**Problem:** External system can't read team files

- Ensure proper file permissions
- Check that team directory exists
- Verify file paths are correct
- Use absolute paths, not relative paths
