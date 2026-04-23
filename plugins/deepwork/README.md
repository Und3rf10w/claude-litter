# Deepwork

## §1 What deepwork is

Deepwork is a Claude Code plugin for **research/design convergence and plan execution** via a role-asymmetric oppositional team. It has two modes: **DESIGN mode** produces an evidence-backed, CRITIC-approved plan via `ExitPlanMode`; **EXECUTE mode** implements that plan gate-by-gate with hook-enforced citation, test-evidence, and reversibility gates. The team never implements without a gate-cleared plan.

---

## §2 When to use / when NOT

Use `/deepwork` when the mechanism is genuinely unknown, stakes are high (production, cross-system coupling, irreversible design), a solo agent has gotten stuck, or you need the confidence of independent cross-verification (especially for nulls).

Do NOT use when the answer is documented, the task is pure execution, or the problem lacks falsifiable structure.

See `references/when-not-to-use.md` for the full decision flowchart, including cases where **execute mode** is not appropriate (no gate list, unapproved plan, amendment spans ≥3 gates).

---

## §3 The ten principles

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

---

## §4 The 5 archetypes

| Archetype | Incentive | Counter-incentive |
|---|---|---|
| **FALSIFIER** | Find the mechanism / find the answer | Prove the mechanism *doesn't* exist |
| **COVERAGE** | Map across environments | Admit where it won't work |
| **MECHANISM** | Design the cleanest runtime artifact | Surface the failure modes |
| **REFRAMER** (required) | Challenge whether the thing should be built as stated | Deliver the spec as-is |
| **CRITIC** (invariant) | Gate everything | Say APPROVED only when evidence clears the bar |

**CRITIC is the only invariant role.** The other four are instantiated dynamically per-problem — a CLI-internals task spawns a `hunter` for FALSIFIER; a security audit spawns an `auditor`. The archetype, not the name, is what matters.

See `references/archetype-taxonomy.md` for composition patterns per problem shape (research / design / audit / debate / migration).

---

## §5 Requirements

- **Agent teams** — `TeamCreate`, `Agent`, `SendMessage`, `TaskCreate`/`TaskUpdate`/`TaskList`/`TaskGet` must be enabled (Claude Code experimental agent teams)
- **jq** — required for state management and hook logic
- **perl** — required for profile template substitution
- **bash 3.2+** — macOS and Linux supported

---

## §6 Install / activate

From the marketplace:
```
/plugin marketplace add Und3rf10w/claude-litter
/plugin install deepwork@claude-litter
```

> **Important**: enable agent teams by adding `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` to your `settings.json` or environment before running.

Local testing:
```
claude --plugin-dir ./plugins/deepwork
```

---

## §7 Two modes at a glance

| | DESIGN mode | EXECUTE mode |
|---|---|---|
| **Trigger** | `/deepwork "<goal>" [flags]` | `/deepwork --mode execute --plan-ref <path>` |
| **Purpose** | Converge on an evidence-backed design | Implement an approved plan faithfully |
| **Deliverable** | CRITIC-approved `proposals/vN-final.md` via `ExitPlanMode` | LANDed diffs per gate, recorded in `change_log[]` |
| **Pipeline** | `SCOPE → EXPLORE → SYNTHESIZE → CRITIQUE → (REFINE)* → DELIVER → HALT` | `SETUP → WRITE → VERIFY → CRITIQUE → (REFINE)* → LAND → CONTINUOUS-LOOP → HALT` |
| **User surface** | AskUserQuestion (5 cases); ExitPlanMode approval | AskUserQuestion only on `halt` discovery |
| **Use when** | Mechanism unknown; stakes high; solo agent stuck | Plan is CRITIC-approved; gates are explicit |

Plan handoff: `templates/synthesis/plan-to-execute.md` is the orchestrator-internal template that structures a plan document suitable for execute mode. It is not a user-facing CLI flag.

---

## §8 Quickstart — DESIGN mode

```
/deepwork "Design a feature flag system for project X" \
  --source-of-truth ./docs/architecture.md \
  --anchor src/config.ts:45 \
  --guardrail "no breaking changes to public API"
```

The setup script creates an instance directory at `.claude/deepwork/<8-hex-id>/`, wires dynamic hooks tagged `_deepwork: true` into `.claude/settings.local.json` (with automatic backup), and prints the orchestrator prompt.

Expected outcome: CRITIC emits APPROVED and the orchestrator calls `ExitPlanMode` with the final proposal content. You approve (session completes) or reject with feedback (orchestrator re-enters REFINE).

