# Deepwork

Deepwork is a Claude Code plugin for **research and design convergence** via a 5-archetype oppositional team. The team debates, CRITIC holds the veto, REFRAMER challenges the premise, and only evidence-backed proposals ship. Delivery is via `ExitPlanMode` — the team never crosses into implementation.

## When to use it

Use `/deepwork` when:

- The mechanism or answer is genuinely unknown and you're betting architecture on it
- Stakes are high (production, cross-plugin coupling, irreversible design)
- A solo agent has tried and gotten stuck or produced a fragile answer
- You need the confidence of independent cross-verification (especially for nulls)

## When NOT to use it

- Execution tasks where the mechanism is known — just write the code
- Questions with a documented answer — read the docs
- Problems without falsifiable structure ("make this faster" without a specific bottleneck)
- Small reversible changes (10-line bug fix doesn't need 4.5h of adversarial review)
- You don't have file:line anchors to hand to agents — do a solo pre-audit first

See `references/when-not-to-use.md` for the full decision flowchart.

## The ten principles

1. **Structural adversarialism** beats cooperative consensus. Roles designed to disagree.
2. **Put the veto in one place** with a written bar. CRITIC alone holds APPROVED; the bar has categorical bans.
3. **Reframing is a first-class move.** Always spawn REFRAMER; rejected reframes still surface invalid assumptions.
4. **File:line anchors** turn opinions into evidence. No anchors → not team-ready.
5. **Institutional memory lives in prompts.** Incident-derived guardrails auto-accumulate and re-render to every spawn.
6. **Independent cross-checks produce reliable nulls.** ≥2 FALSIFIERs reach the same null from different starts.
7. **Live empiricism** beats documentation for load-bearing unknowns. Test on real infrastructure before synthesizing.
8. **Named versioning** forces honest deltas. Every proposal version change bumps and states the delta.
9. **Default-off** ships risky mechanisms safely. Unverified mechanisms ship as opt-in flags in the delivered plan.
10. **The human's job is steering, not authoring.** Goal definition, drift correction, pacing. Not coding.

## The 5 archetypes

| Archetype | Incentive | Counter-incentive |
|---|---|---|
| **FALSIFIER** | Find the mechanism / find the answer | Prove the mechanism *doesn't* exist |
| **COVERAGE** | Map across environments | Admit where it won't work |
| **MECHANISM** | Design the cleanest runtime artifact | Surface the failure modes |
| **REFRAMER** (required) | Challenge whether the thing should be built as stated | Deliver the spec as-is |
| **CRITIC** (invariant) | Gate everything | Say APPROVED only when evidence clears the bar |

**CRITIC is the only invariant role.** The other four are instantiated dynamically per-problem — a CLI-internals task spawns a `hunter` for FALSIFIER; a security audit spawns an `auditor`. The archetype, not the name, is what matters.

See `references/archetype-taxonomy.md` for composition patterns per problem shape (research / design / audit / debate / migration).

## Requirements

- **Agent teams** — `TeamCreate`, `Agent` (with `team_name`+`name`), `SendMessage`, `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` must be available (Claude Code agent teams feature)
- **jq** — required for state management and hook logic
- **perl** — required for profile template substitution
- **bash 3.2+** — POSIX bash

## Installation

From the marketplace:
```
/plugin marketplace add Und3rf10w/claude-litter
/plugin install deepwork@claude-litter
```

Local testing:
```
claude --plugin-dir ./plugins/deepwork
```

## Quick start

```
/deepwork "Design a feature flag system for project X" \
  --source-of-truth ./docs/architecture.md \
  --anchor src/config.ts:45 \
  --guardrail "no breaking changes to public API"
```

The setup script creates an instance directory at `.claude/deepwork/<8-hex-id>/`, wires dynamic hooks tagged `_deepwork: true` into `.claude/settings.local.json` (with automatic backup), and prints the orchestrator prompt with the goal + tool reference + archetype taxonomy + bar template all appended.

The orchestrator then runs the phase pipeline:

**SCOPE → EXPLORE → SYNTHESIZE → CRITIQUE → (REFINE → CRITIQUE)* → DELIVER → HALT**

User surface during the run is minimal by design — `AskUserQuestion` is reserved for the 5 legitimate cases documented in `references/ask-guidance.md`. Final delivery is via `ExitPlanMode` — user approves (session completes) or rejects with feedback (orchestrator re-enters REFINE).

## Commands

| Command | Description |
|---|---|
| `/deepwork <goal> [flags]` | Start a deepwork session. |
| `/deepwork-status` | Dashboard: phase, team, bar verdicts, proposal versions, guardrails. |
| `/deepwork-cancel` | Tear down team (only path that calls TeamDelete) and clean up. |
| `/deepwork-guardrail add\|remove\|list "<rule>"` | Manual guardrail management. |
| `/deepwork-bar add\|remove\|list "<criterion>"` | Tune the written bar mid-run. |

## Flags for `/deepwork`

| Flag | Description |
|---|---|
| `--source-of-truth <path>` | Authoritative doc/bundle/spec. Repeatable. Rendered in every teammate prompt. |
| `--anchor <file:line>` | File-path-with-line-number starting point. Repeatable. |
| `--guardrail '<rule>'` | Hard-safety constraint. Repeatable. Rendered in every teammate spawn. |
| `--bar '<criterion>'` | Pre-seed a bar criterion. Orchestrator augments in SCOPE to reach 6-criteria minimum. |
| `--safe-mode true\|false` | Autonomous hooks (default: true). Safe mode wires PermissionRequest auto-approve. |
| `--team-name <name>` | Override default team name derivation. |
| `--mode <name>` | Profile (default: `default`; only one profile ships in v1). |

## How it works

### The phase pipeline

1. **SCOPE** — orchestrator populates the written bar (6 criteria minimum, ≥1 categorical_ban), identifies empirical unknowns, composes the team (CRITIC + 4 archetype instantiations), creates TeamCreate + gate-list TaskCreate entries, spawns all teammates in parallel.

2. **EXPLORE** — teammates work in parallel. Each writes their archetype artifact (`findings.<name>.md`, `coverage.<name>.md`, `mechanism.<name>.md`, `reframe.<name>.md`). MECHANISM also produces `empirical_results.<id>.md` via live testing for each load-bearing unknown.

3. **SYNTHESIZE** — blocks until all empirical_results files exist and all cross-check-required gates have ≥2 independent completions. Then orchestrator reads all artifacts and writes `proposals/v1.md`.

4. **CRITIQUE** — CRITIC emits per-gate verdicts (PASS / CONDITIONAL / FAIL) with evidence citations. Writes `critique.v<N>.md`.

5. **REFINE** (conditional) — if any gate is non-PASS, orchestrator addresses and bumps to `proposals/v2.md` with populated `delta_from_prior`. Back to CRITIQUE.

6. **DELIVER** — when all gates PASS and CRITIC emits APPROVED, orchestrator calls `ExitPlanMode` with the final proposal content. User approves (session ends) or rejects (REFINE with feedback).

7. **HALT** — orchestrator outputs final status, does NOT cross into implementation.

### Hooks wired dynamically

When `/deepwork` runs, `setup-deepwork.sh` writes these into `.claude/settings.local.json` tagged with `_deepwork: true`:

| Event | Hook | Purpose |
|---|---|---|
| PermissionRequest | auto-approve | Enables autonomous operation (safe-mode default) |
| SubagentStop | `incident-detector.sh --event SubagentStop` | Appends to `incidents.jsonl` on teammate failures |
| SessionStart(clear\|compact) | `session-context.sh` | Re-injects orchestrator identity after /clear or /compact |
| TaskCompleted | `task-completed-gate.sh` | Artifact-existence + cross-check count enforcement |
| PermissionDenied | `incident-detector.sh --event PermissionDenied` | Appends to `incidents.jsonl` on denied operations |
| PreToolUse:ExitPlanMode | `deliver-gate.sh` | Lints ExitPlanMode content for "Residual unknowns" section + delta_from_prior populated on v≥2 |

Plus the static hook in `hooks/hooks.json`:

| Event | Hook | Purpose |
|---|---|---|
| TeammateIdle | `teammate-idle-gate.sh` | Forces teammates with in_progress tasks to complete or send results (up to 3 retries, then releases with incident guardrail) |

### State persistence

All state lives in `.claude/deepwork/<instance-id>/`:

- `state.json` — goal, bar, guardrails, source_of_truth, anchors, role_definitions, empirical_unknowns, phase, user_feedback
- `incidents.jsonl` — append-only incident log (SubagentStop non-zero, PermissionDenied). Consolidated into rendered `{{HARD_GUARDRAILS}}` per render, deduped by `incident_ref`.
- `log.md` — narrative history
- `anchors.md` — file:line map (produced in SCOPE)
- `findings.<name>.md`, `coverage.<name>.md`, `mechanism.<name>.md`, `reframe.<name>.md` — archetype artifacts
- `empirical_results.<E_id>.md` — live-test outputs
- `proposals/v1.md`, `v2.md`, ...`v<N>-final.md` — named proposal versions with `delta_from_prior`
- `critique.v<N>.md` — CRITIC's per-version verdicts
- `prompt.md` — original user prompt

The instance directory is per-project, per-session, keyed on an 8-hex hash of `$CLAUDE_CODE_SESSION_ID`. Multiple concurrent deepwork sessions in different terminals do not collide.

## Trust boundaries

- **Teammate names** are harness-set at `TeamCreate` and sanitized (`[^a-zA-Z0-9_-]` → `_`). They are trusted identifiers, not user-authored content.
- **User-supplied guardrails** (via `--guardrail` or `/deepwork-guardrail add`) are user-trusted and rendered verbatim.
- **Incident-sourced guardrails** (via `incidents.jsonl`) are character-restricted and length-capped (`tool_input` is truncated at 120 bytes; teammate names pass through `tr -cd`).
- **Threat model**: same-tenant — deepwork assumes all teammates in a team are controlled by the same user. A hostile teammate could embed text in a `tool_input` that surfaces in a peer's rendered guardrail; this is a same-tenant privilege-escalation surface, not cross-tenant. v1.1 adds control-byte stripping + fencing in `render_guardrails` to narrow the surface further.

## Safety / design boundaries

- **Does NOT implement.** The plugin never writes code changes to the target codebase. It only produces proposals and references.
- **Does NOT call TeamDelete from the orchestrator.** Only `/deepwork-cancel` tears down the team.
- **Does NOT overwrite settings.local.json irrecoverably.** Automatic backup + selective jq-based teardown (`_deepwork: true` tag filter) preserves hooks added by other plugins or by the user during the session.
- **SessionStart re-inject** — `hooks/session-context.sh` fires on `SessionStart(clear|compact)` and reconstructs the orchestrator prompt from disk-backed state.json + log.md.
- **Parallel-safe.** 8-hex instance IDs scope all state. Multiple sessions in different terminals operate independently (setup itself is serialized on `.claude/deepwork.local.lock`).

## Failure modes this pattern prevents

See `references/failure-modes.md` for the pedagogical table of specific failure modes this pattern catches — silent cargo-cult, double-injection race, permission-dialog blast, print-mode confusion, marker-ordering race, wrong-problem solution, vague null, and others. Each row names what would have shipped without the pattern, and which principle caught it.

## References directory

Progressive disclosure — the orchestrator loads these on demand:

- `references/tool-reference.md` — explicit TeamCreate / Agent / TaskCreate / TaskUpdate / TaskList / TaskGet / SendMessage / AskUserQuestion / ExitPlanMode syntax
- `references/archetype-taxonomy.md` — the 5 archetypes + composition patterns per problem shape
- `references/critic-stance.md` — invariant CRITIC system-prompt text
- `references/reframer-stance.md` — invariant REFRAMER mandate
- `references/written-bar-template.md` — 6-criteria bar scaffold with categorical-bans section
- `references/ask-guidance.md` — WHEN and WHEN NOT to use AskUserQuestion (5 legitimate situations)
- `references/versioning-protocol.md` — named versioning and delta_from_prior spec
- `references/when-not-to-use.md` — non-use cases + decision flowchart
- `references/failure-modes.md` — pedagogical reference table

