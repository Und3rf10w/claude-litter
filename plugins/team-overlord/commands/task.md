---
description: List and manage tasks
argument-hint: [team] [task-id]
---

Use the team-overlord MCP tools. Parse $ARGUMENTS:
- If two words are given, treat the first as team name and second as task ID — call `get_task` to show details.
- If one word is given, treat it as the team name — call `list_tasks` to show all tasks for that team.
- If empty, call `list_teams` first to get all team names, then call `list_tasks` for each team and show a combined overview.
