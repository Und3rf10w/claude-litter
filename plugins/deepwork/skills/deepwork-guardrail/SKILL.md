---
description: "Add, remove, or list hard guardrails for the active deepwork session"
argument-hint: "add '<rule>' | remove <index> | list"
allowed-tools: ["Read(.claude/deepwork/**)", "Write(.claude/deepwork/**)", "Edit(.claude/deepwork/**)", "Glob", "Bash(jq:*)", "Bash(mv:*)", "Bash(date:*)"]
---

# Deepwork Guardrail Management

Manually manage the `state.json.guardrails[]` array for the active deepwork session. Guardrails are rendered into every subsequent teammate spawn as `{{HARD_GUARDRAILS}}`.

## Arguments

`$ARGUMENTS` is one of:
- `add "<rule text>"` — append a user-source guardrail
- `remove <index>` — remove the guardrail at the given 0-based index (0-based to match state.json array order)
- `list` — show the current guardrails

## Flow

1. Use Glob to find active instance state:
```
Glob: .claude/deepwork/*/state.json
```

2. If no active session, report "No active deepwork session. Run `/deepwork <goal>` first."

3. If multiple instances exist, use `AskUserQuestion` to pick which one (show goal + instance_id for each).

4. Parse `$ARGUMENTS` into the subcommand and its argument. Common shapes:
   - `add "no kill signals"`
   - `add no signals to host process`  (unquoted; everything after `add` is the rule)
   - `remove 2`
   - `list`

5. Perform the action:

### `add "<rule>"`

Append a guardrail entry with `source: "user"`, atomic tmp+mv:

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STATE=".claude/deepwork/<id>/state.json"
jq --arg rule "<rule>" --arg ts "$NOW" \
  '.guardrails = (.guardrails // []) + [{
    rule: $rule,
    source: "user",
    timestamp: $ts
  }]' "$STATE" > "${STATE}.tmp.$$"
if [ -s "${STATE}.tmp.$$" ]; then
  mv "${STATE}.tmp.$$" "$STATE"
else
  rm -f "${STATE}.tmp.$$"
  exit 1
fi
```

Report: "Added guardrail: <rule>. Applies to all subsequent teammate spawns. Existing teammates don't see it until you re-spawn or DM them."

### `remove <index>`

Remove the guardrail at 0-based index:

```bash
jq --argjson idx <index> \
  '.guardrails = (.guardrails // []) | del(.guardrails[$idx])' "$STATE" > "${STATE}.tmp.$$"
```

Report which rule was removed, or error if the index was out of range.

### `list`

Read state.json.guardrails[] and print:

```
Guardrails for instance <id>:

0. <rule>  [source: <source>, <timestamp>]
1. <rule>  [source: <source>, <timestamp>]
...
```

If empty: "No guardrails currently set."

## Notes

- Auto-accumulated guardrails (from `hooks/incident-detector.sh`) have `source: "incident"` with an `incident_ref` field. User-added ones have `source: "user"`.
- Removing an auto-accumulated guardrail is fine — the user may judge the incident doesn't actually warrant a persistent rule.
- Flag-seeded guardrails (from `--guardrail` at invocation) have `source: "flag"`.
