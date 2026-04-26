---
description: "Rebuild state.json from events.jsonl — full replay with hash-chain validation"
allowed-tools: ["Bash", "Read", "Glob"]
---

# Deepwork Reconcile

Rebuild the active session's `state.json` from its event log (`events.jsonl`) using a full hash-chain replay.

**When to invoke:**
- `frontmatter-gate` emits `EVENT_HEAD_MISMATCH` or `STATE_DIVERGENCE`
- `state.json` is suspected corrupt or has been manually edited
- After a crash that may have left `state.json` and `events.jsonl` out of sync
- Any time you want to verify event log integrity without modifying state

## Steps

1. Locate the active instance state file:
```
Glob: .claude/deepwork/*/state.json
```
If no file is found, report "No active deepwork session" and stop.

2. Run the replay:
```bash
bash plugins/deepwork/scripts/state-transition.sh replay \
  --state-file .claude/deepwork/<instance-id>/state.json
```

The `replay` subcommand:
- Reads `events.jsonl` from the same directory as `state.json`
- Verifies the hash chain from GENESIS through every event
- Reduces all events into a new state snapshot
- Atomically overwrites `state.json` with the reduced state
- Recomputes `state_integrity_hash` and `event_head`
- Prints a reconciliation report to stdout

3. Display the reconciliation report verbatim. It includes:
   - Number of events processed
   - Final `event_head` hash

4. If the command exits non-zero:
   - Exit code 1: events.jsonl missing or unreadable, invalid JSON at a specific line, or hash chain break — report the error message from stderr; `state.json` was not overwritten

On a clean reconciliation, report: "Reconcile complete — state.json rebuilt from N events, hash chain valid."
