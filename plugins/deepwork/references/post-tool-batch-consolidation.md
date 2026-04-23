---
type: reference
name: post-tool-batch-consolidation
description: Design spike for collapsing the 5-hook PreToolUse chain into one PostToolBatch hook
status: pending-implementation
generated: 2026-04-23
---

# PostToolBatch Consolidation — Design

## Context

deepwork registers 5 hooks on PreToolUse in design mode, all parsing state.json independently per-tool call (anti-pattern #1 from `/tmp/deepwork-cc-capabilities.md`):

- `frontmatter-gate.sh` — Write|Edit, validates .md frontmatter + banners[] schema
- `phase-advance-gate.sh` — Write|Edit, blocks premature `.phase` transitions
- `state-drift-marker.sh` (Pre leg) — Write|Edit, snapshots state.json before write
- `deliver-gate.sh` — ExitPlanMode, validates plan Residual unknowns + delta_from_prior
- `verdict-version-gate.sh` — SendMessage, blocks version-mismatched CRITIC verdicts

Each is a separate subprocess spawned by CC per tool call. For a batch of N Write/Edit calls, CC spawns up to 5N hook subprocesses, each calling `discover_instance` and parsing state.json (`setup-deepwork.sh:640-661`).

`PostToolBatch` (hooks.md:510) fires **once** after the entire batch with the full `tool_calls[]` array — one script, one state.json parse. This directly addresses the C1 latency concern: in a batch of 3 parallel Write calls, the current chain runs 15 hook subprocesses; the consolidated chain runs 1.

---

## §1 Candidate hooks

| Hook | Current matcher | Pre/Post | Blocking | state.json reads | marker writes | Decision |
|------|----------------|----------|----------|-----------------|---------------|---------|
| `frontmatter-gate.sh` | Write\|Edit | Pre | Yes (exit 2) | `.frontmatter_schema_version` | none | **Partial** — see §3 |
| `phase-advance-gate.sh` | Write\|Edit | Pre | Yes (exit 2) | `.phase`, `.empirical_unknowns[]`, `.source_of_truth[]`, `.team_name`, `.instance_id` | none | **Partial** — see §3 |
| `state-drift-marker.sh` (Pre leg) | Write\|Edit | Pre | No (exit 0 always) | snapshot only | `.state-snapshot` | **Move to Post** |
| `deliver-gate.sh` | ExitPlanMode | Pre | Yes (exit 2) | none (reads proposal files) | `.hook_warnings[]` on fallthrough | **Must stay Pre** — see §3 |
| `verdict-version-gate.sh` | SendMessage | Pre | Yes (exit 2) | none (reads version-sentinel.json) | none | **Must stay Pre** — see §3 |

Sources: `frontmatter-gate.sh:28-33`, `phase-advance-gate.sh:34-41`, `state-drift-marker.sh:27-33`, `deliver-gate.sh:25-27`, `verdict-version-gate.sh:36-53`, `setup-deepwork.sh:650-655`.

---

## §2 Matcher reconciliation

PostToolBatch has no `matchQuery` matcher — it fires for every batch regardless of tool types (hooks.md:516: "The `matcher` field cannot filter this event per tool"). The consolidated script must demux internally on `tool_calls[i].tool_name`.

**Bash pseudocode for the demux loop:**

```bash
# Read the batch input once
INPUT=$(cat)
TOOL_CALLS=$(printf '%s' "$INPUT" | jq -c '.tool_calls // []')
CALL_COUNT=$(printf '%s' "$TOOL_CALLS" | jq 'length')

BLOCK_REASONS=""

for i in $(seq 0 $((CALL_COUNT - 1))); do
  CALL=$(printf '%s' "$TOOL_CALLS" | jq -c ".[$i]")
  TOOL_NAME=$(printf '%s' "$CALL" | jq -r '.tool_name // ""')
  TOOL_INPUT=$(printf '%s' "$CALL" | jq -c '.tool_input // {}')

  case "$TOOL_NAME" in
    Write|Edit)
      # dispatch_write_edit_checks "$CALL" "$TOOL_INPUT" "$STATE_CONTENT"
      # Runs: state-drift-marker post-batch snapshot comparison, phase-advance re-check
      result=$(dispatch_write_edit "$CALL" "$TOOL_INPUT")
      [[ -n "$result" ]] && BLOCK_REASONS="${BLOCK_REASONS}\n${result}"
      ;;
    ExitPlanMode)
      # deliver-gate logic stays in Pre — NOT dispatched here; see §3
      ;;
    SendMessage)
      # verdict-version-gate logic stays in Pre — NOT dispatched here; see §3
      ;;
    *)
      # No-op for other tool types
      ;;
  esac
done
```

**Mixed-batch scenario** (e.g., batch contains `[Write, SendMessage, ExitPlanMode]`):

The loop iterates all three. `Write` dispatches to `dispatch_write_edit`. `SendMessage` and `ExitPlanMode` are no-ops in the Post handler (they retain their Pre hooks). The script emits a blocking output only if `dispatch_write_edit` found violations. The Pre hooks for `SendMessage` and `ExitPlanMode` have already fired before the batch committed — by the time PostToolBatch fires, those Pre hooks have already blocked or allowed them. The Post handler's role for those tool types is purely observational (if needed at all).

---

## §3 Pre vs Post semantics

PostToolBatch fires **after** writes commit. Pre-blocking hooks prevent malformed writes from landing on disk. The key question per hook:

| Hook | Current Pre/Post | Can move to Post? | Rationale |
|------|-----------------|-------------------|-----------|
| `frontmatter-gate.sh` | Pre (blocking) | **N** | Must block before the malformed .md write lands on disk; a Post check is detection only, not prevention. The banners[] schema validation on state.json writes similarly must prevent corrupt state from being committed. `frontmatter-gate.sh:76-79`, `frontmatter-gate.sh:126-129` |
| `phase-advance-gate.sh` | Pre (blocking) | **N** | Guards the `.phase` transition before it is written; if the write lands with an invalid phase, subsequent hooks read corrupt state. `phase-advance-gate.sh:78-103` |
| `state-drift-marker.sh` (Pre leg) | Pre (non-blocking) | **Y** | The Pre leg only snapshots state.json before the write (`state-drift-marker.sh:31`). It never blocks (exit 0 always, `state-drift-marker.sh:11`). In PostToolBatch, the pre-snapshot step becomes: read the committed state and compare against the previously-cached snapshot. The Post leg logic already exists. |
| `deliver-gate.sh` | Pre (blocking) | **N** | Gates ExitPlanMode — must fire before plan mode exits. There is no write to undo post-fact; the plan-mode exit is the irreversible action. `deliver-gate.sh:46-53` |
| `verdict-version-gate.sh` | Pre (blocking) | **N** | Gates SendMessage — must block the message before it reaches the teammate. A post-send version check has no practical effect since the message is already delivered. `verdict-version-gate.sh:75-81` |

**Result**: Only `state-drift-marker.sh`'s Pre leg migrates to PostToolBatch. The other 4 hooks retain Pre semantics.

The consolidation is therefore **partial**: `state-drift-marker.sh` becomes a unified Pre+Post batch handler. The 4 Pre-blocking hooks (`frontmatter-gate`, `phase-advance-gate`, `deliver-gate`, `verdict-version-gate`) remain as PreToolUse registrations.

The latency win is still meaningful: `state-drift-marker.sh`'s Pre leg fires once per Write/Edit call (5N subprocesses for N-call batches became N subprocesses pre-PostToolBatch; with PostToolBatch, it fires once).

---

## §4 Backward compatibility

PostToolBatch was introduced in v2.1.118 (hooks.md:510; `/tmp/deepwork-cc-capabilities.md` capability table row 1). Installations on older CC versions will receive an unknown event and silently ignore it — the hook will never fire.

**Feature-detection strategy in `setup-deepwork.sh`:**

```bash
# In setup-deepwork.sh, after parsing CC_VERSION from the runtime
CC_VERSION_MAJOR=$(printf '%s' "$CC_VERSION" | cut -d. -f1)
CC_VERSION_MINOR=$(printf '%s' "$CC_VERSION" | cut -d. -f2)
CC_VERSION_PATCH=$(printf '%s' "$CC_VERSION" | cut -d. -f3)

supports_post_tool_batch=0
if [[ "$CC_VERSION_MAJOR" -gt 2 ]] || \
   [[ "$CC_VERSION_MAJOR" -eq 2 && "$CC_VERSION_MINOR" -gt 1 ]] || \
   [[ "$CC_VERSION_MAJOR" -eq 2 && "$CC_VERSION_MINOR" -eq 1 && "$CC_VERSION_PATCH" -ge 118 ]]; then
  supports_post_tool_batch=1
fi

if [[ "$supports_post_tool_batch" -eq 1 ]]; then
  # Register batch-gate.sh on PostToolBatch; omit individual Pre drift-marker registration
  add_hook_event "PostToolBatch" batch_gate
else
  # Fallback: register state-drift-marker.sh on PreToolUse (current behavior)
  add_hook_event "PreToolUse" drift_marker_pre
fi
# frontmatter-gate, phase-advance-gate, deliver-gate, verdict-version-gate
# always register on PreToolUse regardless of version (they must stay Pre)
```

The setup script currently reads the CC version at `setup-deepwork.sh:640-664` design-mode block. The version gate would sit in this block before the hook wiring. CC version detection: the W3-b implementer must verify the exact env var or binary flag that exposes the runtime version string (flagged in §8).

---

## §5 Reference pattern (halt-gate.sh)

`batch-gate.sh` must mirror `halt-gate.sh`'s structural discipline (`halt-gate.sh:1-35`):

1. **Fail-open on malformed state.json** — `halt-gate.sh:46-47` reads state.json with an `|| exit 0` guard. Any JSON parse failure passes through rather than wedging the turn.
2. **Discriminated error codes** — `halt-gate.sh:60-71` uses named validation tokens (`NULL`, `NOT_OBJECT`, `MISSING_SUMMARY`, `EMPTY_SUMMARY`, etc.) rather than generic error strings. `batch-gate.sh` should define equivalent codes: `MALFORMED_STATE`, `MISSING_FRONTMATTER_SCHEMA`, `MALFORMED_BANNER`, `PREMATURE_PHASE_ADVANCE`, `DRIFT_SNAPSHOT_FAILED`.
3. **Explicit pass/fail reasoning in exit-code comments** — `halt-gate.sh:9-12` documents each exit code at the top of the file. `batch-gate.sh` must do the same.
4. **instance-lib.sh for timing and discover_instance** — `halt-gate.sh:41,44` sources `instance-lib.sh` and gates on `discover_instance`. PostToolBatch still carries `session_id` in the input; the same pattern applies.

---

## §6 Proposed batch-gate.sh skeleton

```bash
#!/usr/bin/env bash
# hooks/batch-gate.sh — PostToolBatch consolidation for state-drift-marker Pre leg.
# Fires once per batch after all tool calls resolve.
#
# Exit conventions (hooks.md:510, hooks.md:539):
#   0  — non-blocking; batch result forwarded as-is
#   2  — blocking error; stderr + additionalContext injected into tool results
#
# Discriminated error codes:
#   MALFORMED_STATE       — state.json unreadable or not valid JSON
#   DRIFT_SNAPSHOT_FAILED — .state-snapshot write failed (non-blocking, logged only)
#   PHASE_TRANSITION_POST — phase changed in batch; logged to log.md (non-blocking)
#   BAR_VERDICT_POST      — bar verdict changed in batch; logged to log.md (non-blocking)

set +e
command -v jq >/dev/null 2>&1 || exit 0

INPUT=$(cat)
_PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
source "${_PLUGIN_ROOT}/scripts/instance-lib.sh"

SESSION_ID=$(printf '%s' "$INPUT" | jq -r '.session_id // ""' 2>/dev/null || echo "")
discover_instance "$SESSION_ID" 2>/dev/null || exit 0   # fail-open: no instance

# Read state.json once for the entire batch
STATE_CONTENT=$(cat "$STATE_FILE" 2>/dev/null) || exit 0              # MALFORMED_STATE → fail-open
printf '%s' "$STATE_CONTENT" | jq -e . >/dev/null 2>&1 || exit 0    # MALFORMED_STATE → fail-open

TOOL_CALLS=$(printf '%s' "$INPUT" | jq -c '.tool_calls // []' 2>/dev/null)
CALL_COUNT=$(printf '%s' "$TOOL_CALLS" | jq 'length' 2>/dev/null || echo "0")
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || echo "")

ADDITIONAL_CONTEXT=""

# ── dispatch per tool call ────────────────────────────────────────────────────

for i in $(seq 0 $((CALL_COUNT - 1))); do
  CALL=$(printf '%s' "$TOOL_CALLS" | jq -c ".[$i]" 2>/dev/null)
  TOOL_NAME=$(printf '%s' "$CALL" | jq -r '.tool_name // ""' 2>/dev/null)
  FILE_PATH=$(printf '%s' "$CALL" | jq -r '.tool_input.file_path // .tool_input.path // ""' 2>/dev/null)

  case "$TOOL_NAME" in
    Write|Edit)
      # Only act on state.json writes
      [[ "$FILE_PATH" == "${INSTANCE_DIR}/state.json" ]] || continue

      # Compare snapshot (written by the now-removed Pre leg) with committed state
      if [[ -f "${INSTANCE_DIR}/.state-snapshot" ]]; then

        OLD_PHASE=$(jq -r '.phase // ""' "${INSTANCE_DIR}/.state-snapshot" 2>/dev/null || echo "")
        NEW_PHASE=$(jq -r '.phase // ""' "${INSTANCE_DIR}/state.json" 2>/dev/null || echo "")
        if [[ -n "$OLD_PHASE" && "$OLD_PHASE" != "$NEW_PHASE" ]]; then
          MARKER="> [phase-transition ${NOW}] ${OLD_PHASE} → ${NEW_PHASE}"
          if [[ -f "$LOG_FILE" ]] && ! tail -50 "$LOG_FILE" 2>/dev/null | grep -qF "$MARKER"; then
            printf '%s\n' "$MARKER" >> "$LOG_FILE" 2>/dev/null || true
          fi
        fi

        OLD_BAR=$(jq -r '.bar[] | "\(.id)\t\(.verdict // "null")"' "${INSTANCE_DIR}/.state-snapshot" 2>/dev/null || echo "")
        NEW_BAR=$(jq -r '.bar[] | "\(.id)\t\(.verdict // "null")"' "${INSTANCE_DIR}/state.json" 2>/dev/null || echo "")
        if [[ "$OLD_BAR" != "$NEW_BAR" ]]; then
          while IFS=$'\t' read -r BAR_ID BAR_VERDICT; do
            [[ -z "$BAR_ID" ]] && continue
            OLD_V=$(printf '%s' "$OLD_BAR" | awk -F'\t' -v id="$BAR_ID" '$1==id{print $2}')
            if [[ "$OLD_V" != "$BAR_VERDICT" ]]; then
              BMARKER="> [bar-verdict ${NOW}] ${BAR_ID} → ${BAR_VERDICT}"
              if [[ -f "$LOG_FILE" ]] && ! tail -50 "$LOG_FILE" | grep -qF "$BMARKER"; then
                printf '%s\n' "$BMARKER" >> "$LOG_FILE" 2>/dev/null || true
              fi
            fi
          done < <(printf '%s\n' "$NEW_BAR")
        fi

        rm -f "${INSTANCE_DIR}/.state-snapshot" 2>/dev/null || true
      fi
      ;;
    # ExitPlanMode and SendMessage remain gated by their Pre hooks; no Post action needed
    *) continue ;;
  esac
done

# ── emit output (hooks.md:532-542) ───────────────────────────────────────────
# This hook is non-blocking (drift observation only). Exit 0.
# If a future iteration adds blocking checks, emit:
#   printf '%s' "$ADDITIONAL_CONTEXT" >&2 && exit 2
exit 0
```

The Pre leg snapshot (`cp state.json .state-snapshot`) that currently lives in `state-drift-marker.sh:31` must be retained as a standalone PreToolUse registration or inlined into `frontmatter-gate.sh` (which already fires on Write|Edit). The W3-b implementer decides. The snapshot-before-write invariant must survive the migration.

---

## §7 Migration path

1. **Land `batch-gate.sh` behind `--enable-batch-gate` flag in `setup-deepwork.sh`** (opt-in). When flag is set and CC >= 2.1.118, register `batch-gate.sh` on `PostToolBatch` instead of the standalone `state-drift-marker.sh` Pre registration. The 4 Pre-blocking hooks are unaffected.

2. **Run in parallel with current hooks** during a shadow period. Keep both the legacy Pre `state-drift-marker.sh` registration and `batch-gate.sh` active simultaneously. Log divergence (cases where the Post batch handler would have produced a different log.md entry than the Pre hook).

3. **Flip the default** once divergence is zero over N sessions (suggest N=10 clean sessions as the acceptance threshold). Update `setup-deepwork.sh` to make `--enable-batch-gate` the default and add `--disable-batch-gate` as an escape hatch.

4. **Remove the Pre `state-drift-marker.sh` registration** from the design-mode block (`setup-deepwork.sh:653`) after the shadow period confirms no divergence. The PostToolUse leg of `state-drift-marker.sh` (`setup-deepwork.sh:654`) can also be removed since `batch-gate.sh` subsumes it.

---

## §8 Open questions

1. **snapshot-before-write ownership**: With the Pre leg of `state-drift-marker.sh` removed, who writes `.state-snapshot` before the Write commits? Options: (a) a minimal standalone PreToolUse hook just for snapshots, (b) inline the `cp` into `frontmatter-gate.sh`'s Write|Edit path. The W3-b implementer must decide before removing the Pre registration.

2. **tool_calls[] ordering**: Does CC ship `tool_calls[]` in the order the model requested the calls, or in execution-completion order? If completion order, the index of a given Write call in the array may not match its logical sequence. This affects whether snapshot/diff pairs correlate correctly across a batch with multiple state.json writes. Needs verification against the CC runtime.

3. **CC version string availability**: What env var or flag exposes the CC runtime version string inside `setup-deepwork.sh`? The feature-detection logic in §4 assumes it's readable at setup time. If CC doesn't expose a version string in the shell environment, the fallback strategy needs a different detection mechanism (e.g., attempt to register a PostToolBatch hook and check for a registration error).

4. **Multiple state.json writes in one batch**: If the model issues two Write calls to state.json in the same batch, the snapshot captured before the first write may not correctly baseline the second. The demux loop in §6 handles this conservatively (operates on the final committed state), but the phase-transition diff may miss intermediate transitions. Flag for the W3-b implementer.
