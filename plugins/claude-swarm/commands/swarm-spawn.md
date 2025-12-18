---
description: Spawn a new Claude Code teammate in tmux or kitty with team environment variables
argument-hint: <agent_name> [agent_type] [model] [prompt]
---

# Spawn Teammate

Spawn a new Claude Code teammate. You can only spawn one teammate at a time. You must invoke this command multiple time to spawn multiple teammates.

## Arguments

- `$1` - Agent name (required, e.g., backend-dev, frontend-dev)
- `$2` - Agent type (optional: worker, backend-developer, frontend-developer, reviewer, researcher, tester)
- `$3` - Model (optional: haiku, sonnet, opus - defaults to sonnet)
- `$4` - Initial prompt (optional)

## Auto-Detection

The plugin automatically detects which terminal multiplexer to use:

- **kitty** - If running inside kitty terminal with remote control enabled
- **tmux** - If tmux is available

Override with: `SWARM_MULTIPLEXER=tmux` or `SWARM_MULTIPLEXER=kitty`

## Prerequisites

**For tmux:**

- `tmux` must be installed

**For kitty:**

- Running inside kitty terminal
- Remote control enabled in `~/.config/kitty/kitty.conf`:
  ```
  allow_remote_control yes
  ```

**Both require:**

- A team must exist (create with `/swarm-create` first)
- `CLAUDE_CODE_TEAM_NAME` environment variable must be set (set automatically by `/swarm-create`)

## Kitty Spawn Modes

Set `SWARM_KITTY_MODE` environment variable:

- `split` - Teammates in vertical splits within current tab (default)
- `tab` - Each teammate in separate tab
- `window` - Each teammate in separate OS-level kitty window

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

# Priority: env vars (teammates) > user vars (team-lead) > error
if [[ -n "$CLAUDE_CODE_TEAM_NAME" ]]; then
    TEAM="$CLAUDE_CODE_TEAM_NAME"
else
    TEAM="$(get_current_window_var 'swarm_team')"
fi

NAME="$1"
TYPE="${2:-worker}"
MODEL="${3:-sonnet}"
PROMPT="${4:-}"

if [[ -z "$TEAM" ]]; then
    echo "Error: No team set. Create a team first with /swarm-create"
    exit 1
fi

spawn_teammate "$TEAM" "$NAME" "$TYPE" "$MODEL" "$PROMPT"
SCRIPT_EOF
```

After spawning, report:

1. Teammate name and which multiplexer was used
2. For tmux: How to attach with `tmux attach -t swarm-<team>-<name>`
3. For kitty: Windows use user variables for identification (survives title changes)
4. Suggest assigning a task with `/task-update <id> --assign <name>`
