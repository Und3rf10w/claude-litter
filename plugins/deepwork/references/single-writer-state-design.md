---
type: reference
name: single-writer-state-design
description: Design spike for making state-transition.sh the sole writer of state.json (W6 prep)
status: pending-implementation
generated: 2026-04-25
---

# Single-Writer State Transitions — Design Spike (W6 prep)

## §1 Context

W5 landed `_write_state_atomic` in `scripts/instance-lib.sh:95-120` as a shared flock+tmp+mv helper. Three hook call sites now use it (`deliver-gate.sh:74`, `execute/plan-drift-detector.sh:60`, `instance-lib.sh:150` backfill). Two more hooks still use the raw `jq+tmp+mv` idiom directly (`pre-compact.sh:37-40`, `execute/test-capture.sh:149-157`). Setup-deepwork.sh is exempt (initialisation-only, single-process context).

W6 extends this to a **canonical writer**: a new `scripts/state-transition.sh` that is the **only** process permitted to mutate `state.json`. After W6:

- Hooks call `state-transition.sh <subcommand>` instead of `_write_state_atomic` or raw `jq+tmp+mv`.
- Orchestrators and teammates call `state-transition.sh <subcommand>` via Bash instead of inline `jq+tmp+mv`.
- `frontmatter-gate.sh` is extended to block Write|Edit to `state.json` outright (pointing to `state-transition.sh`).
- `_write_state_atomic` remains in `instance-lib.sh` as a private implementation detail consumed only by `state-transition.sh` itself.

**Analogue**: this is the same pattern as `post-tool-batch-consolidation.md` — a planning artifact that de-risks the implementation before a single line of W6 code is written.

---

## §2 CLI Surface

`state-transition.sh` is invoked as a child process by hooks, setup, and the orchestrator. It reads `STATE_FILE` from the environment (set by `discover_instance` / `setup-deepwork.sh`), or accepts `--state-file <path>` as an override for test harnesses.

### 2.1 Proposed subcommands

Survey of existing mutation shapes across all call sites (`deliver-gate.sh`, `plan-drift-detector.sh`, `pre-compact.sh`, `execute/test-capture.sh`, `instance-lib.sh` backfill, `PROFILE.md` halt_reason recipe, execute `PROFILE.md` halt_reason recipe):

| Subcommand | Mutation shape | Primary callers |
|---|---|---|
| `phase_advance --to <phase>` | `.phase = $phase` | Orchestrator (design), `PROFILE.md:70` recipe |
| `exec_phase_advance --to <phase>` | `.execute.phase = $phase` | Orchestrator (execute), `execute/PROFILE.md:85` recipe |
| `set_field <jq-path> <json-value>` | Scalar field setter | `plan-drift-detector.sh` (`.execute.plan_drift_detected`, `.execute.plan_hash_at_drift`) |
| `append_array <jq-path> <json-object>` | Array append | `deliver-gate.sh` (`.hook_warnings[]`), `pre-compact.sh` (`.hook_warnings[]`), orchestrator (`.change_log[]`, `.banners[]`, `.guardrails[]`, `.empirical_unknowns[]`, `.source_of_truth[]`) |
| `merge <json-fragment>` | Multi-field update | `plan-drift-detector.sh` composite write, orchestrator multi-field SCOPE writes |
| `halt_reason --summary <text> [--blocker <text>]...` | `.halt_reason = {summary, blockers:[...]}` | Orchestrator at HALT (both profiles), halt-gate recovery recipe |
| `backfill_session --session-id <sid>` | `.session_id = $sid` | `instance-lib.sh:150` (placeholder backfill) |
| `flaky_test_append --cmd <cmd>` | `.execute.flaky_tests += [$cmd]` if absent | `execute/test-capture.sh:149-157` |
| `stamp_last_updated` | `.last_updated = $now` | `pre-compact.sh:37` |

**`phase_advance` is special**: it runs the same gate-check logic currently in `phase-advance-gate.sh` internally before writing. If the transition fails gate checks, the subcommand exits non-zero and the caller receives a structured error on stderr. This makes the gate logic single-source, removing the duplication between the hook and any inline caller.

### 2.2 Exit conventions

```
0   — success; state.json updated atomically
1   — precondition failure (file not found, not valid JSON)
2   — gate violation (phase_advance blocked; prints reason to stderr)
3   — invalid subcommand or missing required args
4   — write failure (jq error or mv failed)
```

### 2.3 Shared preamble

