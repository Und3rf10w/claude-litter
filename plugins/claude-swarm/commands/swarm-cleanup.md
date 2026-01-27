---
description: Clean up a swarm team by killing tmux/kitty sessions and optionally removing files
argument-hint: <team_name> [--graceful|--force]
---

# Cleanup Swarm Team

Clean up a team's resources.

## Arguments

- `$1` - Team name (required)
- `$2` - Cleanup mode (optional):
  - `--graceful` - Send shutdown requests and wait for acknowledgment (default)
  - `--force` - Immediately kill sessions AND remove all team data
  - (no flag) - Immediately kill sessions but keep data (suspend)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

if [[ -z "$1" ]]; then
    echo "Error: Team name required"
    echo "Usage: /swarm-cleanup <team_name> [--graceful|--force]"
    echo ""
    echo "Modes:"
    echo "  --graceful  Send shutdown requests, wait for acks (recommended)"
    echo "  --force     Immediately kill and delete all data"
    echo "  (default)   Immediately kill but keep data (suspend)"
    exit 1
fi

TEAM_NAME="$1"
MODE="${2:-}"

case "$MODE" in
    --graceful)
        graceful_cleanup "$TEAM_NAME"
        ;;
    --force)
        cleanup_team "$TEAM_NAME" "--force"
        ;;
    *)
        cleanup_team "$TEAM_NAME"
        ;;
esac
SCRIPT_EOF
```

Report:

1. Which sessions/windows were handled
2. For `--graceful`: which teammates acknowledged shutdown
3. If `--force`: which directories were removed
4. Confirmation that cleanup is complete

**Warning:** If `--force` is used, all team data (config, inboxes, tasks) will be permanently deleted.
