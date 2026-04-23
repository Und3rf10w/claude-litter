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

   **G8 hygiene**: every file reference in the Overview prose uses `[label](path)` markdown syntax, not bare backticked paths. For example: `[v2-final.md](8b9c6a4b/proposals/v2-final.md)` not `` `proposals/v2-final.md` ``. This applies to session IDs, proposal paths, and any other file citations in the narrative. Exceptions: fenced code blocks, shell command arguments, YAML frontmatter, JSON config values.

5. Write the **Session Index** — a markdown table. Every cell referencing a file or session directory uses `[label](path)` syntax:

   | Date | ID | Goal | Phase | Outcome | Final proposal |
   |---|---|---|---|---|---|
   | `<date>` | `[\`<id>\`](<id>/)` | `<goal truncated to 60 chars>` | `<phase>` | approved / cancelled | `[proposals/v<N>-final.md](<id>/proposals/v<N>-final.md)` or `—` |

   Sort by Date descending (newest first). Use `started_at` for the Date column. The ID cell MUST be a link to the session directory (`[<id>](<id>/)`); the Final proposal cell MUST be a link to the proposal file (`[v<N>-final.md](<id>/proposals/v<N>-final.md)`) or `—` when no proposal exists.

6. Write the **Cross-refs** section: identify sessions that share related goals, overlapping guardrails, or anchor the same file paths. For each related pair, note:

   `- [<id-A>](<id-A>/) ↔ [<id-B>](<id-B>/): <one-sentence reason for cross-reference>`

   Session IDs in cross-refs MUST be linkified (`[<id>](<id>/)`) — bare backticked IDs do not satisfy G8. If fewer than 2 archived sessions exist, write `_None yet._`.

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

10. **Sources graph** (Step 6 — runs after step 8, appended as a new section):
   A. Glob all `.md` files in each archived instance dir: `.claude/deepwork/<id>/*.md`
   B. For each file, read the first ~30 lines with the Read tool and extract the YAML
      frontmatter block (from first `---` to the second `---`).
   C. From each parsed frontmatter block, collect:
        - `artifact_type`
        - `author`
        - `bar_id` (or `bar_ids`)
        - `sources[]` (list of source paths cited by this artifact)
   D. Build a consumer×producer edge list: for each (artifact, source_path) pair, emit
      "artifact consumed source_path" — where source_path may itself be another artifact.
   E. Render as a markdown section in DEEPWORK_WIKI.md under `## Sources graph`, grouped
      by `bar_id`, showing:
      ```
      G1:
        - findings.inventory-hunter.md (author: inventory-hunter)
            consumed: profiles/default/PROFILE.md, references/versioning-protocol.md
      ```
   F. Idempotent: if `## Sources graph` already exists, replace it in place (find the
      heading, strip through the next `## ` heading, rewrite). Place the section
      between `## Cross-refs` and `# Log`.
