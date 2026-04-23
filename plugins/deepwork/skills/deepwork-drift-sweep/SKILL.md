---
description: "Enumerate ALL workstreams in the current deepwork session and diff each artifact against its source-of-truth. Produces drift-report.vN.md listing potential drift items across every workstream, not only those flagged by the drift agent."
allowed-tools: ["Read", "Glob", "Grep", "Bash", "Write"]
---

# Deepwork Drift Sweep

Addresses drift class (g) from [proposals/v3-final.md](.claude/deepwork/055fdc4f/proposals/v3-final.md): partial / cluster-scoped drift sweeps miss items outside the scope the drift agent identified. This skill enumerates ALL workstreams so a secondary pass catches what the primary drift agent omitted.

## When to use

Run at SYNTHESIZE step 1 before consolidating the proposal. Also run on demand whenever the orchestrator wants to verify no workstream has silently drifted from its source-of-truth.

## Steps

1. **Locate the active instance.** Glob `.claude/deepwork/*/state.json` and pick the one whose `session_id` matches the current `$CLAUDE_CODE_SESSION_ID`, or (if unavailable) the most-recently-updated. Call its directory `INSTANCE_DIR`.

2. **Enumerate workstreams.** Read these sources in order:
   - `coverage.mapper.md` (if present) — each plan_section row names a workstream.
   - All `findings.*.md` and `mechanism.*.md` in `INSTANCE_DIR` — each is an artifact produced by some workstream.
   - `reframe.*.md` and any `empirical_results.E*.md`.
   - `state.json.source_of_truth[]` — the upstream files every workstream depends on.
   - `state.json.role_definitions[]` — each role has an `output_artifact` field.

   Build a list: `[{workstream, artifact_path, source_of_truth_paths[]}]`. One entry per artifact; a workstream spanning multiple artifacts becomes multiple entries.

3. **Diff each workstream.** For every `(artifact, source)` pair:
   - Read the artifact.
   - Read the source-of-truth file.
   - Look for claims in the artifact that reference specific line numbers, file contents, or quoted strings in the source. If any such claim no longer matches the source (line moved, text changed, file deleted), record a drift item: `{workstream, artifact, source, claim, current_source_state, severity}`.
   - Severity heuristic: `high` if the artifact quotes text verbatim and the quote is gone; `medium` if it cites a file:line where the content changed; `low` if the citation is now off by ±10 lines.

4. **Compare to prior sweeps.** If a `drift-report.v<N-1>.md` exists, parse its items. For the new report:
   - Mark items present in both as `existing` (carried over).
   - Items only in new sweep: `new`.
   - Items only in prior: `resolved`.

5. **Write `drift-report.v<N>.md`** in the INSTANCE_DIR with the shape:

   ```markdown
   ---
   generated_at: <ISO8601>
   workstreams_scanned: <N>
   items_total: <M>
   items_new: <X>
   items_resolved: <Y>
   sweep_version: v<N>
   ---

   # Drift sweep v<N>

   ## Summary
   <one-line summary>

   ## Per-workstream items

   ### <workstream_name>
   - [severity] <claim> ([artifact](artifact_path):L<N>) vs [source](source_path):L<M> — <current source state>
   - ...
   ```

6. **Emit the final summary line** (stdout, plain text — the orchestrator reads it):
   ```
   N items found across M workstreams. Previous sweep found X items. Delta: N-X new, Y resolved.
   ```

## Secondary-pass protocol

After the sweep completes, the orchestrator MUST do a secondary pass:

For each workstream in the enumerated list NOT mentioned in the sweep report, manually confirm it is either (a) not yet started, or (b) has no open source-of-truth dependency. Sign off in `log.md`:

```
Secondary pass complete: N workstreams checked, M had no drift items.
```

Without this secondary pass, the sweep is still only as exhaustive as the sweep agent's output. The PROFILE.md SYNTHESIZE step references this discipline.

## Invariants preserved

- **Inv1 (structural adversarialism)**: sweep reports gaps, does NOT resolve them. Debate over resolution stays in the team.
- **Inv6 (backward compat)**: skill is opt-in (invoked by orchestrator). Sessions not using it are unaffected.