Every invocation:
1. Sources `instance-lib.sh` for `_write_state_atomic` and `_dw_ns_now`.
2. Resolves `STATE_FILE` from environment or `--state-file` flag.
3. Validates the file is present and parseable JSON (`|| exit 1`).
4. Applies flock+tmp+mv via `_write_state_atomic`.

---

## §3 Integrity Hash

### 3.1 Protected field set

Fields that constitute the integrity-protected projection:

| Field | Rationale |
|---|---|
| `.phase` | Core orchestration state; tampering enables premature phase advance |
| `.team_name` | Instance identity; cross-instance poisoning vector |
| `.instance_id` | Instance identity; same |
| `.frontmatter_schema_version` | Schema version mismatch bypasses frontmatter-gate enforcement |
| `.bar[].id`, `.bar[].verdict` | Bar verdict integrity; verdict tampering masks gate failures |
| `.execute.plan_drift_detected` | Drift flag; clearing it enables unauthorized plan deviation |
| `.execute.plan_hash` | Plan integrity anchor |

**NOT protected** (high-frequency appends or advisory fields):
- `.last_updated` — changes on every stamp
- `.hook_warnings[]` — advisory, append-only
- `.banners[]` — advisory annotation
- `.guardrails[]` — grows monotonically; incident-appended
- `.change_log[]` — execute-mode append log

### 3.2 Hash algorithm

```bash
# Canonical projection (jq, sorted keys, compact)
PROJECTION=$(jq -c '{
  phase,
  team_name,
  instance_id,
  frontmatter_schema_version,
  bar: [.bar[]? | {id, verdict}] | sort_by(.id),
  execute_plan_drift_detected: .execute.plan_drift_detected,
  execute_plan_hash: .execute.plan_hash
}' "$STATE_FILE" 2>/dev/null)

# sha256 of the UTF-8 bytes of the canonical JSON string
HASH=$(printf '%s' "$PROJECTION" | shasum -a 256 | cut -d' ' -f1)
```

`shasum -a 256` on macOS, `sha256sum` on Linux — `state-transition.sh` detects at startup via `command -v`.

### 3.3 Hash storage and update

The hash is stored at `.state_integrity_hash` (top-level string field). `state-transition.sh` recomputes and writes it on every successful mutation, atomically alongside the mutation in the same `_write_state_atomic` call:

```bash
_write_state_atomic "$STATE_FILE" \
  --arg hash "$HASH" \
  "$USER_FILTER | .state_integrity_hash = \$hash"
```

### 3.4 Verification gate

`frontmatter-gate.sh` (PreToolUse) currently reads `.frontmatter_schema_version`. The W6 extension adds an integrity check:

```bash
ON_DISK_HASH=$(jq -r '.state_integrity_hash // ""' "$STATE_FILE" 2>/dev/null || echo "")
RECOMPUTED=$(... same projection + hash as above ...)
if [[ -n "$ON_DISK_HASH" && "$ON_DISK_HASH" != "$RECOMPUTED" ]]; then
  printf 'INTEGRITY_HASH_MISMATCH: state.json was modified outside state-transition.sh\n' >&2
  exit 2
fi
```

Absent hash (`.state_integrity_hash` null or missing) is treated as **pass** — pre-W6 instances have no hash and must not be blocked.

### 3.5 Hash is convention, not cryptographic

