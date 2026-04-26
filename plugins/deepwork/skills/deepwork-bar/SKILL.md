---
description: "Add, remove, or list written-bar criteria for the active deepwork session"
argument-hint: "add '<criterion>' [--categorical-ban] | remove <id> | list"
allowed-tools: ["Read(.claude/deepwork/**)", "Write(.claude/deepwork/**)", "Edit(.claude/deepwork/**)", "Glob", "Bash(jq:*)", "Bash(mv:*)"]
---

# Deepwork Bar Management

Manually manage the `state.json.bar[]` array — the gate criteria CRITIC verdicts against.

## Arguments

`$ARGUMENTS` is one of:
- `add "<criterion>" [--categorical-ban]` — append a new criterion with auto-assigned id (G<N+1>). Use `--categorical-ban` for hard limits.
- `remove <id>` — remove the criterion with the given id (e.g., `G3`)
- `list` — show current bar criteria with verdicts

## Flow

1. Use Glob to find active instance state:
```
Glob: .claude/deepwork/*/state.json
```

2. If no active session, report "No active deepwork session."

3. If multiple, `AskUserQuestion` to pick.

4. Parse `$ARGUMENTS`. Examples:
   - `add "graceful rollback path exists"`
   - `add "no new dependencies" --categorical-ban`
   - `remove G7`
   - `list`

5. Perform the action:

### `add "<criterion>" [--categorical-ban]`

Compute next id (max existing + 1, starting at G1), then call the canonical writer:

```bash
STATE=".claude/deepwork/<id>/state.json"
NEXT_ID=$(jq -r '
  if (.bar // []) | length == 0 then "G1"
  else
    ((.bar | map(.id | sub("^G"; "") | tonumber) | max) + 1) as $n
    | "G\($n)"
  end
' "$STATE")

bash "${CLAUDE_PLUGIN_ROOT}/scripts/state-transition.sh" \
  --state-file "$STATE" bar_add \
  --id "$NEXT_ID" \
  --statement "<criterion>" \
  $( [[ "<categorical-ban-flag>" == "--categorical-ban" ]] && echo "--categorical-ban" )
```

Report: "Added bar criterion <id>: <criterion>. CRITIC will verdict against this on the next CRITIQUE cycle."

### `remove <id>`

Delete the entry with matching id via the canonical writer:

```bash
bash "${CLAUDE_PLUGIN_ROOT}/scripts/state-transition.sh" \
  --state-file "$STATE" bar_remove --id "<id>"
```

Report the removed criterion, or error if not found.

Warning: if the bar is currently CRITIQUE-active and the removed criterion had a PASS verdict, the removal is fine. If it had FAIL/CONDITIONAL, the orchestrator should not take this as "problem solved" — ask the user to confirm.

### `list`

Print:

```
Bar for instance <id>:

G1 [PASS]      functional goal achieved
               evidence: proposals/v2.md:45 cites X

G2 [HOLDING]   preserves REPL interactivity
               evidence: coverage.terminal.md matrix

G3 [CATEGORICAL BAN]  no minified-JS line pinning without feature-detect
                      (no verdict yet — applied at CRITIQUE)

...
```

Show `[CATEGORICAL BAN]` flag next to criteria with `categorical_ban: true`. Show `[<verdict>]` if verdict is set, else `[pending]`.

If empty: "Bar not yet populated. Orchestrator will populate in SCOPE phase."

## Notes

- Bar changes trigger CRITIC re-evaluation on the next CRITIQUE cycle. Existing verdicts for unchanged criteria are preserved.
- Ids are auto-assigned and stable across versions — don't renumber. If you remove G3 and later add another, it gets G(N+1) where N is the max-ever-used id, not G3.
- Categorical bans can't be waived or weighed against other merits by CRITIC. Use sparingly and deliberately.
