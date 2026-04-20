# Tool Reference — Team Primitives

**This document is appended verbatim to the orchestrator's initial prompt** because Claude Code is consistently uninformed about the team coordination primitives. Read this before attempting any team operation.

Every primitive listed here is available to the `/deepwork` orchestrator via `allowed-tools` in the skill frontmatter. Teammates spawned via `Agent` get a condensed subset (SendMessage, TaskUpdate, TaskList, TaskGet).

---

## TeamCreate — called ONCE at start of SCOPE phase

Creates a persistent team that outlives iterations. The team is the container for all teammates and their task list.

```
TeamCreate(
  team_name: "<slug>-<random-8hex>",
  description: "<1-sentence goal>",
  agent_type: "orchestrator"
)
```

**Rules:**
- Call TeamCreate exactly once at SCOPE phase. Do NOT call it again mid-run.
- `team_name` comes from `state.json.team_name` — read it, don't invent.
- Do NOT call `TeamDelete` from the orchestrator. The `/deepwork-cancel` skill is the only path that tears down the team.

---

## Agent — spawn each teammate once

Spawns a named teammate into the team. Each teammate has a role (archetype + stance) and its own Claude Code process.

```
Agent(
  team_name: "<same team_name used with TeamCreate>",
  name: "<teammate name, e.g. 'hunter', 'architect', 'critic'>",
  subagent_type: "general-purpose",
  model: "<opus|sonnet|haiku>",
  description: "<5-10 word task description>",
  prompt: "<full rendered role prompt — see templates below>"
)
```

**Rules:**
- `name` must be a lowercase identifier like `"hunter"`, `"critic"`, `"coverage"`. Later SendMessage/TaskUpdate calls reference teammates by this name.
- `subagent_type: "general-purpose"` is the default for deepwork teammates (full tool surface). Specialized agent types (like `"Explore"`) are read-only and not appropriate for most roles.
- `model` per role:
  - CRITIC, REFRAMER (load-bearing reasoning): `"opus"`
  - MECHANISM (design + failure mode): `"opus"`
  - FALSIFIER, COVERAGE (lookups/inventory): `"sonnet"` default, upgrade to `"opus"` for load-bearing null hunts
- Spawn all teammates in parallel by making multiple `Agent` tool calls in a single message (Claude Code runs them concurrently).
- Pass the role prompt verbatim — it renders all `{{PLACEHOLDER}}` substitutions up-front via `profile-lib.sh::substitute_profile_template`.

---

## TaskCreate — one per gate-list entry

Creates a task in the shared team task list. Tasks are the gate-list items that CRITIC will verdict against.

```
TaskCreate(
  subject: "<imperative short title, e.g. 'Verify injected payload dispatches target primitive'>",
  description: "<longer criteria text — what must be proven, what artifact must exist>",
  metadata: {
    bar_id: "<G1, G2, ...>",              // ties back to state.json.bar[]
    phase: "explore",                       // which phase this gate runs in
    artifact: "<expected artifact path, e.g. 'findings.hunter.md'>",
    cross_check_required: false             // set true for nulls / load-bearing claims
  }
)
```

**Rules:**
- Every bar criterion produces one task minimum. Cross-check-required gates produce ≥2 tasks (same bar_id, different owners).
- `metadata.artifact` is a SINGLE file path. The `task-completed-gate` hook blocks TaskUpdate(completed) until the file exists on disk. For multiple artifacts per bar gate, create one TaskCreate per artifact with the same `bar_id`. Comma-joined paths are rejected.
- `metadata.cross_check_required: true` blocks TaskUpdate(completed) until ≥2 tasks with the same `bar_id` are completed by DISTINCT owners.
- **Flag placement matters**: `cross_check_required: true` goes on the PRIMARY task only. Secondary sibling tasks share the `bar_id` with `cross_check_required: false`. Mirrored flags deadlock the gate.
- **Every TaskCreate MUST set `owner`** (via `TaskUpdate(owner:...)` at spawn time, or at claim time). The cross-check gate reads `owner` from the task file, not from the hook actor.

---

## TaskUpdate — claim, update status, or reassign

```
TaskUpdate(
  taskId: "<id returned by TaskCreate>",
  owner: "<teammate name>",            // optional — assigns ownership
  status: "in_progress" | "completed"  // optional
)
```