For phase details, see §12 below and `profiles/default/PROFILE.md` for the authoritative orchestrator contract.

---

## §9 Quickstart — EXECUTE mode

```
/deepwork --mode execute \
  --plan-ref /abs/path/to/proposals/vN-final.md \
  [--authorized-push]
```

At SETUP, `plan_hash` (SHA-256 of the plan file) is frozen and never changes. Before any file write, executor produces `pending-change.json` in the instance directory citing the plan section. `hooks/execute/plan-citation-gate.sh` reads this file and blocks writes with missing or null citations.

Expected outcome: each plan gate goes through WRITE→VERIFY→CRITIQUE; when all gates are APPROVED and LANDed, the session halts cleanly.

For the full pipeline, all 8 execute hooks, state fields, and amendment mechanics, see `references/execute-mode.md`. For the authoritative orchestrator contract, see `profiles/execute/PROFILE.md`.

---

## §10 Commands

| Command | Purpose | Skill contract |
|---|---|---|
| `/deepwork <goal> [flags]` | Start a DESIGN or EXECUTE mode session | `skills/deepwork/SKILL.md` |
| `/deepwork-status` | Dashboard: phase, team, bar verdicts, proposals, guardrails | `skills/deepwork-status/SKILL.md` |
| `/deepwork-execute-status` | Execute-mode dashboard: phase, plan_hash, drift, change_log, test results | `skills/deepwork-execute-status/SKILL.md` |
| `/deepwork-teardown` | End a session — delete team (only path that calls TeamDelete), archive state, restore settings. Use for mid-flight abort or post-HALT cleanup | `skills/deepwork-teardown/SKILL.md` |
| `/deepwork-guardrail add\|replace\|remove\|list [--source <src>] "<rule>"` | Manual guardrail management (sources: `user`, `incident`, `flag`, `scope-boundary`, `orchestrator`, `teammate`) | `skills/deepwork-guardrail/SKILL.md` |
| `/deepwork-bar add\|remove\|list "<criterion>"` | Tune the written bar mid-run | `skills/deepwork-bar/SKILL.md` |
| `/deepwork-execute-amend <gate-id> --reason "<desc>"` | Single-gate amendment (MICRO-TEAM re-verdict) | `skills/deepwork-execute-amend/SKILL.md` |
| `/deepwork-wiki` | Regenerate Overview, Session Index, and Cross-refs in DEEPWORK_WIKI.md | `skills/deepwork-wiki/SKILL.md` |
| `/deepwork-recap` | 30-50-word plain-text recap of deepwork history | `skills/deepwork-recap/SKILL.md` |
| `/deepwork-drift-sweep` | Exhaustive drift sweep: enumerate ALL workstreams in the active session and diff each artifact against its source-of-truth; write `drift-report.v<N>.md` | `skills/deepwork-drift-sweep/SKILL.md` |

---

## §11 Flags

### Shared flags (design + execute)

| Flag | Description |
|---|---|
| `--source-of-truth <path>` | Authoritative doc/bundle/spec. Repeatable. Rendered in every teammate prompt. |
| `--anchor <file:line>` | Starting-point file:line reference. Repeatable. |
| `--guardrail '<rule>'` | Hard-safety constraint. Repeatable. Rendered in every teammate spawn. |
| `--bar '<criterion>'` | Pre-seed a bar criterion. Orchestrator augments in SCOPE to 6-criteria minimum. |
| `--safe-mode true\|false` | Autonomous hooks (default: true). |
| `--team-name <name>` | Override default team name derivation. |
| `--mode <name>` | Profile selection: `default` (design) or `execute`. |
| `--prompt-file <path>` | Read goal from a file instead of inline text. |

### Execute-only flags (require `--mode execute`)

| Flag | Description |
|---|---|
| `--plan-ref <path>` | Absolute path to the CRITIC-approved plan document. Required. |
| `--authorized-push` | Grant setup-time authorization for `git push`, `npm publish`, `docker push`. |
| `--authorized-force-push` | Grant setup-time authorization for `git push --force`. |
| `--authorized-prod-deploy` | Grant setup-time authorization for `kubectl apply`, `terraform apply`, `helm upgrade`. |
| `--authorized-local-destructive` | Grant setup-time authorization for `rm -rf` non-tmp, `git reset --hard`. |
| `--secret-scan-waive` | Disable G7 secret-scan (not recommended; setup-time only). |
| `--chaos-monkey` | Explicitly spawn CHAOS-MONKEY archetype. Default: auto-enabled for distributed/infra goals. |
| `--no-chaos-monkey` | Explicitly disable CHAOS-MONKEY spawn. |

