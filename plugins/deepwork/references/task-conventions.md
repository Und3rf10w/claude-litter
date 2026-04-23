# TaskCreate metadata conventions

Conventions for TaskCreate metadata in deepwork sessions. [hooks/task-completed-gate.sh](../hooks/task-completed-gate.sh) enforces these at completion time.

---

## `metadata.artifact` — single file path, relative to INSTANCE_DIR

**Required form**: a single filename relative to the session's instance directory (`.claude/deepwork/<id>/`).

| Valid | Invalid (rejected by Gate 1) |
|---|---|
| `empirical_results.E1.md` | `/Users/foo/.claude/deepwork/055fdc4f/empirical_results.E1.md` (absolute) |
| `findings.hunter-a.md` | `../../some/other/file.md` (path traversal) |
| `proposals/v2-final.md` | `empirical_results.E1.md,findings.hunter-a.md` (comma-joined treated as filename) |

If a teammate produces multiple artifacts, create **one TaskCreate per artifact** with the same `bar_id`. Comma-joined paths are treated as a literal filename; the existence check will fail.

**Why relative**: the gate discovers the session instance directory from `team_name` (or session_id) and joins `metadata.artifact` to produce the absolute path. Absolute paths in metadata bypass this discovery and leak orchestrator-host filesystem layout into task state. Addresses drift class (i) from [proposals/v3-final.md](../../../.claude/deepwork/055fdc4f/proposals/v3-final.md).

---

## `metadata.cross_check_required` — primary side only, no mirroring

Set `cross_check_required: true` on the **PRIMARY** task only — the one producing the load-bearing null claim. Sibling secondary tasks share the same `bar_id` but set `cross_check_required: false`.

| Shape | Result |
|---|---|
| Primary `{cross_check_required: true}` + sibling `{cross_check_required: false}`, same `bar_id` | Gate waits for ≥2 distinct-owner completions, then both pass |
| Both sides `cross_check_required: true`, same `bar_id` | **DEADLOCK**: each task blocks on the other's "second" completion |

**Why**: the gate counts completions across all tasks sharing `bar_id`; mirroring the flag doesn't change the count but causes each side to think it still needs another confirmation. Every TaskCreate with `cross_check_required` MUST set `owner` — the gate reads owner from the task file, not the hook actor, to preserve distinct-owner integrity (principle 6).

---

## `metadata.bar_id` — pairs tasks to bar criteria

A short string naming the bar criterion the task gates. Every gate-list TaskCreate in SCOPE sets this. When cross-check tasks share a `bar_id`, the gate counts completions across them.

---

## `metadata.scope_items` — optional Gate 4 check

Array of scope sentences the artifact must address. [hooks/task-completed-gate.sh](../hooks/task-completed-gate.sh) Gate 4 greps each sentence literally against the artifact at completion time. By default, missing items produce a warning and the task completes. Set `metadata.scope_strict: true` to block completion on a miss.

This gate fires only when `scope_items` is a non-empty array AND `artifact` exists — it's opt-in. The check uses `grep -F` (fixed-string) so sentences must appear verbatim; paraphrase-tolerance would require semantic matching which the gate does not attempt.

---

## `metadata.commit_sha` — execute-mode only

Plan-mode tasks never set `commit_sha`. In execute-mode, Gate 3 verifies the referenced commit exists in the project repo via `git cat-file -e <sha>^{commit}`.

---

## Quick reference — TaskCreate shape

```javascript
TaskCreate({
  subject: "G6 — hunter-a CC-source null-hunt (PRIMARY)",
  description: "...",
  metadata: {
    bar_id: "G6",
    phase: "explore",
    artifact: "findings.hunter-a.md",     // RELATIVE (no leading /)
    cross_check_required: true,            // PRIMARY side only
    scope_items: ["E1", "E2", "E3", "E4"], // optional Gate 4
  }
})
```

Sibling secondary (matches via bar_id):

```javascript
TaskCreate({
  subject: "G6 — hunter-b CC-source null-hunt (CROSS-CHECK)",
  description: "...",
  metadata: {
    bar_id: "G6",
    phase: "explore",
    artifact: "findings.hunter-b.md",
    cross_check_required: false,           // NOT mirrored
  }
})
```
