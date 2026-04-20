# Named Versioning Protocol

Every proposal produced by the deepwork team gets a version string. When any proposal content changes, the version bumps and a `delta_from_prior` field is populated. CRITIC re-evaluates fresh on version bump.

## Why

Without named versioning, the default is bandaid-spiral: proposals mutate silently between critique cycles; reviewers lose track of what they already verdicted; premature convergence creeps in. The "name changes" gate forces CRITIC (and the team) to review substantive changes rather than let them slip through as "tweaks." Each version carries an explicit delta.

## Version naming

Versions live at `proposals/<version>.md` in the instance directory. The filename IS the version string.

- **First version**: `v1.md`
- **After any content change**: `v2.md`, `v3.md`, ...
- **Minor refinements** (follow-up fixes, doc cleanups): `v2.1.md`, `v2.2.md`
- **Finals** (when the team believes convergence): `v3-final.md`
- **Post-final patches** (a late REFRAMER or CRITIC finding after a "final" was declared): `v3-final-final.md` — yes, really
- **Abandoned branches**: mark filename with `-rejected` suffix but DO NOT DELETE. Preserves the due-diligence record.

Avoid:
- Overwriting a prior version file — always create a new one
- Skipping version numbers (no jumping v1 → v5)
- Renumbering (v1 stays v1 even if you later wish you'd called it v0)

## Required front-matter

Every `proposals/v<N>.md` file starts with YAML front-matter:

```yaml
---
version: "v3-final-final"
delta_from_prior: |
  - FF1: broaden wording in section 2 to be source-agnostic (covers both trigger paths)
  - FF2: add precedence rule when two mutually-exclusive options are both enabled
  - Preserves v3-final architecture; no mechanism changes
bar_status:
  G1: PASS
  G2: CONDITIONAL-on-sandbox-test-post-merge
  G5: PASS
  G15: RESOLVED via alternative mitigation path
---
```

Fields:
- `version` — redundant with filename but makes the file self-describing
- `delta_from_prior` — bulleted list of what changed from the previous version. One line per delta. Must be populated for every version > v1; for v1, set to `null`.
- `bar_status` — per-gate verdict as of this version. Allows quickly scanning "what's outstanding."

## Delta discipline

A well-formed `delta_from_prior` answers:
- **What changed?** (the diff, at bullet granularity)
- **Why?** (the motivating finding or feedback)
- **What's preserved?** (useful for signaling "this is a refinement, not a rewrite")

Bad delta examples:
- `delta_from_prior: "various improvements"` — not reviewable
- `delta_from_prior: "addressed feedback"` — what feedback, what change
- `delta_from_prior: "see git history"` — the point of the field is to make the delta explicit in the doc

Good delta examples:
- `"M1: added 5-line patch to <module>:<function> to auto-accept session rotation when the trigger marker is present"`
- `"M2: companion component self-heals on session-reset via a PPID-keyed marker (no new CLI surface)"`
- `"removed explicit re-injection step from supervisor — session-reset handler now re-injects automatically"`

## CRITIC's behavior on version bump

When the orchestrator bumps to a new proposal version, CRITIC MUST:
1. Re-read the new version (not just the delta — the delta is a hint, not the truth)
2. Re-verdict every gate that the delta touches
3. Preserve unchanged verdicts from the prior version (document them as "verdict preserved from v<N-1>" to save time without losing audit trail)
4. Emit a fresh HOLDING or APPROVED message for the new version

Do NOT collapse a v2 critique into a "same as v1 with tweaks" note. Even small deltas sometimes invalidate prior PASS verdicts — CRITIC withdrawing an earlier APPROVED based on a later finding is expected behavior, not politically awkward.

## User-facing delivery

At DELIVER phase, the orchestrator calls `ExitPlanMode` with the FINAL version's content — typically `v<N>-final` or `v<N>-final-final` depending on how many refinement passes happened.

The user sees the plan content. The user does NOT need to see the version history in the plan surface — that's internal provenance. But the `proposals/` directory is preserved on disk for audit.

## Named-versioning prevents

- **Silent drift**: proposal content changes without triggering re-review
- **Forgetting what was verdicted**: CRITIC said PASS on v1; v2 snuck in changes; the PASS was no longer valid but nobody noticed
- **Premature "it's the same thing"**: authors claim "just small fixes" to avoid re-review; explicit delta forces honesty
- **Losing rejected options**: previous versions are on disk, not overwritten; a rejected reframe can be consulted later if the chosen path doesn't work