**Rules:**
- Orchestrator assigns ownership via `owner:` when spawning teammates.
- Teammates self-update to `in_progress` when starting, `completed` when the artifact is written.
- Teammate MUST write the artifact file BEFORE calling TaskUpdate(completed). The task-completed-gate hook enforces this.
- Completed tasks with `cross_check_required: true` are only accepted after ≥2 independent completions — the hook will block prematurely-marked completions.

---

## TaskList / TaskGet — view state

```
TaskList()                 // returns summary of all tasks for this team
TaskGet(taskId: "<id>")    // returns full details + comments
```

Orchestrator uses these to check phase progress. Teammates use them to see the gate-list.

---

## SendMessage — inter-agent communication

```
SendMessage(
  to: "<teammate-name>",                  // one recipient
  summary: "<5-10 word subject>",
  message: "<text>"
)
```

**Rules:**
- Prefer targeted DMs over broadcasts.
- `SendMessage(to: "*")` broadcasts to all teammates — expensive, use only when everyone genuinely needs the same information (e.g., a new hard guardrail applies).
- Teammates signal completion by sending a summary message to `"team-lead"`. This is a convention enforced by role prompts, not a hook.

---

## AskUserQuestion — narrow user surface

Reserved for five specific situations (see references/ask-guidance.md for WHEN/WHEN-NOT detail):
1. Goal redefinition (the request is ambiguous at its root)
2. Mitigation-path choice (two approaches both satisfy the goal with different trade-offs)
3. Mutex decisions (enabling one feature disables another)
4. Scope pivots (the scope may need to expand or contract)
5. Architectural trade-off when CRITIC and a specialist disagree on a taste-level call (e.g., cross-plugin coupling vs. plugin-local fix) where evidence can't break the tie

Do NOT ask about implementation details. Do NOT ask whether the plan is ready — use ExitPlanMode.

```
AskUserQuestion(questions: [{
  question: "<full question>",
  header: "<chip label, max 12 chars>",
  multiSelect: false,
  options: [
    { label: "<choice 1>", description: "<tradeoff>" },
    { label: "<choice 2>", description: "<tradeoff>" }
  ]
}])
```

Up to 4 questions per invocation. 2-4 options per question.

---

## ExitPlanMode — the final delivery surface

The DELIVER phase ends with this tool call. User approves or rejects the proposal.

```
ExitPlanMode()
```

The plan content is the current-version proposal file (`proposals/v<N>.md`) rendered into the plan surface. User approval → state.json phase="done". User rejection → feedback captured in state.json.user_feedback; orchestrator re-enters REFINE.

**Do NOT call ExitPlanMode before CRITIC has emitted APPROVED** against the full written bar.

---

## Common patterns

### Spawn the team (end of SCOPE phase)

Read the team_name + role_definitions from state.json, then emit ALL five Agent calls in a single assistant message so they run in parallel:

```
Agent(team_name: TEAM, name: "critic", subagent_type: "general-purpose", model: "opus",
      description: "gate proposals against written bar",
      prompt: <rendered CRITIC role prompt>)
Agent(team_name: TEAM, name: "hunter", subagent_type: "general-purpose", model: "sonnet",
      description: "hunt for mechanism at file:line",
      prompt: <rendered FALSIFIER role prompt>)
Agent(team_name: TEAM, name: "coverage-map", subagent_type: "general-purpose", model: "sonnet",
      description: "map across environments",
      prompt: <rendered COVERAGE role prompt>)
Agent(team_name: TEAM, name: "runtime", subagent_type: "general-purpose", model: "opus",
      description: "design cleanest runtime artifact",
      prompt: <rendered MECHANISM role prompt>)
Agent(team_name: TEAM, name: "architect", subagent_type: "general-purpose", model: "opus",
      description: "challenge the requirement",
      prompt: <rendered REFRAMER role prompt>)
```

### Check phase progress

```
TaskList()  // see what's open/completed
```

### Re-prompt a stuck teammate

```
SendMessage(to: "hunter", summary: "Need file:line for target primitive",
            message: "Your findings.hunter.md is light on file:line citations. The source bundle at <PATH> is your source of truth. Please add specific line numbers for each claim before marking TaskUpdate(completed).")
```

### Accumulate a guardrail mid-run

If an incident happens, the incident-detector hook appends automatically. For orchestrator-discovered constraints, the orchestrator can directly write to state.json:

```
(read state.json, append to .guardrails[] with source: "orchestrator", atomic tmp+mv)
```

Or the user can run `/deepwork-guardrail add "rule text"` from their REPL; the next teammate spawn picks it up.
