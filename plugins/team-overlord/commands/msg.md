---
description: Send a message to an agent
argument-hint: <team> <agent> <message>
---

Use the `send_message` tool from team-overlord. Parse $ARGUMENTS: first word = team name, second word = agent name, remaining text = message content. All three are required — if any are missing, ask the user to provide them.
