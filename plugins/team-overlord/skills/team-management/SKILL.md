---
name: Team Management
description: This skill should be used when the user asks to "manage teams", "create a team", "create a task", "assign a task", "send a message to an agent", "list teams", "check tasks", "broadcast to team", "read inbox", "update task status", or any team/task/agent/message management operation.
version: 1.0.0
---

# Team Management

Use the team-overlord MCP tools to manage Claude Code agent teams, tasks, and messages.

## Available Tools

### Read-only
- **list_teams** — List all teams with members and status
- **get_team(team)** — Get full team configuration
- **list_tasks(team, status?)** — List tasks, optionally filtered by status (`pending`, `in_progress`, `completed`)
- **get_task(team, task_id)** — Get a single task by ID
- **read_inbox(team, agent)** — Read an agent's message inbox

### Write
- **create_team(name, description?)** — Create a new team with directories and config
- **create_task(team, subject, description?)** — Create a task (auto-increments ID)
- **update_task(team, task_id, status?, owner?, subject?, description?)** — Update task fields (only non-empty values are changed)
- **send_message(team, to, text)** — Send a message to a specific agent
- **broadcast_message(team, text)** — Send a message to all agents in a team

## Data Schemas

### Team Config (`~/.claude/teams/<name>/config.json`)
```json
{
  "name": "team-name",
  "description": "",
  "createdAt": 1710000000000,
  "leadAgentId": "name@team",
  "leadSessionId": "uuid",
  "members": [
    {
      "agentId": "name@team",
      "name": "agent-name",
      "agentType": "worker",
      "model": "sonnet",
      "color": "blue",
      "cwd": "/path/to/project"
    }
  ]
}
```

### Task (`~/.claude/tasks/<team>/<id>.json`)
```json
{
  "id": "1",
  "subject": "Task title",
  "description": "Detailed description",
  "status": "pending|in_progress|completed",
  "owner": "agent-name",
  "blocks": ["2"],
  "blockedBy": []
}
```

### Inbox Message (`~/.claude/teams/<team>/inboxes/<agent>.json`)
Array of messages:
```json
{
  "from": "sender-name",
  "text": "message content",
  "timestamp": "ISO 8601",
  "read": false,
  "summary": "optional preview",
  "color": "optional badge color"
}
```

## Common Workflows

### Create a team and set up tasks
1. `create_team("my-team", "Building feature X")`
2. `create_task("my-team", "Implement auth", "Add JWT authentication...")`
3. `update_task("my-team", "1", owner="researcher")`

### Monitor progress
1. `list_teams()` — overview of all teams
2. `list_tasks("my-team", "in_progress")` — what's being worked on
3. `read_inbox("my-team", "researcher")` — check agent's messages

### Communicate with agents
1. `send_message("my-team", "researcher", "Please prioritize the auth task")`
2. `broadcast_message("my-team", "Stand down — merging to main now")`

## Context

Each prompt includes a `<team-context>` block showing current team state (members, statuses, task counts). Use the tools to act on this state — the context block is read-only and reflects the latest disk state.

## Limitations

- **Spawning/killing agents** requires the TUI's AgentManager (live SDK sessions). Use `/spawn` and `/kill` commands for those operations.
- All data is stored as JSON under `~/.claude/`. Changes are immediately visible to the TUI via filesystem watching.
