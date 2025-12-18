---
description: List all teams using list_teams() from swarm-utils.sh
---

# List Teams

List all available swarm teams with their status and member counts.

## Instructions

Execute the following script using bash explicitly:

```bash
bash << 'SCRIPT_EOF'
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh" 1>/dev/null

list_teams
SCRIPT_EOF
```

Present the information clearly, highlighting:

1. Team status (active, suspended, archived)
2. Number of members in each team
3. Team descriptions
4. Total team count
