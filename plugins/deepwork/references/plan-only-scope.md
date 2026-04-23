# Plan-Only Scope Boundary

This document defines what "plan-only" means for DESIGN-mode deepwork teams and what it does NOT mean. It exists because orchestrators were reinventing this boundary per-session — sometimes treating instance-dir edits as out-of-scope, sometimes treating target-repo reads as violations.

**This is a reference, not a hook-enforced gate.** No code reads this file to block behavior. Its purpose is to give orchestrator prompts and user guardrails a consistent, citable definition.

---

## Scope boundary

### Target repository (the project CC was invoked in)

**OFF-LIMITS during DESIGN mode.** The team produces an approved plan document; the plan is handed to a human or a downstream execute-mode session for implementation. No `Write`, `Edit`, or `Bash` that mutates source files under the project's working tree.

- Reads are fine — source-of-truth files may live in the target repo and teammates must inspect them.
- Target-repo `.claude/deepwork/<id>/` is in-scope (it *is* the instance directory, even though nested in the project).

### Instance directory — `.claude/deepwork/<INSTANCE_ID>/`

**IN-SCOPE always.** Every teammate output lives here:

- `proposals/v<N>.md` — versioned proposals.
- `findings.*.md`, `coverage.*.md`, `mechanism.*.md`, `reframe.*.md`, `critique.*.md`, `empirical_results.*.md` — teammate artifacts.
- `log.md` — narrative history.
- `anchors.md`, `gate-list-*.md` — scope/bar artifacts.
- `state.json` — authoritative session record.

Writing to instance-dir files is not a plan-only violation.

### Plugin internals — `plugins/deepwork/`, `plugins/swarm-loop/`, etc.

**OFF-LIMITS.** Teammates do not modify the plugin running them. The plan describes target-repo changes, not plugin changes.

Exception: the `/deepwork-execute-amend`, `/deepwork-guardrail`, and `/deepwork-bar` skills mutate the *current session's* state.json — that's instance-dir scope, not plugin scope.

### Home directory / team metadata — `~/.claude/teams/`, `~/.claude/tasks/`

**INDIRECT-SCOPE only.** Team/task state lives here, but teammates interact with it via the team tools (`TeamCreate`, `Agent`, `TaskCreate`, `TaskUpdate`, `SendMessage`). Direct filesystem manipulation of these paths is not plan-only-appropriate — use the tools.

---

## Template guardrail text

Orchestrators can seed this at SCOPE phase by appending to `state.json.guardrails[]`:

```json
{
  "rule": "Plan-only scope: do not edit files in the target repository or the deepwork plugin. Writes to .claude/deepwork/<instance_id>/ artifacts and session state.json are in-scope.",
  "source": "scope-boundary",
  "timestamp": "<ISO-8601>"
}
```

Or via the guardrail skill once `--source` lands:

```
/deepwork-guardrail add --source scope-boundary "Plan-only scope: ..."
```

---

## When plan-only does NOT apply

- **Execute mode** is not plan-only. EXECUTOR writes to target-repo files by design, gated by `plan-citation-gate.sh`, `task-scope-gate.sh`, and the test-evidence hooks — not by this boundary.
- **Amendments** (`/deepwork-execute-amend`) during execute mode can introduce scope deltas. Those are audited via `state.json.execute.scope_amendments[]`, not blanket-blocked by plan-only.

---

## Why this is not a hook-enforced gate

A PreToolUse hook on Write/Edit that enforced plan-only would need to know:

1. Current mode — available via `state.json.mode`.
2. What counts as "target repo" vs instance dir — path-prefix check.
3. What counts as an exemption (amendments, skill writes, orchestrator-owned state.json updates) — context-dependent.

Item 3 is the problem. The cost of a false-positive block (rejecting a legitimate REFINE edit) exceeds the cost of a false-negative (accepting an out-of-scope write that the orchestrator catches in self-review against the bar's G3 scope-boundary criterion). Per team guidance, hooks that block turn-end must have clearly falsifiable conditions; plan-only scope has too much context-dependent nuance for a generic pre-Write gate.

If hook enforcement becomes warranted for a specific subsystem, wire it as a narrowly-scoped PreToolUse — see `hooks/execute/plan-citation-gate.sh` for the citation-first pattern, or `hooks/execute/task-scope-gate.sh` for the files[]-whitelist pattern.
