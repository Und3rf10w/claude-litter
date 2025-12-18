---
description: Generate, launch, or save a kitty session file for the swarm (kitty only)
argument-hint: <action> <team_name>
---

# Swarm Session Management

Manage kitty session files for a team.

## Arguments

- `$1` - Action (required): generate, launch, or save
- `$2` - Team name (required)

## Actions

- **generate** - Create a `.kitty-session` file from the team config
- **launch** - Start a new kitty instance with all teammates
- **save** - Save current kitty state to session file

## Session File Location

Session files are stored with the team:

```
~/.claude/teams/{team}/swarm.kitty-session
```

## Prerequisites

This command is for **kitty terminal only**. Requires:

- Running inside kitty terminal
- Remote control enabled in `~/.config/kitty/kitty.conf`:
  ```
  allow_remote_control yes
  ```

## Instructions

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

ACTION="$1"
TEAM="$2"

if [[ -z "$ACTION" ]] || [[ -z "$TEAM" ]]; then
    echo "Error: Action and team name required"
    echo "Usage: /swarm-session <action> <team_name>"
    echo "Actions: generate, launch, save"
    exit 1
fi

case "$ACTION" in
    generate)
        generate_kitty_session "$TEAM"
        ;;
    launch)
        launch_kitty_session "$TEAM"
        ;;
    save)
        save_kitty_session "$TEAM"
        ;;
    *)
        echo "Unknown action: $ACTION"
        echo "Valid actions: generate, launch, save"
        exit 1
        ;;
esac
```

## Example Usage

```bash
# Generate session file from team config
/swarm-session generate my-team

# Launch kitty with all teammates
/swarm-session launch my-team

# Or launch manually:
kitty --session ~/.claude/teams/my-team/swarm.kitty-session
```

## Notes

- Session files include user variables (`--var`) for reliable identification
- Windows can be identified even if claude renames tabs
- The `save` action provides instructions for manual save (kitty limitation)
