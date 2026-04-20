# Written Bar Template

The written bar is the gate criteria CRITIC will verdict against. It lives in `state.json.bar[]` and is populated by the orchestrator in SCOPE phase, optionally seeded by user via `--bar` flags at invocation.

**Minimum**: 6 criteria. **Minimum 1 categorical_ban**. More is fine; fewer signals the team isn't ready.

---

## Structure

Each criterion is a JSON object:

```json
{
  "id": "G1",
  "criterion": "<concise statement of what must be true>",
  "evidence_required": "<how the claim must be substantiated>",
  "verdict": null,
  "categorical_ban": false
}
```

- `id` — stable identifier (G1, G2, ... — don't renumber across versions).
- `criterion` — one sentence, declarative. "The mechanism dispatches the target primitive from the intended input channel" not "it should dispatch."
- `evidence_required` — what CRITIC looks for. "file:line anchor in cli source" or "coverage matrix entry per environment" or "empirical_results.E<N>.md exists and reports success."
- `verdict` — null until CRITIC emits one. PASS / `CONDITIONAL-on-<remediation>` / `FAIL-because-<reason>` / null.
- `categorical_ban` — true means "any violation is auto-FAIL regardless of other merits." Used for hard limits.

## The 6-criteria archetype

A well-formed bar has one criterion from each category:

### 1. Functional (what the thing does)

```json
{
  "id": "G1",
  "criterion": "The mechanism achieves the goal as stated (or as clarified via AskUserQuestion)",
  "evidence_required": "proposals/v<N>.md describes a path that, given inputs X, produces outputs Y, with file:line references to where each step occurs",
  "categorical_ban": false
}
```

### 2. UX / interaction mode preservation

```json
{
  "id": "G2",
  "criterion": "Preserves the interaction mode the user operates in (e.g., interactive REPL, headless pipeline, IDE extension)",
  "evidence_required": "proposal does not require a user-facing wrapper or mode-switch; specify how interaction continues",
  "categorical_ban": false
}
```

### 3. Scope boundary (what this team/plugin does NOT own)

```json
{
  "id": "G3",
  "criterion": "Stays within scope; does not modify systems outside the designated plugin(s)/module(s)",
  "evidence_required": "explicit list of files this proposal touches; every file is inside the declared scope",
  "categorical_ban": false
}
```

### 4. Coverage (works across expected environments)

```json
{
  "id": "G4",
  "criterion": "Works across ≥80% of target environments (by user population, weighted if possible)",
  "evidence_required": "coverage.<name>.md matrix with per-environment behavior column summing to ≥80% weighted-works",
  "categorical_ban": false
}
```

### 5. Graceful degrade (what happens for the other 20%)

```json
{
  "id": "G5",
  "criterion": "Environments outside the supported set degrade gracefully with a clear fallback or informative disable",
  "evidence_required": "coverage matrix includes a 'degrade' column describing behavior per unsupported env; no silent failures",
  "categorical_ban": false
}
```

### 6. Maintainability (with categorical bans)

```json
{
  "id": "G6",
  "criterion": "No fragile-reliance mechanisms: no pinning to minified-JS line numbers without feature-detect; no node_modules monkey-patching; no LD_PRELOAD; no V8 inspector outside sandboxed subshells; no signals to host process",
  "evidence_required": "source review of proposed changes confirms none of the above",
  "categorical_ban": true
}
```

---

## Categorical bans — why they matter

A categorical ban is a "this is off the table, regardless of how otherwise attractive it is" rule. Listing them explicitly in the bar serves two purposes:

1. **Kills clever solutions before review cycles.** A FALSIFIER or MECHANISM agent proposing something like "inject our code via node --require" sees the ban in their spawn prompt and doesn't waste time developing it.
2. **Gives CRITIC an unweighable rejection reason.** Categorical bans don't balance against other merits. This prevents a lot of "yes but it almost works" drift.

### Common categorical ban categories

- **Source-coupling**: "no minified-JS line number pinning without feature-detect"
- **Process-invasion**: "no monkey-patching of node_modules, LD_PRELOAD, DYLD_INSERT_LIBRARIES"
- **Debug-vector misuse**: "V8 inspector acceptable only in sandboxed isolated subshells; never on the hosting process"
- **Signal safety**: "no signals to the hosting Claude Code process" (carrying incident memory from prior sessions)
- **Scope invasion**: "no modifications to <specific subsystem>" (e.g., "no modifications to the CLI binary")
- **Interface brittleness**: "no dependency on undocumented Claude Code internal symbols"

Include the ban AND its reason. "No signals to the host process — a prior session's orchestrator died to `kill -USR1` when the default handler activated the debugger mid-run" is much more resistant to talking-around than a bare "no signals."

---

## User-augmented bars

Users can seed the bar via `--bar` flags at invocation:

```
/deepwork "Design X" --bar "no new dependencies" --bar "must work on Node 18+ (categorical ban)"
```

The orchestrator reads these into state.json.bar[] at SCOPE phase and then augments with the 6-category archetype (avoiding duplicates). User can also tune mid-run:

```
/deepwork-bar add "performance regression ≤5%"
/deepwork-bar remove G3
/deepwork-bar list
```

Bar changes trigger CRITIC re-evaluation (the new gate needs a verdict before shipping).

---

## Anti-patterns

- **Vague criteria**: "must be maintainable" is not a criterion; it's a platitude. Put specific bans in G6 instead.
- **Circular evidence**: "criterion: the design is correct; evidence: the design document says it's correct."
- **Forgetting the categorical ban**: at least one bar criterion should be a categorical_ban. It's the team's immune system against clever-but-wrong solutions.
- **Too many criteria**: more than ~10 gates makes CRITIC's verdict cycle expensive. If you have 20 concerns, group them into 6-8 composite criteria with sub-conditions in evidence_required.
