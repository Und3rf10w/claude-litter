# When NOT to Use /deepwork

`/deepwork` spawns 4-5 long-running agents (default opus/sonnet mix) and runs them through a 5-phase convergence pipeline. It's expensive — a typical session is 2-5 hours and consumes significant tokens across the team.

That cost is justified for certain problem shapes and not others.

## Don't use /deepwork when

### The mechanism is already known

> Example: "refactor the auth middleware to use async/await" — you know what to do; the work is execution. Just do it.

Multi-agent debate on an execution task is waste. A single implementing agent (with a linter + test suite) will ship faster and cheaper.

### The answer is in documentation

> Example: "how do I configure X in library Y?" — read the docs. If the docs are bad, grep the source. Spawning a 5-agent team to answer a documented question wastes the team's time and signals you didn't try the cheap path first.

### The problem has no falsifiable structure

> Example: "make the app faster" without a specific bottleneck, measurement, or target. The team can't converge because there's no gate-list to close. Before reaching for deepwork, reduce the problem to something like "latency on the /checkout endpoint is p99=850ms; target p99=200ms" — now FALSIFIER can profile, MECHANISM can propose, CRITIC can verdict against the target.

### You don't have file:line anchors

> "Fix the bug in the code somewhere" doesn't give the team starting points. Per principle 4, if you can't produce anchors, the task isn't team-ready. Do a solo pre-audit first to collect anchors, then invoke `/deepwork` with them.

### The change is small and reversible

> A 10-line bug fix doesn't need 4.5h of adversarial review. Write it, test it, commit it. Save deepwork for the 100-line designs where the cost of getting it wrong is high.

### You're under deadline pressure

> Deepwork optimizes for robustness, not speed. If "good enough right now" beats "ideal next week," don't deepwork — just ship.

### The problem is simple but seems hard

> Sometimes problems feel hard because you're tired or distracted. Before invoking deepwork, take a break and try again solo. If it still feels hard after you're fresh, then deepwork.

## DO use /deepwork when

### The mechanism is genuinely unknown

> Example: "is there a way to programmatically drive <feature-X> from outside the tool's supported API?" — you don't know if the answer is yes or no; you're betting architecture on the answer. FALSIFIER hunts for the mechanism; independent cross-checks confirm the null if no mechanism exists.

### Stakes are high

- Production-critical path
- Cross-plugin / cross-system coupling
- Irreversible design choice (once shipped, hard to change)
- User-facing behavior change
- Schema migration or data model change

### A solo agent has tried and got stuck

> Single-agent fragility: a solo agent goes down one path, hits a wall, backtracks, and produces a fragile answer without the friction-correction that adversarial roles provide. If a solo attempt produced something that feels shaky, deepwork can harden it.

### You need independent cross-verification

> Some claims are hard to trust from a single source. Nulls especially ("there is no path that does X"). Deepwork's ≥2-independent-agent cross-check pattern produces reliable nulls in a way single-agent investigation can't.

### The team composition itself is the question

> Example: "is there a better architecture for this problem? We've been doing X and it's fine but feels over-engineered." REFRAMER is designed for this — its whole mandate is "challenge whether this should be built as stated." A solo agent defaults to solving; REFRAMER defaults to questioning.

## Hybrid paths

- **Pre-audit + deepwork**: do a solo exploration first to collect file:line anchors, then invoke `/deepwork` with `--anchor` flags to seed the team. This is the most effective pattern.
- **Deepwork + execution**: deepwork produces a plan via ExitPlanMode. You then run an implementation loop (or solo agent) on the plan to execute. Two tools, two purposes.
- **Deepwork for spec, solo for impl**: design-phase uses deepwork; code-phase doesn't. The team's output is a spec, not code.

## When NOT to reach for execute mode

Execute mode (`/deepwork --mode execute`) runs an approved plan through a gate-clearing implementation loop. It requires a fully-formed, CRITIC-approved plan with explicit gates. Use design mode when these conditions aren't met.

### The plan has no gate list

Execute mode requires a plan with discrete, verifiable gates. If your plan doc is a narrative without explicit `G-exec-<N>` gate structure, the SETUP phase will fail with zero gates detected. Go back to design mode to produce a properly-gated plan.

### The plan has not been approved by CRITIC

Execute mode inherits the design-mode bar criteria as categorical expectations. Running execute against a plan that didn't pass CRITIC in design mode is running against an unvetted specification — CRITIC in execute mode will likely HALT immediately.

### `plan_hash` can't be computed or the plan file doesn't exist

If you can't provide a valid `--plan-ref` path that resolves to an existing, readable file, SETUP halts. Ensure the plan file is at a stable absolute path before invoking execute mode.

### The amendment would touch ≥ 3 gates

Once executing, if a CRITIC HOLDING verdict requires amending 3 or more gates, execute mode's amendment flow (`/deepwork-execute-amend`) is not the right tool. The full-re-run threshold requires a fresh `/deepwork --mode default` design session. See `references/execute-mode.md` §Amendment Trigger Conditions.

### You're not sure what the plan commits you to

Execute mode's hooks actively gate writes, bash commands, and task creation. If you haven't read the plan and understand what each gate produces, you risk triggering the stop-hook re-injection loop mid-session with nowhere to go. Read the plan first.

### The work is exploratory, not implementation

Execute mode is for implementing an approved design. If you're still exploring the problem space, gathering evidence, or unsure which approach to take, use design mode. Execute mode will fight you — discovery entries will pile up, scope-guard will block tasks, and amendment cycles will compound.

---

## Quick decision flowchart

```
Is the mechanism known?                  yes → just do it
  no ↓
Is the answer in docs?                    yes → read docs
  no ↓
Can you state the gate criteria?          no  → reduce problem first
  yes ↓
Do you have file:line anchors?            no  → pre-audit first
  yes ↓
Is the change small + reversible?         yes → just do it
  no ↓
Are you under hard deadline pressure?     yes → just do it
  no ↓
Have you tried solo and hit a wall?       yes → /deepwork
Are stakes high (prod, cross-system)?     yes → /deepwork
Do you need reliable nulls?               yes → /deepwork
                                          else  → probably solo
```
