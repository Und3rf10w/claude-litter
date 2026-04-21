---
description: "Synthesize the deepwork wiki — rewrites Overview, Session Index, and Cross-refs in .claude/deepwork/DEEPWORK_WIKI.md from archived sessions. Preserves the # Log section verbatim (hook owns it)."
allowed-tools: ["Glob", "Grep", "Read(.claude/deepwork/**)", "Read(.claude/deepwork/DEEPWORK_WIKI.md)", "Write(.claude/deepwork/DEEPWORK_WIKI.md)", "Edit(.claude/deepwork/DEEPWORK_WIKI.md)", "Bash(ls .claude/deepwork/:*)"]
---

# Deepwork Wiki Synthesis

Regenerate the synthesis sections of `.claude/deepwork/DEEPWORK_WIKI.md` from every archived deepwork session in this project.

## Steps

1. Find archived sessions:
```
Glob: .claude/deepwork/*/state.archived.json
```
If none, report "No archived deepwork sessions found. Run `/deepwork` and complete a session first." and stop.

2. Read `.claude/deepwork/DEEPWORK_WIKI.md` if it exists. **Extract the entire `# Log` section verbatim** — everything from the `# Log` heading to EOF. You must preserve this byte-for-byte (the hook owns it). If DEEPWORK_WIKI.md doesn't exist, the Log is empty; the hook creates the file on the first archive event.

3. For each archived state file, read and extract:
   - `id` — the 8-hex directory basename
   - `goal`
   - `phase` — e.g., `"done"` (approved) or a mid-flight phase like `"scope"`/`"explore"`/`"synthesize"`/`"critique"`/`"refine"`/`"refining"` (cancelled at that phase)
   - `started_at` / `last_updated`
   - `bar[]` — criteria with their `verdict` fields
   - `empirical_unknowns[]` — unknowns explored + their results
   - `user_feedback` — if present
   - `guardrails[]` — guardrails accumulated during the session
   - Also check for `proposals/` directory and note the highest-versioned `v*.md` (especially `v*-final.md`) — the delivered proposal.

4. Write the **Overview** section: 2-5 sentences summarizing:
   - Recurring themes across sessions (topics that came up more than once)
   - Architectural commitments that were approved and should persist
   - Open questions / unresolved threads (cancelled sessions, disputed bar criteria)
   - Cross-session patterns worth flagging
   Avoid per-session detail — that belongs in the Session Index.

5. Write the **Session Index** — a markdown table:

   | Date | ID | Goal | Phase | Outcome | Final proposal |
   |---|---|---|---|---|---|
   | `<date>` | `<id>` | `<goal truncated to 60 chars>` | `<phase>` | approved / cancelled | `proposals/v<N>-final.md` or `—` |

   Sort by Date descending (newest first). Use `started_at` for the Date column.

6. Write the **Cross-refs** section: identify sessions that share related goals, overlapping guardrails, or anchor the same file paths. For each related pair, note:

   `- [<id-A>] ↔ [<id-B>]: <one-sentence reason for cross-reference>`

   If fewer than 2 archived sessions exist, write `_None yet._`.

7. Assemble the new DEEPWORK_WIKI.md content with this structure, placing the **verbatim `# Log` section** at the end:

   ```
   # Deepwork Wiki

   <!-- AUTO-MANAGED. Run /deepwork-wiki to regenerate synthesis sections. -->

   ## Overview

   <your synthesis from step 4>

   ## Session Index

   <your table from step 5>

   ## Cross-refs

   <your cross-refs from step 6, or "_None yet._">

   # Log

   <verbatim Log section from step 2 — do not modify>
   ```

8. Write the result to `.claude/deepwork/DEEPWORK_WIKI.md` via the `Write` tool.

9. Report to the user:
   - Number of sessions synthesized
   - Date range covered (oldest → newest)
   - A 1-line summary of the Overview
