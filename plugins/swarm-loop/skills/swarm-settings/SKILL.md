---
description: "Configure swarm loop safety, teammates, and notification settings"
allowed-tools: ["Read(.claude/swarm-loop.local.md)", "Write(.claude/swarm-loop.local.md)", "Edit(.claude/swarm-loop.local.md)", "AskUserQuestion"]
---

# Swarm Settings

Configure the swarm loop behavior. Settings are stored in `.claude/swarm-loop.local.md` and read by the setup script when a new loop starts.

1. Read `.claude/swarm-loop.local.md` if it exists. If not, use defaults.

2. Display current settings as a formatted table:

| Setting | Current Value | Description |
|---|---|---|
| compact_on_iteration | false | Run /compact at end of each iteration |
| min_iterations | 0 | Minimum iterations before completion promise is honored (0 = disabled) |
| max_iterations | 0 | Hard iteration ceiling, force-stops loop (0 = unlimited) |
| sentinel_timeout | 600 | Seconds before force re-inject if orchestrator stuck |
| classifier.enabled | true | Enable safety classifier for Bash commands |
| classifier.model | sonnet | Model for classifier (haiku, sonnet, opus) |
| classifier.effort | auto | Effort level (low, medium, high, max, auto) |
| classifier.checks.pre-tool-use | true | Classify Bash commands before execution |
| classifier.checks.task-completed | false | Verify task completion with agent hook |
| teammates.isolation | shared | Teammate isolation (shared, worktree) |
| teammates.max-count | 8 | Max simultaneous teammates |
| notifications.enabled | false | Enable external notifications |
| notifications.channel | null | Webhook URL for notifications |

3. Ask the user which settings they want to change using AskUserQuestion.

4. Write the updated config back to `.claude/swarm-loop.local.md` in YAML frontmatter format:

```yaml
---
compact_on_iteration: false
min_iterations: 0
max_iterations: 0
sentinel_timeout: 600
classifier:
  enabled: true
  model: sonnet
  effort: auto
  checks:
    pre-tool-use: true
    task-completed: false
teammates:
  isolation: shared
  max-count: 8
notifications:
  enabled: false
  channel: null
---
```

5. Note: Changes take effect on the NEXT `/swarm-loop` start, not the current running loop. To change settings for a running loop, edit the instance state file (`.claude/swarm-loop/<id>/state.json`) directly.

6. If classifier.effort is set to a specific level (low/medium/high/max — not auto), the PreToolUse hook uses `claude -p --bare --effort <level>` (command hook) instead of a native prompt hook. Valid effort levels: `low`, `medium`, `high`, `max` (opus only), `auto`.
