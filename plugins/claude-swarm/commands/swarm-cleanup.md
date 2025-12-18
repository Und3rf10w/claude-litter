---
description: Clean up a swarm team by killing tmux/kitty sessions and optionally removing files
argument-hint: <team_name> [--force]
---

# Cleanup Swarm Team

Clean up a team's resources.

## Arguments

- `$1` - Team name (required)
- `$2` - Pass `--force` to also remove team directories and task files (optional)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

if [[ -z "$1" ]]; then
    echo "Error: Team name required"
    echo "Usage: /swarm-cleanup <team_name> [--force]"
    exit 1
fi

FORCE_FLAG=""
if [[ "$2" == "--force" ]]; then
    FORCE_FLAG="--force"
fi

cleanup_team "$1" "$FORCE_FLAG"
SCRIPT_EOF
```

Report:

1. Which sessions/windows were killed
2. If `--force`: which directories were removed
3. Confirmation that cleanup is complete

**Warning:** If `--force` is used, all team data (config, inboxes, tasks) will be permanently deleted.