The PRIMARY defense against direct state.json mutation is `frontmatter-gate.sh` blocking Write|Edit to `*/state.json`. The hash is a **tripwire** for out-of-band edits (`cp`, external tooling, or a shell bypass that doesn't know to recompute the hash). Adversaries who know the hash scheme can bypass it; that is acceptable because the gate is the primary line.

Decision (mirrors post-tool-batch-consolidation.md §3 rationale): convention hash + gate blocking is sufficient for the threat model (prompt-level agents, not adversarial external attackers).

---

## §4 Direct-Edit Blocking

### 4.1 Current state

Today orchestrators and teammates routinely Write/Edit `state.json` or run inline `jq+tmp+mv` via Bash. No hook blocks these paths for `state.json` specifically (`frontmatter-gate.sh` checks frontmatter fields *inside* the file, not the path itself).

### 4.2 W6 frontmatter-gate extension

Add a path-pattern check at the top of `frontmatter-gate.sh` before any existing logic:

```bash
# Block direct Write|Edit to state.json — all mutations must go through state-transition.sh
if [[ "$FILE_PATH" =~ /state\.json$ ]]; then
  # Exception: allow if invocation is via state-transition.sh
  # Detection: check $PPID chain or a sentinel env var set by state-transition.sh
  if [[ "${_DW_STATE_TRANSITION_WRITER:-}" != "1" ]]; then
    printf 'DIRECT_STATE_WRITE_BLOCKED: Write|Edit to state.json is not permitted.\n' >&2
    printf 'Use state-transition.sh subcommands instead.\n' >&2
    exit 2
  fi
fi
```

`state-transition.sh` sets `_DW_STATE_TRANSITION_WRITER=1` in its own environment before calling the jq+tmp+mv write. Since hooks fire in a subprocess spawned by CC (not by state-transition.sh), this env var is absent in all hook-triggered Write|Edit calls — the block fires correctly. When state-transition.sh itself writes state.json via the shell (not via Write|Edit tool), no hook fires at all (hooks are CC tool-call hooks, not filesystem watchers) — the env var sentinel is therefore for future-proofing if the pattern ever changes.

**Primary enforcement path**: CC's Write|Edit tool fires `frontmatter-gate.sh` pre-hook. Bash-path (`jq+tmp+mv`) is NOT gated by frontmatter-gate — it bypasses the hook entirely. This is intentional: `state-transition.sh` uses the Bash path (shell subprocess), and is the only permitted writer. The Write|Edit gate closes the agent-tool-call vector; the `state-transition.sh` convention closes the shell vector for hooks and setup.

### 4.3 Test fixture exemption

Test harnesses write `state.json` directly (7 fixture files identified — see §5). Two options:

**(A) Migrate fixtures to call `state-transition.sh --init`**: add an `init` subcommand that accepts a full JSON blob and writes it (bypasses gate logic, intended for test setup only, flagged in the binary via a `--test-init` guard). This is the cleanest path — fixtures become self-documenting about the state schema they set up.

**(B) Exempt fixture paths**: if `STATE_FILE` lives under `/tmp/` (the `tmp_claude_home` test pattern), skip the Write|Edit block. Risk: a stale real instance under `/tmp` could be accidentally exempted.

**Recommendation**: Option A. The test harness already calls `_write_state_atomic` in `test-write-state-atomic.sh` — it is familiar with the helper interface. `state-transition.sh init --json-file <path>` (or stdin) gives fixtures a first-class migration path without changing the gate logic.

---

## §5 Migration Cost

### 5.1 Hook call sites (code rewrites)

All sites currently calling `_write_state_atomic` directly or using raw `jq+tmp+mv` on `$STATE_FILE`:

| File | Line(s) | Current pattern | W6 replacement |
|---|---|---|---|
| `hooks/deliver-gate.sh` | 74–78 | `_write_state_atomic ... '.hook_warnings += [...]'` | `state-transition.sh append_array .hook_warnings '{...}'` |
| `hooks/execute/plan-drift-detector.sh` | 60–65 | `_write_state_atomic ... '.execute.plan_drift_detected = true \| ...'` | `state-transition.sh merge '{"execute":{"plan_drift_detected":true,...}}'` |
| `hooks/pre-compact.sh` | 37–40 | Raw `jq ... > "$_TMP" && mv "$_TMP" "$STATE_FILE"` | `state-transition.sh stamp_last_updated && state-transition.sh append_array .hook_warnings '...'` |
| `hooks/execute/test-capture.sh` | 149–157 | Raw `jq ... > "$_TMP" && mv "$_TMP" "$STATE_FILE"` | `state-transition.sh flaky_test_append --cmd "$FLAKY_CMD"` |
| `scripts/instance-lib.sh` | 150 | `_write_state_atomic ... '.session_id = $sid'` | `state-transition.sh backfill_session --session-id "$hook_session"` (or keep internal — see §8 Q3) |

**Total hook code rewrites: 4 hooks** (5 call sites; `instance-lib.sh` is internal and may stay as-is).

W5 already migrated 3 call sites to `_write_state_atomic`. Those 3 sites become trivial mechanical rewrites in W6 (same helper, different wrapper).

### 5.2 PROFILE.md / SKILL.md documented recipes

Prose recipes that embed `jq+tmp+mv` instructions for orchestrators and teammates:

| File | Line(s) | Recipe type | W6 change |
|---|---|---|---|
| `profiles/default/PROFILE.md` | 233 | `halt_reason` write recipe (raw jq+tmp+mv) | Replace with `state-transition.sh halt_reason --summary "..." [--blocker "..."]` |
| `profiles/execute/PROFILE.md` | 237 | Same halt_reason recipe | Same replacement |
| `profiles/default/PROFILE.md` | 50, 82, 84, 135 | Inline "atomic via jq+tmp+mv" instructions | Replace with "call state-transition.sh" instructions |
| `profiles/execute/PROFILE.md` | 47 | Same class of inline instruction | Same |

**Total PROFILE.md doc rewrites: 2 files, ~6 recipe sites.**

No SKILL.md files contain executable `jq+tmp+mv` recipes (grep confirms 0 hits in `skills/`).

### 5.3 Test fixtures writing state.json directly

Fixture files with at least one direct `cat > state.json` or heredoc write:

| File | Write count | Notes |
|---|---|---|
| `scripts/regressions/T9-frontmatter-gate.sh` | 3 | Schema version test; fixtures need `frontmatter_schema_version` set |
| `scripts/regressions/T10-pre-compact.sh` | 1 | Minimal state for pre-compact hook test |
| `scripts/regressions/T11-drift.sh` | 1 | Drift marker fixture |
| `scripts/regressions/test-banners-schema.sh` | 1 | Banners fixture (also uses .state-snapshot) |
| `scripts/regressions/test-hook-timing.sh` | 1 | Minimal state for timing test |
| `scripts/regressions/test-path-canonicalize.sh` | 1 | Path canonicalization fixture |
| `scripts/regressions/test-pr-a.sh` | ~8 | Multiple scenario fixtures via `_write_state()` helper |
| `scripts/regressions/test-wave-gate.sh` | 3 | Design / execute / malformed scenarios |

**Total: 8 fixture files, ~19 direct state.json writes.** Most follow a `cat > $STATE_FILE <<EOF ... EOF` pattern that would migrate to `state-transition.sh init --json-file -` (stdin).

### 5.4 Summary estimate

| Category | Items | Estimated effort |
|---|---|---|
| Hook code rewrites | 4 hooks (5 call sites) | Low — mechanical substitution |
| PROFILE.md doc rewrites | 2 files, ~6 sites | Low — text search-and-replace |
| Test fixture migration | 8 files, ~19 writes | Medium — requires `init` subcommand + fixture refactor |
| `state-transition.sh` itself | New script, ~9 subcommands | High — core of W6 |
| `frontmatter-gate.sh` extension | ~15 lines | Low |

---

## §6 Rollback Strategy

### 6.1 Per-commit revert

W6 will span at least these commits:
1. `feat: state-transition.sh with init + phase_advance + set_field + append_array + merge + halt_reason + stamp_last_updated + flaky_test_append + backfill_session`
2. `refactor: migrate hook call sites to state-transition.sh`
3. `docs: update PROFILE.md recipes to state-transition.sh`
4. `test: migrate fixture state writes to state-transition.sh init`
5. `feat: frontmatter-gate.sh direct-write blocker`

Reverting commit 5 (the gate) is always safe and sufficient to restore the old write-anywhere behavior. Reverting commits 2–4 (migrations) without reverting commit 5 would leave hooks that call `state-transition.sh` but no `state-transition.sh` — that is a hard-failure scenario. The correct revert order is: 5 → 2/3/4 together → 1.

**Hard-to-revert risk**: none of the W6 changes modify the `state.json` schema (this spike prohibits schema changes per hard rules). Existing state.json files are forward-compatible. The only irreversibility risk is if `state_integrity_hash` is written to live instances — but the gate treats absent hash as pass, so old sessions remain unblocked.

### 6.2 Feature-flag shadow period (mirroring W3-a §7)

1. **Land `state-transition.sh` behind `--enable-single-writer` flag** in `setup-deepwork.sh`. When flag is set: register the `state-transition.sh`-based hooks; also keep `_write_state_atomic` call sites as-is in a shadow mode that calls `state-transition.sh` AND the old helper in parallel, logging divergence.

2. **Run shadow period** (suggest 5 clean sessions). Monitor `hook_warnings[]` for `DIRECT_STATE_WRITE_BLOCKED` entries that indicate call sites not yet migrated.

3. **Flip default**: make `--enable-single-writer` the default, add `--disable-single-writer` escape hatch.

4. **Enable the Write|Edit block** in `frontmatter-gate.sh` only after the shadow period confirms zero `DIRECT_STATE_WRITE_BLOCKED` hits from legitimate call sites.

---

## §7 Tests Required

The following tests must land in W6 (or in the W6 test PR):

| Test ID | Description | File |
|---|---|---|
| ST-a | `phase_advance` to valid next phase succeeds + hash updated | New test |
| ST-b | `phase_advance` to invalid phase (checklist fails) exits 2 + state unchanged | New test |
| ST-c | `append_array .hook_warnings` appends + hash updated | New test |
| ST-d | `merge` with multi-field JSON updates all fields atomically + hash updated | New test |
| ST-e | `halt_reason` writes correct schema + hash updated | New test |
| ST-f | Concurrent invocations of `state-transition.sh` leave valid JSON (flock test, mirrors WSA-f in `test-write-state-atomic.sh`) | New test |
| ST-g | `init` subcommand writes bare state without hash (pre-hash-seeding fixture path) | New test |
| ST-h | `frontmatter-gate.sh` blocks direct Write to `*/state.json` when `_DW_STATE_TRANSITION_WRITER` absent | Extend T9 |
| ST-i | `frontmatter-gate.sh` passes Write to `*/state.json` when `_DW_STATE_TRANSITION_WRITER=1` | Extend T9 |
| ST-j | Integrity gate fires on hash mismatch (external `cp`-style edit) | New test |
| ST-k | Absent `.state_integrity_hash` (pre-W6 instance) passes integrity gate | New test |
| ST-l | `test-write-state-atomic.sh` regression suite still passes (no `_write_state_atomic` behavior change) | Existing (no change needed) |

Existing regression tests for hooks that are migrated (T9, T10, T11, test-banners-schema, test-pr-a, test-wave-gate) must continue to pass after fixture migration to `state-transition.sh init`.

---

## §8 Open Questions

1. **`_write_state_atomic` in `instance-lib.sh:150` (session_id backfill)**: this runs inside `discover_instance`, which is sourced by every hook. Making it call `state-transition.sh` would add a subprocess-within-a-subprocess invocation on every hook fire. Options: (a) keep the raw `_write_state_atomic` call here as an explicitly-exempted internal case and document the exemption, (b) move backfill to setup-deepwork.sh at session start so it never runs in a hot hook path. The W6 implementer must decide — option (b) is preferred if feasible.

2. **`state-transition.sh` as hook output sink**: hooks like `deliver-gate.sh` and `plan-drift-detector.sh` are short-lived subprocesses spawned by CC. Each invocation of `state-transition.sh` is a nested subprocess (hook → state-transition.sh → jq). On macOS, subprocess spawning is ~10ms. For high-frequency hooks (PreToolUse fires per tool call), this adds measurable latency. Mitigation: `state-transition.sh` can be shell-inlined into `instance-lib.sh` as a function (no subprocess) rather than a standalone script. This is a design choice the W6 implementer must make; the CLI surface (subcommands, exit codes) is unchanged either way.

3. **`set_field` safety surface**: a general-purpose `set_field <jq-path> <json-value>` subcommand can set any field including protected ones. W6 must decide whether to allow this (`state-transition.sh` is already the gatekeeper, so arbitrary set is OK) or to whitelist permitted paths. Recommendation: allow arbitrary `set_field` but log every invocation to `.hook_warnings[]` with the field path and caller. This gives audit visibility without restricting flexibility.

4. **Integrity hash and `approve-archive.sh`**: `approve-archive.sh:27` renames `state.json` to `state.archived.json` via `mv`. After W6, the archived copy still carries `.state_integrity_hash`. If an archive is ever inspected or rehydrated, the hash check will fire on the archived copy — potentially blocking reads if the gate is ever added to Read-path hooks. The W6 implementer should confirm no hook reads `state.archived.json` and add a carve-out comment in `approve-archive.sh`.

5. **`phase_advance` gate logic duplication**: today `phase-advance-gate.sh` contains the phase-transition validation logic. W6 proposes that `state-transition.sh phase_advance` runs equivalent logic internally (single-source). This means `phase-advance-gate.sh` either (a) is removed and its PreToolUse registration dropped, or (b) becomes a thin wrapper that calls `state-transition.sh phase_advance --dry-run`. Option (b) preserves the hook's blocking behavior without duplicating the logic. The W6 implementer must choose — option (b) is lower risk.

6. **Schema version for `.state_integrity_hash`**: the field must be added to `references/state-schema.md` and `references/schemas/`. The schema version bump requires a decision about `frontmatter_schema_version` — if that field gates schema enforcement, bumping the schema may trigger enforcement failures on pre-W6 instances. Confirm the version bump strategy before writing the first `state_integrity_hash` to any live instance.

7. **`init` subcommand vs. test fixture exemption**: see §4.3. The `--test-init` guard must prevent `init` from being callable in a live session (i.e., when `state.json` already exists and has a non-null `instance_id`). Define the guard precisely: probably `[[ -f "$STATE_FILE" ]] && [[ "$(jq -r '.instance_id // ""' "$STATE_FILE")" != "" ]] && exit 3` at the top of the `init` branch.
