---
description: "Add, remove, replace, or list hard guardrails for the active deepwork session"
argument-hint: "add [--source <src>] '<rule>' | remove <index> | replace <index> [--source <src>] '<rule>' | list"
allowed-tools: ["Read(.claude/deepwork/**)", "Write(.claude/deepwork/**)", "Edit(.claude/deepwork/**)", "Glob", "Bash(jq:*)", "Bash(mv:*)", "Bash(date:*)"]
---

# Deepwork Guardrail Management

Manually manage the `state.json.guardrails[]` array for the active deepwork session. Guardrails are rendered into every subsequent teammate spawn as `{{HARD_GUARDRAILS}}`.

## Arguments

`$ARGUMENTS` is one of:
- `add [--source <src>] "<rule text>"` — append a guardrail. `--source` defaults to `"user"`; override with values like `"scope-boundary"`, `"orchestrator"`, `"incident"` when the rule isn't a direct user-authored constraint.
- `remove <index>` — remove the guardrail at the given 0-based index (0-based to match state.json array order).
- `replace <index> [--source <src>] "<rule text>"` — overwrite the rule (and optionally the source) at 0-based index. Preserves the existing timestamp unless `--source` is supplied AND the existing source was a computed/auto source (`incident`, `flag`) — in which case the timestamp is refreshed to `now()` to reflect the re-attribution.
- `list` — show the current guardrails.

## Flow

1. Use Glob to find active instance state:
```
Glob: .claude/deepwork/*/state.json
```

2. If no active session, report "No active deepwork session. Run `/deepwork <goal>` first."

3. If multiple instances exist, use `AskUserQuestion` to pick which one (show goal + instance_id for each).

4. Parse `$ARGUMENTS` into the subcommand and its argument. Common shapes:
   - `add "no kill signals"` (defaults to `source: "user"`)
   - `add --source scope-boundary "plan-only scope: no target-repo edits"` (explicit source)
   - `add no signals to host process`  (unquoted; everything after `add` is the rule)
   - `remove 2`
   - `replace 3 "new rule text"` (preserves existing source)
   - `replace 3 --source orchestrator "new rule text"` (changes source)
   - `list`

   `--source <value>` is optional for `add` and `replace`. Valid source values (convention, not validated): `user`, `incident`, `flag`, `scope-boundary`, `orchestrator`, `teammate`. Any non-empty string is accepted.

5. Perform the action:

### `add [--source <src>] "<rule>"`

Append a guardrail entry with the given (or default `"user"`) source, atomic tmp+mv:

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
STATE=".claude/deepwork/<id>/state.json"
SOURCE="${SOURCE_OVERRIDE:-user}"  # parsed from --source, default "user"
jq --arg rule "<rule>" --arg source "$SOURCE" --arg ts "$NOW" \
  '.guardrails = (.guardrails // []) + [{
    rule: $rule,
    source: $source,
    timestamp: $ts
  }]' "$STATE" > "${STATE}.tmp.$$"
if [ -s "${STATE}.tmp.$$" ]; then
  mv "${STATE}.tmp.$$" "$STATE"
else
  rm -f "${STATE}.tmp.$$"
  exit 1
fi
```

Report: "Added guardrail [source: <src>]: <rule>. Applies to all subsequent teammate spawns. Existing teammates don't see it until you re-spawn or DM them."

### `remove <index>`

Remove the guardrail at 0-based index:

```bash
jq --argjson idx <index> \
  '.guardrails = (.guardrails // []) | del(.guardrails[$idx])' "$STATE" > "${STATE}.tmp.$$"
```

Report which rule was removed, or error if the index was out of range.

### `replace <index> [--source <src>] "<rule>"`

Overwrite the rule at 0-based index. Attribution is preserved by default — if `--source` is not supplied, the entry's existing `source` field is kept. If `--source` is supplied, it replaces the source AND the timestamp is refreshed to `now()` (because re-attribution is itself an event worth timestamping). The original rule text is lost; use `list` first if you want to log it before replacement.

```bash
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# SOURCE_OVERRIDE is empty if --source was not supplied
jq --argjson idx <index> --arg rule "<rule>" --arg src "${SOURCE_OVERRIDE:-}" --arg ts "$NOW" \
  '
  .guardrails = (.guardrails // []) |
  if ($idx < 0) or ($idx >= (.guardrails | length)) then
    error("replace: index \($idx) out of range (0..\(.guardrails | length - 1))")
  else
    .guardrails[$idx].rule = $rule
    | if $src == "" then .
      else .guardrails[$idx].source = $src
           | .guardrails[$idx].timestamp = $ts
      end
  end
  ' "$STATE" > "${STATE}.tmp.$$"
if [ -s "${STATE}.tmp.$$" ]; then
  mv "${STATE}.tmp.$$" "$STATE"
else
  rm -f "${STATE}.tmp.$$"
  exit 1
fi
```

Report: "Replaced guardrail [<index>] — source: <src>, new rule: <rule>."

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
