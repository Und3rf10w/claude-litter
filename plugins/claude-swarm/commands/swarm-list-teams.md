---
description: List all teams using list_teams() from swarm-utils.sh
---

# List Teams

List all available swarm teams with their status and member counts.

## Instructions

Run the following bash command:

```bash
source "${CLAUDE_PLUGIN_ROOT}/lib/swarm-utils.sh"

list_teams
```

Present the information clearly, highlighting:

1. Team status (active, suspended, archived)
2. Number of members in each team
3. Team descriptions
4. Total team count
