---
description: "Start a deepwork research/design convergence session with a 5-archetype oppositional team"
argument-hint: "<goal> [--source-of-truth PATH]... [--anchor FILE:LINE]... [--guardrail 'RULE']... [--bar 'CRITERION']... [--safe-mode true|false] [--team-name NAME]"
allowed-tools: ["Bash(${CLAUDE_PLUGIN_ROOT}/scripts/setup-deepwork.sh:*)", "Bash(mkdir:*)", "Bash(cat:*)", "Bash(jq:*)", "Bash(mv:*)", "Bash(ls:*)", "Edit(.claude/deepwork/**)", "Write(.claude/deepwork/**)", "Read(.claude/deepwork/**)", "Read", "Grep", "Glob", "TeamCreate", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "SendMessage", "Agent", "ExitPlanMode", "AskUserQuestion"]
---

# Deepwork — Research/Design Convergence

Execute the setup script to initialize the deepwork session:

```!
mkdir -p .claude
# Write arguments to a PID-unique file using a quoted heredoc to prevent shell
# expansion of $, backticks, braces, parens in user prompts. The setup script's
# --prompt-file flag reads the goal from this file and parses flags from it.
_prompt_file=".claude/deepwork.local.prompt.$$.md"
cat <<'__DEEPWORK_PROMPT_EOF__' > "$_prompt_file"
$ARGUMENTS
__DEEPWORK_PROMPT_EOF__
"${CLAUDE_PLUGIN_ROOT}/scripts/setup-deepwork.sh" --prompt-file "$_prompt_file"
```

You are now the DEEPWORK ORCHESTRATOR. Follow the instructions output by the setup script exactly.

## What this command does

`/deepwork` spawns a 5-archetype oppositional team (FALSIFIER / COVERAGE / MECHANISM / REFRAMER / CRITIC) that converges on a research or design question. The team runs a phase pipeline:

**SCOPE → EXPLORE → SYNTHESIZE → CRITIQUE → (REFINE → CRITIQUE)* → DELIVER → HALT**

Delivery happens via `ExitPlanMode`. The team NEVER crosses into implementation — the deliverable is an approved plan document. You proceed from there (possibly via `/swarm-loop` on the plan, or directly).

## When to use it

Use `/deepwork` when:
- The mechanism or answer is genuinely unknown and you're betting architecture on it
- Stakes are high (production, cross-plugin coupling, irreversible design)
- A solo agent has tried and gotten stuck or produced a fragile answer
- You need the confidence of independent cross-verification (especially for nulls)

Do NOT use `/deepwork` for execution tasks, documented answers, or small reversible changes. See `${CLAUDE_PLUGIN_ROOT}/references/when-not-to-use.md` for the full decision flowchart.

## Flags

- `--source-of-truth PATH` (repeatable): authoritative doc/bundle/spec. Every teammate prompt renders these.
- `--anchor FILE:LINE` (repeatable): starting point for investigation. Seeds `state.json.anchors[]`.
- `--guardrail '<rule>'` (repeatable): hard-safety constraint. Every teammate spawn renders these.
- `--bar '<criterion>'` (repeatable): pre-seeds a bar criterion. Orchestrator augments in SCOPE.
- `--safe-mode true|false` (default: true): enables PermissionRequest auto-approve for team coordination tools (Edit/Write/Read/Glob/Grep/Agent/TaskCreate/TaskUpdate/TaskList/TaskGet/SendMessage/TeamCreate).
- `--team-name NAME`: override default team name derivation.

## Companion commands

- `/deepwork-status` — dashboard: phase, team roster, bar verdicts, proposal versions
- `/deepwork-cancel` — tear down team (only path that calls TeamDelete)
- `/deepwork-guardrail add|remove|list "<rule>"` — manual guardrail management
- `/deepwork-bar add|remove|list "<criterion>"` — tune the written bar mid-run

## Key behaviors

- **CRITIC is invariant.** Always spawned as `"critic"`. Holds the APPROVED key. Refuses to sign off without evidence-backed per-gate verdicts.
- **REFRAMER is required.** Always spawned. Argues "this shouldn't be built as stated." Rejected reframes still surface invalid assumptions.
- **File:line anchors.** Every factual claim cites a specific source. Don't accept vague assertions.
- **Named versioning.** Proposals live at `proposals/v1.md`, `v2.md`, etc. Every content change bumps the version and populates `delta_from_prior`. CRITIC re-evaluates fresh.
- **Cross-checks for nulls.** Load-bearing "it doesn't exist" claims require ≥2 independent FALSIFIER confirmations from different starting points.
- **Live empiricism.** Load-bearing unknowns are tested on real infrastructure before SYNTHESIZE, not after.
- **Guardrail accumulation.** Incidents (failed spawns, denied permissions, exhausted retries) auto-append rules to `state.json.guardrails[]`. User can `/deepwork-guardrail add` manually.
- **User surface is narrow.** `AskUserQuestion` reserved for: goal redefinition, mitigation-path choice, mutex decisions, scope pivots, taste-level architectural calls when CRITIC and a specialist disagree. See `${CLAUDE_PLUGIN_ROOT}/references/ask-guidance.md`.
- **Default-off for residual risk.** Unverified mechanisms ship behind opt-in flags in the delivered plan.

## CRITICAL

Do NOT call `TeamDelete` from the orchestrator. Only `/deepwork-cancel` tears down the team. Approved-and-done plans leave the team intact for user inspection.

Do NOT cross into implementation. Your deliverable is the approved plan. Halt at DELIVER.

If the setup script prints a courtesy warning that the goal looks like an execution task, use `AskUserQuestion` to confirm before proceeding. Reference: `${CLAUDE_PLUGIN_ROOT}/references/when-not-to-use.md`.
