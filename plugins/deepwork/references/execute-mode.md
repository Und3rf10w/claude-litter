# Execute Mode — Deep Dive

**Authoritative orchestrator contract**: `profiles/execute/PROFILE.md`
**State schema authority**: `profiles/execute/state-schema.json`
**Field glossary**: `references/state-schema.md`

This reference expands the user-facing surface of execute mode. It does not restate the orchestrator prompt. When in doubt, `profiles/execute/PROFILE.md` is the source of truth.

---

## Phase Pipeline

```
SETUP → WRITE → VERIFY → CRITIQUE → (REFINE → CRITIQUE)* → LAND → CONTINUOUS-LOOP | HALT
```

Execute mode loops on WRITE→VERIFY→CRITIQUE **per plan gate** until all gates are APPROVED and LANDed. The full pipeline is not restarted between gates — only REFINE cycles back to CRITIQUE.

### SETUP

Freeze `plan_hash`, build `test_manifest[]`, spawn the team, register hooks, write `setup_flags_snapshot`. All `authorized_*` flags are written **once** here and never updated post-SETUP. Transition: phase → "write".

**Entry guard**: if `plan_ref` does not exist, has zero gates, or hash computation fails → `phase = "halt"` + AskUserQuestion. See [Halt](#halt).

### WRITE

Executor implements the current gate. Before any Write/Edit, executor produces `pending-change.json` (see [Pending-change.json Protocol](#pending-changejson-protocol)). The PreToolUse citation gate (`hooks/execute/plan-citation-gate.sh`) reads this file and blocks writes with missing or null citations.

Transition: when executor marks gate's Write tasks complete → phase advances to "verify".

**Plan drift handling**: if `state.execute.plan_drift_detected == true`, HALT current WRITE gate, notify team, trigger amendment before resuming. See `hooks/execute/plan-drift-detector.sh`.

### VERIFY

Auditor runs the full `test_manifest` for the current gate. Chaos-monkey probes resiliency (if spawned). Adversary runs adversarial tests. All results land in `test-results.jsonl`.

Flaky detection: `hooks/execute/test-capture.sh` tracks pass/fail history. ≥2 alternating results → appended to `state.execute.flaky_tests[]` + auto-guardrail.

Transition: when auditor produces `env_attestations[]` entry for the gate → "critique".

### CRITIQUE

CRITIC emits a per-gate verdict table covering three independent dimensions (PA / EG / RA). See [3-Dimension CRITIC Verdict](#3-dimension-critic-verdict).

Transition: APPROVED on all 3 dimensions → "land". HOLDING on any dimension → "refine".

### REFINE

Routes each HOLDING dimension to the appropriate teammate:

| Dimension | Route |
|---|---|
| PA-HOLDING | `scope-guard` or `executor` (plan citation gap) |
| EG-HOLDING | `adversary` or `auditor` (failing tests) |
| RA-HOLDING | `executor` (regression fix) + `adversary` (confirmation) |

If scope expansion is needed, invoke `/deepwork-execute-amend <gate-id>`.

Returns to CRITIQUE. See [Amendment Trigger Conditions](#amendment-trigger-conditions) for when this escalates.

### LAND

Merge worktree changes to working branch. Record commit SHA in `change_log[].merged_at` via `git rev-parse HEAD`. Append DEEPWORK_WIKI.md log entry with `commit_range` and `type: execute`.

Transition: more gates pending → CONTINUOUS-LOOP. All gates complete → HALT.

### CONTINUOUS-LOOP

Returns to WRITE for the next pending gate. Core loop:
```
WRITE → VERIFY → CRITIQUE → (REFINE → CRITIQUE)* → LAND → (CONTINUOUS-LOOP | HALT)
```

### HALT

**Entry conditions**:
1. All plan gates APPROVED and LANDed (normal completion)
2. User invokes halt via AskUserQuestion after a discovery with `proposed_outcome: halt`
3. Catastrophic failure with no recovery path

**Actions**: set `phase = "halt"`, archive state (Stop hook fires on session end), write final `log.md` entry with completion summary and any open discoveries.

Do NOT restart SETUP if `state.execute.plan_hash` is already set. The team persists across clears.

---

## 3-Dimension CRITIC Verdict

APPROVED requires all three dimensions PASS across ALL active gates. See `profiles/execute/PROFILE.md` for the authoritative verdict spec.

| Dimension | What it checks |
|---|---|
| **PA** (plan-adherence) | Does the diff satisfy the plan section? Does `change_log[].plan_section` cite a real plan section? |
| **EG** (empirical-green) | Do all `test_manifest` entries pass? Are any flaky? |
| **RA** (regression-absence) | Did any previously-LANDed gates break? |

Verdict table format written to `critique.v<N>.md`:

```
| Gate    | PA                             | EG   | RA   | Evidence |
|---------|-------------------------------|------|------|----------|
| G-exec-1 | PASS                         | PASS | PASS | plan §4.2 + test-results.jsonl:entry-17 |
| G-exec-2 | CONDITIONAL-on-plan-cite     | PASS | PASS | change_log CL-2 has null plan_section |
```

Categorical bans (G7 secret-scan, G8 CI-bypass) are unweighable — a single FAIL vetoes APPROVED with no override path.

If `plan_drift_detected == true`, CRITIC re-verdicts ALL pending gates, not just the current one.

---

## Reversibility Ladder

Enforced by `hooks/execute/bash-gate.sh` (PreToolUse Bash). No "ask" path exists — "ask" silently degrades to "deny" in non-interactive mode (CC source: `bash-gate.sh:30-33` header comment). See `hooks/execute/bash-gate.sh` for the full implementation.

| Op class | Behavior | Override |
|---|---|---|
| reversible-local (ls, cat, git status, npm test) | allow | N/A |
| reversible-sandbox (/tmp/*, git stash) | allow | N/A |
| irreversible-local (rm -rf non-tmp, git reset --hard) | **deny** | `authorized_local_destructive:true` (setup-time only) |
| irreversible-remote (git push, npm publish) | **deny** | `authorized_push:true` + CRITIC APPROVED + green CI attested |
| force-push (git push --force/-f) | **deny** | `authorized_force_push:true` (setup-time only) |
| --no-verify bypass | **deny** | **NO OVERRIDE** (categorical ban G8) |
| prod deploy (kubectl, terraform apply) | **deny** | `authorized_prod_deploy:true` + tested rollback doc exists |

The `authorized_*` flags are written ONCE at SETUP. Any mutation after SETUP is ignored by the hook.

---

## Execute Hooks — All 8

Hooks registered at SETUP via `hooks/hooks.json` (dynamic entries for FileChanged matchers). Full behavior documented in each hook's header comment block — the `.sh` file is authoritative.

### Design-mode hooks continue to fire

Execute mode runs inside the same CC session, so design-mode hooks remain active. Only execute-specific hooks are listed here.

### Execute-mode hooks

| Hook | Event | File | One-line behavior |
|---|---|---|---|
| `plan-citation-gate.sh` | PreToolUse(Write\|Edit) | `hooks/execute/plan-citation-gate.sh` | Blocks write/edit without a valid `pending-change.json` citation; also blocks if covering test last failed (EP3). |
| `bash-gate.sh` | PreToolUse(Bash) | `hooks/execute/bash-gate.sh` | Reversibility-ladder classifier + secret-scan + CI-bypass prevention; denies unauthorized destructive ops. |
| `task-scope-gate.sh` | TaskCreated | `hooks/execute/task-scope-gate.sh` | Blocks out-of-scope task creation; appends `type: scope-delta` discovery to `discoveries.jsonl`. |
| `stop-hook.sh` | Stop | `hooks/execute/stop-hook.sh` | Re-injects session when unfinished `change_log` entries exist; allows stop on `execute-done.sentinel`. |
| `test-capture.sh` | PostToolUse(Bash) | `hooks/execute/test-capture.sh` | Async capture of test runner output → `test-results.jsonl`; detects flaky tests (last-6 pattern). |
| `retest-dispatch.sh` | PostToolUse(Write\|Edit) | `hooks/execute/retest-dispatch.sh` | Async dispatch of covering test from `test_manifest` after each write; feeds EP3 gate. |
| `plan-drift-detector.sh` | FileChanged(\<plan_ref\>) | `hooks/execute/plan-drift-detector.sh` | Advisory: sets `plan_drift_detected=true` when plan file sha256 diverges from frozen `plan_hash`. |
| `file-changed-retest.sh` | FileChanged(src/**) | `hooks/execute/file-changed-retest.sh` | Advisory secondary retest trigger on filesystem change events in src/; 500ms debounce. |

**Note**: `PostToolUse` hooks (test-capture, retest-dispatch) and `FileChanged` hooks (plan-drift-detector, file-changed-retest) are advisory — they cannot block. Enforcement sits on the next PreToolUse gate. This is the two-hook enforcement pattern described in `hooks/execute/test-capture.sh` header.

---

## Pending-change.json Protocol

Before any Write/Edit to a plan-authorized file, executor writes `pending-change.json` to the instance directory:

```json
{
  "plan_section": "<path-to-plan>#<section-id>",
  "files": ["<absolute-path-to-file>"],
  "change_id": "<CL-N>",
  "rationale": "<quote from plan>"
}
```

`plan-citation-gate.sh` reads this file before each write. A null `plan_section` or a target file not in `files[]` results in a blocked write.

**GAP-10 protection**: the instance directory's log files (`test-results.jsonl`, `change_log.jsonl`, `rollback_log.jsonl`, `discoveries.jsonl`, `pending-change.json` itself) are unconditionally blocked from Write/Edit — they are append-only via hooks. See `hooks/execute/plan-citation-gate.sh:48-53`.

---

## Artifact Schemas

### test-results.jsonl (append-only, per-entry)

Written by `hooks/execute/test-capture.sh` and `hooks/execute/retest-dispatch.sh`.

```
{
  "id": "TR-<N>",
  "test_cmd": "<command>",
  "exit_code": <int>,
  "last_result": "pass|fail|pending|unknown",
  "stdout_summary": "<first 500 chars>",
  "covering_file": "<path>",
  "timestamp": "<ISO 8601>"
}
```

### discoveries.jsonl (append-only, per-entry)

Written by hooks and teammates when unforeseen conditions arise. See `profiles/execute/PROFILE.md` for the routing table.

```
{
  "id": "D<N>",
  "type": "scope-delta|new-failure|env-mismatch|resource-constraint",
  "detected_by": "<teammate-name|hook-name|user>",
  "context": "<file:line or state snapshot or test-results.jsonl:entry-N>",
  "proposed_outcome": "escalate|continue|halt",
  "timestamp": "<ISO 8601>",
  "resolution": null
}
```

**Routing by proposed_outcome**:

| Outcome | Action |
|---|---|
| `escalate` | Trigger `/deepwork-execute-amend <impacted-gate-id>`. Block current gate until amendment completes. |
| `continue` | Run `/deepwork-guardrail add "<guardrail>"`. Log. Continue WRITE/VERIFY loop. |
| `halt` | Set `phase = "halting"`. AskUserQuestion: options are halt-and-review, continue-at-risk, or escalate to amendment. |

### change_log[] (state field, per-entry)

Written by executor to `state.json.execute.change_log[]`.

```
{
  "id": "<CL-N>",
  "plan_section": "<section-id>",
  "files_touched": ["<path>"],
  "test_evidence": null | "<test-results.jsonl:entry-N>",
  "critic_verdict": null | "APPROVED|HOLDING",
  "merged_at": null | "<commit-sha>"
}
```

### rollback_log[] (state field, EXECUTOR-maintained)

Written manually by EXECUTOR — no auto-write hook exists. This is a known limitation (see [Known Limitations](#known-limitations)).

```
{
  "id": "<RB-N>",
  "change_id": "<CL-N>",
  "reason": "<why rollback was needed>",
  "rollback_cmd": "<git revert / manual steps>",
  "executed_at": "<ISO 8601>"
}
```

---

## Amendment Trigger Conditions

An amendment is a single-gate re-verdict cycle. Full re-run threshold applies when amendment scope exceeds these bounds.

**Invoke amendment** (`/deepwork-execute-amend <gate-id>`) when:
- CRITIC emits HOLDING on one gate (PA, EG, or RA dimension)
- Out-of-scope discovery (`proposed_outcome: escalate`) blocks gate progress

**Full re-run threshold** — require fresh `/deepwork --mode default` cycle and AskUserQuestion to authorize when:
- Amendment touches ≥ 3 gates
- Amendment changes a categorical ban
- Amendment changes test acceptance criteria

**Amendment mechanics**: `/deepwork-execute-amend` spawns a MICRO-TEAM (CRITIC + 1 dimension-specific specialist). On PASS, `scope_amendments[]` appends and `plan_hash` recomputes. On FAIL → `proposed_outcome: halt` discovery. See `skills/deepwork-execute-amend/SKILL.md` for the full skill contract.

---

## Discovery Routing Table

See `profiles/execute/PROFILE.md` (Unforeseen-Discovery Surfacing section) for the authoritative routing table. Summary:

| Discovery type | Typical source | Default routing |
|---|---|---|
| `scope-delta` | `task-scope-gate.sh`, scope-guard | `escalate` → amendment |
| `new-failure` | adversary, test-capture | `continue` → guardrail, or `escalate` if blocking |
| `env-mismatch` | auditor, env attestations | `escalate` or `halt` depending on severity |
| `resource-constraint` | auditor, chaos-monkey | `continue` or `halt` |

Halt is the only case where `AskUserQuestion` is legitimate in execute mode. See `references/ask-guidance.md` for the 6th halt-case entry.

---

## Team Composition

5 core teammates + 1 optional. Stance files are the authoritative contracts — this section names them only.

| Role | Archetype | Stance file |
|---|---|---|
| critic | CRITIC | `references/critic-stance.md` (invariant; included verbatim at spawn) |
| executor | MECHANISM | `profiles/execute/stances/executor-stance.md` |
| adversary | FALSIFIER | `profiles/execute/stances/adversary-stance.md` |
| auditor | COVERAGE | `profiles/execute/stances/auditor-stance.md` |
| scope-guard | REFRAMER | `profiles/execute/stances/scope-guard-stance.md` |
| chaos-monkey | CHAOS-MONKEY (optional) | `profiles/execute/stances/chaos-monkey-stance.md` |

**chaos-monkey spawn condition**: goal mentions services, networks, databases, queues, distributed components, or deployment infrastructure. Opt-in via `--chaos-monkey`; opt-out via `--no-chaos-monkey`. See `references/archetype-taxonomy.md` for the full CHAOS-MONKEY archetype entry.

---

## Known Limitations

These are documented as limitations, not proposed fixes. A separate deepwork session is required to address them.

- **`rollback_log[]` write handler** — EXECUTOR-maintained manually; no auto-write hook.
- **`env_attestations[]` write handler** — AUDITOR-written via stance; no auto-write hook.
- **`flaky_tests[]` state field** — `test-capture.sh` detects flakiness but logs only to `test-results.jsonl`; the state field `state.execute.flaky_tests[]` is populated at detection time but has no subsequent reader or enforcement gate.
- **`discoveries.jsonl` watchdog** — no automated watchdog for stale-open entries (resolution: null).

Source: `findings.hunter.md` §C.4.

---

## Recovery — Debugging a Stuck Session

1. Run `/deepwork-execute-status` to see current `phase`, `change_log`, and open discoveries.
2. Check `log.md` at the instance directory for the last successful action.
3. Check `test-results.jsonl` for failing tests that are blocking a write gate.
4. Check `discoveries.jsonl` for unresolved entries with `resolution: null`.
5. If `plan_drift_detected: true`, resolve via `/deepwork-execute-amend` before resuming.
6. If stuck in REFINE loop, check whether amendment threshold has been crossed (≥3 gates touched).
7. For hook-blocked writes: read the hook's stderr output — it includes the specific denial reason and the state field to check.

See `references/failure-modes.md` §"Execute-mode failure modes" for the full failure-mode table with handler file:line citations.
