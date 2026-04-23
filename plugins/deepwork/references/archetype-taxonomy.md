# Archetype Taxonomy — The 5 Roles of a Deepwork Team

Every deepwork team has five archetypes. CRITIC is invariant — always present with the literal name `"critic"`. The other four are instantiated by the orchestrator with problem-appropriate names. The archetype, not the name, is what matters for the mandate.

---

## FALSIFIER

**Incentive**: Find the mechanism / find the answer.
**Counter-incentive**: Prove the mechanism *doesn't* exist (evidence of absence).

A FALSIFIER hunts facts. They read source, cite file:line, produce inventories. They don't design or synthesize — they find. The most valuable FALSIFIER output is often a *null*: "I looked at X, Y, Z and there is no path that does what you want." Nulls are hard to trust, which is why the orchestrator can mark gates `requires_cross_check: true` — spawning ≥2 FALSIFIER instantiations that reach the same null from different starts.

**Example instantiations:**
- `hunter` — CLI/API internals spelunker
- `auditor` — security/vulnerability reviewer
- `data-explorer` — analytics/database investigator
- `spec-reader` — RFC/protocol/standard interpreter
- `source-of-truth-reader` — reads the authoritative doc and extracts the load-bearing claims

**Output contract**: `findings.<name>.md` with file:line citations for every factual claim, or an evidence-of-absence inventory listing every path checked.

**Default model**: `"sonnet"` (lookups). Upgrade to `"opus"` when the null hunt is load-bearing for the proposal (most design-critical cases).

---

## COVERAGE

**Incentive**: Map across environments — get it working everywhere.
**Counter-incentive**: Admit where it won't work. Graceful-degrade honesty.

A COVERAGE agent builds per-environment matrices. "On terminal A, behavior is X. On terminal B, we degrade to Y. On terminal C, we don't support at all." The output is a table that explicitly notes the negative cases.

**Example instantiations:**
- `terminal` — terminal/multiplexer/OS matrix
- `compat` — browser/runtime/Node version matrix
- `targets` — DB engine / storage backend matrix
- `locales` — language/locale/format coverage
- `platform` — OS/architecture/distribution matrix

**Output contract**: `coverage.<name>.md` with a matrix of environment × behavior × (works | degrades | fails). Must include graceful-degrade path for anything that doesn't fully work.

**Default model**: `"sonnet"`. Upgrade when the coverage question is itself the crux.

---

## MECHANISM

**Incentive**: Design the cleanest runtime artifact.
**Counter-incentive**: Surface the failure modes (not just the happy path).

A MECHANISM agent proposes concrete designs — pseudocode, data structures, API surfaces, integration points — AND itemizes what breaks. The best MECHANISM outputs have a failure-mode table with every edge case the design must handle.

MECHANISM is also responsible for **live empirical tests**. When the orchestrator populates `state.json.empirical_unknowns[]` at SCOPE phase, MECHANISM (or an appropriate specialist) produces `empirical_results.<id>.md` via real sandbox testing — not documentation reading.

**Example instantiations:**
- `runtime` — runtime/supervisor/integration layer designer
- `implementer` — code structure / module design
- `api-designer` — REST/GraphQL/RPC surface
- `data-modeler` — schema design with migration path
- `test-harness-designer` — test infrastructure design

**Output contracts:**
- `mechanism.<name>.md` — pseudocode + failure-mode table
- `empirical_results.<E_id>.md` — one per empirical_unknowns[] item, via live testing

**Default model**: `"opus"` (load-bearing reasoning).

---

## REFRAMER (required)

**Incentive**: Challenge whether the thing should be built as stated.
**Counter-incentive**: Deliver the spec as-is.

REFRAMER is required for every deepwork invocation. Their mandate is to argue *"this shouldn't be built as stated"* and propose ≥1 alternative that satisfies the goal with less code. Even rejected reframes are valuable — they surface invalid assumptions about what exists today.

Common reframes:
- "Use existing machinery X" (verify via anchors)
- "The requirement is wrong; the actual goal is Y, achievable by Z"
- "This is a cargo-cult; the current behavior already does what you want"
- "Flip a default instead of adding a mechanism"

**Example instantiations:**
- `architect` — requirements challenger
- `devils-advocate` — pushback on heavy mechanisms
- `scope-cutter` — "what's the smallest thing that satisfies the goal?"
- `status-quo-advocate` — "do we actually need a change?"

**Output contract**: `reframe.<name>.md` with ≥1 alternative, each with file:line evidence for its feasibility claim. If reframing genuinely doesn't help, produce a doc stating WHY — what makes the goal irreducible.

**Default model**: `"opus"` (load-bearing reasoning).

---

## CRITIC (invariant, always named `"critic"`)

**Incentive**: Gate everything.
**Counter-incentive**: Say APPROVED only when evidence clears the written bar.

CRITIC holds the APPROVED key. They verdict each bar criterion with PASS / CONDITIONAL / FAIL and cite evidence. They don't design, don't propose — they verdict.

CRITIC's full stance is in `references/critic-stance.md` — include it verbatim in the CRITIC role prompt.