Source for all flags: `scripts/setup-deepwork.sh:30-173`.

**Note**: `authorized_*` flags are written ONCE at SETUP and cannot be changed post-SETUP. `hooks/execute/bash-gate.sh` checks `setup_flags_snapshot` and denies any flag that was not set at setup time.

---

## §12 Phase pipelines

**DESIGN mode**:
```
SCOPE → EXPLORE → SYNTHESIZE → CRITIQUE → (REFINE → CRITIQUE)* → DELIVER → HALT
```

- SCOPE: populate bar, identify empirical unknowns, compose team, create gate tasks, spawn teammates
- EXPLORE: each archetype writes its artifact in parallel; MECHANISM runs live empirical tests
- SYNTHESIZE: blocks on empirical results + cross-checks; writes `proposals/v1.md`
- CRITIQUE: CRITIC emits per-gate verdicts with evidence; writes `critique.vN.md`
- REFINE: addresses HOLDING gates; bumps to `proposals/v2.md`; back to CRITIQUE
- DELIVER: CRITIC APPROVED → `ExitPlanMode`; user approves or rejects with feedback
- HALT: final status; no implementation

For the authoritative phase spec, see `profiles/default/PROFILE.md`.

**EXECUTE mode**:
```
SETUP → WRITE → VERIFY → CRITIQUE → (REFINE → CRITIQUE)* → LAND → CONTINUOUS-LOOP | HALT
```

- SETUP: freeze `plan_hash`, build `test_manifest[]`, spawn team, register execute hooks, write `setup_flags_snapshot`
- WRITE: executor implements gate; `pending-change.json` required before each write
- VERIFY: auditor + adversary + chaos-monkey run `test_manifest`; results → `test-results.jsonl`
- CRITIQUE: CRITIC emits PA / EG / RA verdict per gate; APPROVED requires all three
- REFINE: routes each HOLDING dimension to the appropriate teammate; may trigger amendment
- LAND: merge, record commit SHA in `change_log[].merged_at`
- CONTINUOUS-LOOP: repeat for next gate
- HALT: all gates LANDed, or user-authorized halt on discovery

For the authoritative phase spec, see `profiles/execute/PROFILE.md`.

---

## §13 Hooks overview

Each hook's full behavior is documented in its header comment block — see the `.sh` file at the cited path.

### Design-mode hooks (registered dynamically at setup)

| Hook | Event | Behavior | File |
|---|---|---|---|
| auto-approve | PermissionRequest | Enables autonomous operation (safe-mode default) | (CC built-in) |
| `incident-detector.sh` | SubagentStop | Appends to `incidents.jsonl` on teammate failures | `hooks/incident-detector.sh` |
| `session-context.sh` | SessionStart(clear\|compact) | Re-injects orchestrator identity after /clear or /compact | `hooks/session-context.sh` |
| `task-completed-gate.sh` | TaskCompleted | Artifact-existence + cross-check count enforcement | `hooks/task-completed-gate.sh` |
| `incident-detector.sh` | PermissionDenied | Appends to `incidents.jsonl` on denied operations | `hooks/incident-detector.sh` |
| `deliver-gate.sh` | PreToolUse:ExitPlanMode | Lints ExitPlanMode content; enforces "Residual unknowns" + delta_from_prior | `hooks/deliver-gate.sh` |
| `halt-gate.sh` | Stop | On phase=="halt", requires structured `halt_reason` ({summary, blockers[]}); null/malformed blocks turn-end | `hooks/halt-gate.sh` |
| `approve-archive.sh` | Stop | On phase=="done", renames `state.json` → `state.archived.json` and invokes teardown | `hooks/approve-archive.sh` |
| `wiki-log-append.sh` | FileChanged(.claude/deepwork/) | Appends log entry to DEEPWORK_WIKI.md when `state.archived.json` appears | `hooks/wiki-log-append.sh` |
| `teammate-idle-gate.sh` | TeammateIdle | Forces teammates with in_progress tasks to complete (≤3 retries); M5 Change C — exempts idle when a fresh `.gate-blocked-<task_id>` sidecar marker (AGE<300s) exists for an owned task (drift class l) | `hooks/teammate-idle-gate.sh` |
| `phase-advance-gate.sh` | PreToolUse(Edit\|Write) | Blocks state.json phase transitions when `empirical_unknowns[*].result` is null / artifact missing (drift class a) or state.json vs log.md metadata disagrees (drift class k); warns on source_of_truth omissions | `hooks/phase-advance-gate.sh` |
| `verdict-version-gate.sh` | PreToolUse(SendMessage) | Layer 1 halt-pending-verdict: blocks CRITIC verdict deliveries that reference a superseded proposal version (drift class h) | `hooks/verdict-version-gate.sh` |
| `version-bump-notify.sh` | FileChanged(v*.md) | Async advisory: writes `drift.log` warning when an older proposal version is edited after a newer `version-sentinel.json` current_version | `hooks/version-bump-notify.sh` |
| `stale-warn.sh` | FileChanged(v*.md) | Async: flips `stale_warn: true` on audit/critique files whose `valid_against.artifact_version` matches the changed proposal (drift class d) | `hooks/stale-warn.sh` |
| `critique-version-gate.sh` | TaskCompleted | Layer 3 halt-pending-verdict (OPT-IN via `critique_version_gate` guardrail): blocks CRITIC task completion when subject references a superseded version | `hooks/critique-version-gate.sh` |

