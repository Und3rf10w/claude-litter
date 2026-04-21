---
description: "Karpathy-style 40-word recap of deepwork history — reads DEEPWORK_WIKI.md Overview and the last 3 log entries, outputs 30-50 plain-text words"
allowed-tools: ["Read(.claude/deepwork/DEEPWORK_WIKI.md)"]
---

# Deepwork Recap

Produce a brief plain-text recap of the project's deepwork history. Modeled on CC's own `/recap` — short, factual, no markdown.

## Steps

1. Read `.claude/deepwork/DEEPWORK_WIKI.md`. If the file is absent or empty, respond: `"No deepwork sessions recorded yet."` and stop.

2. Extract:
   - The body of the `## Overview` section (everything between `## Overview` and the next `##` heading)
   - The last 3 entries under `# Log` — each entry is a `## [YYYY-MM-DD]` line

3. Output 1-2 plain sentences. Target 30-50 words. Constraints:
   - No markdown, no bullet points, no headers, no code blocks
   - Factual tone ("N sessions. X approved. Y remains open." — not "Looks like we've been busy!")
   - Lead with the aggregate state, then the most recent decision or open thread
   - Don't editorialize, don't add opinions

Example shape:

> Four deepwork sessions across the project; three approved, one cancelled at SYNTHESIZE. Latest (2026-04-21) approved a changelog pipeline with a dry-run flag. Open thread: the auth middleware rewrite paused on a legal-compliance question.
