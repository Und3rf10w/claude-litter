# Deepwork Frontmatter Schemas

Authoritative schema per artifact type. Every field listed here has a named consumer.
**Invariant**: a field must have a named consumer before it ships. Adding a field without
a consumer violates G2 and this invariant.

---

## Floor schema (all artifact types except log.md and prompt.md)

```yaml
artifact_type: <findings|mechanism|coverage|reframe|empirical_results|critique|gate-list|proposals>
author: <teammate-name>
instance: <8-hex>
task_id: "<N>"          # or task_ids: ["N","M"] when one artifact attests multiple tasks
bar_id: <G1 G2 ...>     # or bar_ids: [G1, G2]; null for reframe/critique spanning all gates
sources:
  - <path>              # provenance — paths the artifact consumed
```

## Per-type extensions

| Artifact type | Additional fields | Consumer |
|---|---|---|
| `proposals/v<N>.md` | `version`, `delta_from_prior`, `status`, `bar_status` | `deliver-gate.sh` (delta_from_prior); `/deepwork-status` (bar_status, status) |
| `critique.v<N>.md` | `version`, `verdict: HOLDING\|APPROVED` | `/deepwork-status` (verdict display); `/deepwork-wiki` (verdict column) |
| `findings.<name>.md` | `cross_check_for: null \| <bar_id>` | `/deepwork-status` (cross-check state column) |
| `empirical_results.<id>.md` | `empirical_id: <E-id>`, `result: confirmed\|refuted\|inconclusive` | `/deepwork-status` (empirical outcome row); `wiki-log-append.sh` (richer log entries) |
| `gate-list-v<N>.md` | `version` | `/deepwork-recap` (gate-list back-reference line) |

## Explicit cosmetic fields (human-only, retained for audit)

- `author` — used by `/deepwork-wiki` index to group by teammate; audit trail for incidents
- `sources` — used by `/deepwork-wiki` provenance graph (Sources graph section)
- `version` on `gate-list-v<N>.md` — retained for grep symmetry with proposals/critique

## Field → consumer map

| Field | Artifact type | Consumer | Implementation location |
|---|---|---|---|
| `artifact_type` | all | deepwork-wiki Step 6D (grouping); deepwork-status Step 4B (dispatch) | skills/deepwork-wiki/SKILL.md, skills/deepwork-status/SKILL.md |
| `author` | all | deepwork-wiki Step 6C,E (author display) | skills/deepwork-wiki/SKILL.md |
| `instance` | all | frontmatter-gate.sh (validates match); deepwork-recap (back-ref line) | hooks/frontmatter-gate.sh, skills/deepwork-recap/SKILL.md |
| `task_id`/`task_ids` | all | frontmatter-gate.sh (presence); deepwork-recap (count distinct) | hooks/frontmatter-gate.sh, skills/deepwork-recap/SKILL.md |
| `bar_id`/`bar_ids` | all | frontmatter-gate.sh (presence); deepwork-wiki Step 6E (grouping); deepwork-status Step 4C | hooks/frontmatter-gate.sh, skills/deepwork-wiki/SKILL.md, skills/deepwork-status/SKILL.md |
| `sources` | most | deepwork-wiki Step 6B,D (edge list) | skills/deepwork-wiki/SKILL.md |
| `version` | proposals, critique, gate-list | deliver-gate.sh (for proposals); deepwork-wiki groups by version | hooks/deliver-gate.sh, skills/deepwork-wiki/SKILL.md |
| `delta_from_prior` | proposals | deliver-gate.sh:68-88 (existing) | hooks/deliver-gate.sh |
| `status` | proposals | deepwork-status (state rendering) | skills/deepwork-status/SKILL.md |
| `bar_status` | proposals | deepwork-status (renders verdicts) | skills/deepwork-status/SKILL.md |
| `verdict` | critique | deepwork-status Step 4C,D (dashboard column) | skills/deepwork-status/SKILL.md |
| `cross_check_for` | findings | deepwork-status Step 4C,D (cross-check column) | skills/deepwork-status/SKILL.md |
| `empirical_id` | empirical_results | deepwork-status Step 4C,D | skills/deepwork-status/SKILL.md |
| `result` | empirical_results | deepwork-status Step 4C,D (empirical outcome) | skills/deepwork-status/SKILL.md |
| `replaces` | versioned | deepwork-wiki (supersession graph — deferred to v1.1; explicitly cosmetic in v1) | — |

## Hook registration architecture

Session-scoped hooks (deliver-gate, task-completed-gate, halt-gate, frontmatter-gate, etc.)
are registered dynamically by `setup-deepwork.sh` into `settings.local.json` at session
start. They must NOT be registered statically in `hooks/hooks.json` — doing so would cause
them to fire globally for every Claude Code session that loads the deepwork plugin, not
just active deepwork sessions.

The ONLY hook registered in `hooks.json` is `pre-compact.sh` (PreCompact event), which
gracefully no-ops outside an active deepwork session and must fire before `settings.local.json`
is available (e.g., compaction-during-setup edge case).

This architecture is intentional (G7 attested in proposals/v3-final.md Part D). If you
encounter a hook that appears to be firing outside deepwork sessions, check whether it was
accidentally moved to hooks.json.

## Schema-version sentinel

`setup-deepwork.sh` sets `state.json.frontmatter_schema_version: "1"` at session init.
`frontmatter-gate.sh` checks this field:
- Absent → pre-fix session → gate exits 0 (warn-only on stderr)
- Present and equals "1" → enforce current schema (exit 2 on missing fields)

Sessions started before this schema shipped have no `frontmatter_schema_version` field
and pass freely through the gate.
