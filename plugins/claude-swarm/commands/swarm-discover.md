---
description: Discover active teams available for joining
argument-hint: [--all]
---

# Discover Teams

List active teams that can be joined by external agents.

## Arguments

- `--all` - Show all teams including suspended (optional)

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

SHOW_ALL="${1:-}"

echo "Discoverable Teams"
echo "=================="
echo ""

# List all teams
if [[ ! -d "$TEAMS_DIR" ]] || [[ -z "$(ls -A "$TEAMS_DIR" 2>/dev/null)" ]]; then
    echo "No teams found."
    exit 0
fi

found=0
for team_dir in "$TEAMS_DIR"/*/; do
    [[ -d "$team_dir" ]] || continue
    config_file="${team_dir}config.json"
    [[ -f "$config_file" ]] || continue

    team_name=$(jq -r '.name // .teamName' "$config_file")
    description=$(jq -r '.description // "No description"' "$config_file")
    status=$(jq -r '.status // "unknown"' "$config_file")
    member_count=$(jq -r '.members | length' "$config_file")
    created=$(jq -r '.createdAt // "unknown"' "$config_file")

    # Skip suspended unless --all
    if [[ "$status" == "suspended" ]] && [[ "$SHOW_ALL" != "--all" ]]; then
        continue
    fi

    found=1
    echo "Team: ${team_name}"
    echo "  Description: ${description}"
    echo "  Status: ${status}"
    echo "  Members: ${member_count}"
    echo "  Created: ${created}"
    echo ""
done

if [[ $found -eq 0 ]]; then
    echo "No active teams found."
    if [[ "$SHOW_ALL" != "--all" ]]; then
        echo "Use --all to include suspended teams."
    fi
fi
SCRIPT_EOF
```

Report:

1. List of discoverable teams with their details
2. Suggest `/swarm-join <team-name>` to request joining a team