### Execute-mode hooks (registered at execute SETUP)

| Hook | Event | Behavior | File |
|---|---|---|---|
| `plan-citation-gate.sh` | PreToolUse(Write\|Edit) | Blocks write without valid `pending-change.json` citation; blocks on failing covering test (EP3) | `hooks/execute/plan-citation-gate.sh` |
| `bash-gate.sh` | PreToolUse(Bash) | Reversibility-ladder classifier + secret-scan (G7) + CI-bypass prevention (G8) | `hooks/execute/bash-gate.sh` |
| `task-scope-gate.sh` | TaskCreated | Blocks out-of-scope task creation; appends `scope-delta` discovery | `hooks/execute/task-scope-gate.sh` |
| `stop-hook.sh` | Stop | Re-injects session when unfinished `change_log` entries exist | `hooks/execute/stop-hook.sh` |
| `test-capture.sh` | PostToolUse(Bash) | Async capture of test-runner output → `test-results.jsonl`; detects flaky tests | `hooks/execute/test-capture.sh` |
| `retest-dispatch.sh` | PostToolUse(Write\|Edit) | Async dispatch of covering test from `test_manifest` after each write | `hooks/execute/retest-dispatch.sh` |
| `plan-drift-detector.sh` | FileChanged(\<plan_ref\>) | Advisory: sets `plan_drift_detected=true` on sha256 divergence | `hooks/execute/plan-drift-detector.sh` |
| `file-changed-retest.sh` | FileChanged(src/**) | Advisory secondary retest trigger on filesystem change events; 500ms debounce | `hooks/execute/file-changed-retest.sh` |

---

## §14 State & artifacts

### Design-mode state (`profiles/default/state-schema.json`)

All state lives in `.claude/deepwork/<instance-id>/state.json`:

- `phase` — current pipeline phase
- `bar[]` — written-bar criteria
- `guardrails[]` — hard constraints rendered to every spawn
- `hook_warnings[]` — advisory warnings from hooks
- `empirical_unknowns[]` — open empirical questions
- `halt_reason` — structured `{summary, blockers[]}` required at phase=="halt" (enforced by `hooks/halt-gate.sh`)
- `iteration_queue[]` — user-authored or orchestrator-populated delta list; §4 step 3 pops one entry per REFINE cycle instead of advancing to DELIVER when CRITIC approves
- `banners[]` — synthesis-deviation-backpointer banners surfaced at SYNTHESIZE step 6; advisory-only, never read by gates (see `references/state-schema.md`)

Archetype artifacts: `findings.<name>.md`, `coverage.<name>.md`, `mechanism.<name>.md`, `reframe.<name>.md`, `empirical_results.<E_id>.md`, `proposals/vN.md`, `critique.vN.md`.

### Execute-mode state (`profiles/execute/state-schema.json`)

Execute fields live under `state.execute.*`:

- `execute.phase`, `execute.plan_ref`, `execute.plan_hash`, `execute.plan_drift_detected`
- `execute.change_log[]` — per-gate change records with test evidence and CRITIC verdict
- `execute.setup_flags_snapshot` — `authorized_*` flags frozen at SETUP
- `execute.test_manifest[]`, `execute.flaky_tests[]`, `execute.discoveries[]`

Execute artifacts: `test-results.jsonl`, `discoveries.jsonl` (append-only JSONL at instance dir).

See `references/state-schema.md` for field glossary. Authoritative schema: `profiles/default/state-schema.json` and `profiles/execute/state-schema.json`.

---

## §15 Failure modes & recovery

Three main failure classes:

1. **Design-mode stuck session** — phase stalled, no CRITIC verdict. Check `/deepwork-status`, look at `hook_warnings[]`, recheck `bar[]` for unmet criteria.
2. **Execute-mode gate block** — write or bash command blocked by hook. Check stderr from the hook for the denial reason and the state field to fix.
3. **Amendment needed** — CRITIC emits HOLDING. Use `/deepwork-execute-amend <gate-id>`. If amendment spans ≥3 gates, a fresh design-mode run is required.

See `references/failure-modes.md` for the full pedagogical failure-mode table (design-mode patterns) and the §"Execute-mode failure modes" table (12 rows with handler file:line). See `references/execute-mode.md` §Recovery for a debugging checklist.

---

## §16 Trust boundaries & safety

- **Teammate names** are harness-set at `TeamCreate` and sanitized (`[^a-zA-Z0-9_-]` → `_`). Trusted identifiers, not user content.
- **User-supplied guardrails** (via `--guardrail` or `/deepwork-guardrail add`) are user-trusted and rendered verbatim.
- **Incident-sourced guardrails** (via `incidents.jsonl`) are character-restricted and length-capped.
- **Threat model**: same-tenant — all teammates are controlled by the same user.

Safety boundaries:

- **DESIGN mode does NOT implement.** No code changes to target codebase — only proposals and references.
- **EXECUTE mode does NOT commit without CRITIC APPROVED.** The LAND phase requires all three PA/EG/RA dimensions to PASS.
- **Does NOT call TeamDelete from the orchestrator.** Only `/deepwork-teardown` tears down the team.
- **Does NOT overwrite settings.local.json irrecoverably.** Automatic backup + `_deepwork: true` tag filter preserves other plugins' hooks.
- **SessionStart re-inject** — `hooks/session-context.sh` reconstructs orchestrator prompt from disk-backed state.
- **Parallel-safe** — 8-hex instance IDs scope all state; setup is serialized on `.claude/deepwork.local.lock`.

---

## §17 Architecture pointers

For plugin authors reading source:

- `references/archetype-taxonomy.md` — all 6 archetypes (5 design + CHAOS-MONKEY execute-only) with composition patterns
- `references/tool-reference.md` — explicit TeamCreate / Agent / TaskCreate / TaskUpdate / TaskList / TaskGet / SendMessage / AskUserQuestion / ExitPlanMode syntax
- `references/execute-mode.md` — execute-mode deep dive: phase pipeline, hooks, state fields, amendment mechanics
- `profiles/execute/stances/` — execute-mode stance files (executor, adversary, auditor, scope-guard, chaos-monkey); read-only reference for understanding role mandates
- `profiles/default/PROFILE.md` and `profiles/execute/PROFILE.md` — authoritative orchestrator contracts

---

## §18 Decision wiki

`.claude/deepwork/DEEPWORK_WIKI.md` accumulates a cross-session decision log. Modeled after Karpathy's LLM-wiki pattern:

- **Hook-owned `# Log`** — append-only, written by `wiki-log-append.sh` on every `state.archived.json` creation. Records date, goal, session id, outcome.
- **Skill-owned synthesis** — `Overview`, `Session Index`, `Cross-refs` sections regenerated on demand by `/deepwork-wiki`.

Use `/deepwork-recap` for a quick 30-50-word summary of where things stand. DEEPWORK_WIKI.md is a queryable artifact, not auto-loaded. Check it into git.

---

## §19 Contributing / tests

Three test scripts for plugin development:

| Script | Purpose |
|---|---|
| `scripts/test-deliver-gate.sh` | Smoke-tests the DESIGN-mode deliver gate (ExitPlanMode linting) |
| `scripts/test-execute-gates.sh` | Smoke-tests the execute-mode hooks (11 test groups; plan citation, bash gate, task scope, drift detection, etc.) |
| `scripts/test-prompt-parse.sh` | Smoke-tests goal / flag parsing in `setup-deepwork.sh` |

Run all tests:
```
bash scripts/test-deliver-gate.sh && bash scripts/test-execute-gates.sh && bash scripts/test-prompt-parse.sh
```

Commit style: conventional commits — `type(scope): description` (e.g., `feat(hooks): add chaos-monkey gate`). Adding a hook requires updating README §10 hooks table. Adding a skill requires updating README §7 commands table. Changing flag parsing requires updating README §8 flags table. See `plugins/deepwork/CLAUDE.md` for the doc sync rule.