**Instantiation**: always `"critic"` (lowercase identifier). No other name.

**Output contract**: `critique.md` with per-gate verdict table + citation per verdict + final APPROVED or HOLDING statement.

**Default model**: `"opus"` (always — this is the most load-bearing reasoning in the team).

---

## CHAOS-MONKEY (execute-mode only, optional)

**Incentive**: Break things under realistic fault conditions.
**Counter-incentive**: Report only genuine faults, not theoretical ones.

CHAOS-MONKEY is an **execute-mode-only** archetype. It does not appear in design-mode teams. Its authoritative stance is `profiles/execute/stances/chaos-monkey-stance.md` — include it verbatim in the CHAOS-MONKEY role prompt.

CHAOS-MONKEY probes resiliency of changed components involving infrastructure during the VERIFY phase. It targets services, networks, databases, queues, distributed components, and deployment infrastructure. It injects realistic faults (network partition, process crash, resource exhaustion) and reports whether the system recovers without data corruption.

**Spawn condition**: `state.execute.chaos_monkey_enabled == true`. This flag is set at SETUP by `scripts/setup-deepwork.sh:421-427` using an auto-detect heuristic — if the goal string matches any of: `service`, `network`, `database`, `queue`, `distributed`, `deploy`, `kubectl`, `terraform`, `helm`, `infrastructure`, `microservice`, `cluster` (case-insensitive). The auto-detect logic describes the trigger pattern; the exact regex lives at `scripts/setup-deepwork.sh:423`.

**Opt-in/opt-out**: `--chaos-monkey` forces spawn; `--no-chaos-monkey` forces skip regardless of auto-detect.

**Instantiation**: always `"chaos-monkey"` (lowercase identifier). Only one instantiation.

**Output contract**: findings reported as discoveries in `discoveries.jsonl` with `type: new-failure` or `type: env-mismatch`.

**Default model**: `"sonnet"` (probe execution). Upgrade to `"opus"` if fault analysis requires complex reasoning.

---

## Composition by problem shape

The orchestrator reads the goal and composes archetypes into named roles. Default compositions:

### Code/system design problem

Classic composition — 1 instantiation per non-CRITIC archetype:
- FALSIFIER → `hunter` (reads the codebase)
- COVERAGE → `compat` or `terminal` or domain-appropriate
- MECHANISM → `runtime` or `implementer` or domain-appropriate
- REFRAMER → `architect`
- CRITIC

### Security audit problem

- FALSIFIER → `auditor` (finds vulnerabilities)
- FALSIFIER (×2 for cross-check) → `challenger` (independently verifies auditor's findings)
- COVERAGE → `attack-surface` (maps which paths are exposed)
- MECHANISM → `mitigator` (proposes fixes)
- REFRAMER → `scope-cutter` ("does this need to be fixed? what's the blast radius?")
- CRITIC

Note: this composition puts 2 FALSIFIER instantiations because security audits frequently hinge on nulls ("there is no exploit path") — cross-check is load-bearing.

### Tradeoff / debate problem

- FALSIFIER → `evidence-collector`
- COVERAGE → `options-matrix`
- MECHANISM → two instantiations, one per candidate (e.g., `advocate-a`, `advocate-b`) — each designs their preferred approach
- REFRAMER → `third-option` (proposes what neither side suggested)
- CRITIC

### Migration / upgrade problem

- FALSIFIER → `current-state-reader` (what does prod look like today)
- COVERAGE → `migration-path-matrix` (every environment's migration story)
- MECHANISM → `migrator` (designs the rollout)
- REFRAMER → `phase-cutter` ("break this into 3 smaller migrations")
- CRITIC

### Research / open question

- FALSIFIER → `literature-scout` (what's been tried)
- FALSIFIER (×2) → `experimenter` (runs empirical_unknowns tests live)
- COVERAGE → `survey` (what approaches exist)
- MECHANISM → `hypothesis-tester` (proposes an answer + validation method)
- REFRAMER → `question-sharpener` ("is this the right question?")
- CRITIC

---

## Sizing rules

- **Minimum 4 roles**: CRITIC + at least one instantiation each of FALSIFIER, MECHANISM, REFRAMER. COVERAGE can be folded into FALSIFIER's mandate for small problems.
- **Maximum ~7 roles**: beyond this, coordination overhead dominates. If the problem needs more, split into sub-teams or sequence with multiple `/deepwork` invocations.
- **Cross-check gates** trigger additional FALSIFIER instantiations (same archetype, different names, different starting anchors).
- **User override**: user can inspect the team via `/deepwork-status` and send feedback via `AskUserQuestion` if they want the team reshaped.

---

## Naming conventions

- Instance names are lowercase identifiers: `hunter`, `critic`, `runtime`, `architect`, `terminal`, `auditor`.
- Avoid generic names like `worker`, `agent`, `helper` — they don't signal archetype.
- Avoid overly long names — `security-vulnerability-auditor` is worse than `auditor`.
- When spawning multiple FALSIFIERs for cross-check: pick distinct names (`hunter-a`, `hunter-b` or `auditor`, `challenger`) not numbered suffixes.
