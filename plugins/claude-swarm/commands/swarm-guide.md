---
description: Quick reference guide for Claude Swarm workflows and commands
argument-hint: [topic]
---

# Claude Swarm Guide

Quick reference for common swarm workflows.

## Arguments

- `$1` - Optional topic: `workflows`, `commands`, `tips`, `troubleshooting` (default: show all)

## Instructions

Based on the topic argument (or all if not specified), present the relevant sections below.

### Workflows

**Starting a new project:**
```
/claude-swarm:swarm-create my-project "Building feature X"
/claude-swarm:task-create "Implement backend API"
/claude-swarm:task-create "Build frontend components"
/claude-swarm:swarm-spawn backend-dev worker
/claude-swarm:swarm-spawn frontend-dev worker
```

**Checking on your team:**
```
/claude-swarm:swarm-status my-project
/claude-swarm:swarm-inbox
/claude-swarm:task-list
```

**Ending a work session:**
```
/claude-swarm:swarm-cleanup my-project          # Suspend (preserves data)
/claude-swarm:swarm-cleanup my-project --force  # Delete entirely
```

**Resuming work:**
```
/claude-swarm:swarm-list-teams
/claude-swarm:swarm-resume my-project
```

### Commands by Category

**Team Lifecycle:**
| Command | Purpose |
|---------|---------|
| `swarm-create` | Create a new team |
| `swarm-spawn` | Spawn a teammate |
| `swarm-cleanup` | Suspend or delete team |
| `swarm-resume` | Resume suspended team |
| `swarm-list-teams` | List all teams |

**Task Management:**
| Command | Purpose |
|---------|---------|
| `task-create` | Create a task |
| `task-list` | List all tasks |
| `task-update` | Update task status/assignment |
| `task-delete` | Delete a task |

**Communication:**
| Command | Purpose |
|---------|---------|
| `swarm-message` | Send message to teammate |
| `swarm-broadcast` | Message all teammates |
| `swarm-inbox` | Check your messages |
| `swarm-send-text` | Type directly in teammate's terminal |

**Diagnostics:**
| Command | Purpose |
|---------|---------|
| `swarm-status` | Team overview |
| `swarm-diagnose` | Deep health check |
| `swarm-verify` | Check teammates are alive |
| `swarm-reconcile` | Fix status mismatches |

### Tips

- **Model selection**: Use `haiku` for simple tasks, `sonnet` for complex work, `opus` for critical decisions
- **Naming teammates**: Use role-based names (`backend-dev`, `tester`, `docs-writer`)
- **Task granularity**: One clear deliverable per task
- **Check inbox regularly**: Teammates report progress via messages
- **Suspend don't delete**: Use cleanup without `--force` to preserve work

### Troubleshooting

- **Teammate won't spawn**: Run `/claude-swarm:swarm-diagnose <team>`
- **Status mismatch**: Run `/claude-swarm:swarm-reconcile <team>`
- **Teammate unresponsive**: Run `/claude-swarm:swarm-verify <team>`
- **Kitty socket issues**: Check `allow_remote_control` in kitty.conf

For first-time setup, run `/claude-swarm:swarm-onboard`.
