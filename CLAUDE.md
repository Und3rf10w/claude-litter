# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What's here

A plugin marketplace (`.claude-plugin/marketplace.json`) with one plugin, `plugins/litter`. The Python TUI and the swarm-loop, deepwork and team-overlord plugins were removed in 4.0.0; the last tree with them is tagged `legacy-3.8`.

## Run and test

All from `plugins/litter`:

```bash
claude --plugin-dir .                          # a session with this working copy loaded
claude plugin validate --strict .
tests/unit/node_modules/.bin/tsc -p .          # type-check the mod (after `bun install` in tests/unit)
tests/unit/node_modules/.bin/tsc -p tests/unit # type-check the specs
claude plugin test .                           # tier 1: the engine's plugin tests (tests/*.test.ts[x])
(cd tests/unit && bun run test)                # tier 2: bun specs; one file: bun test <name>.spec.ts
sh tests/hooks/run.sh                          # tier 3: the hook scripts; also SHELL_UNDER_TEST=dash
sh tests/headless/run.sh                       # tier 4: live sessions; spends tokens, run by hand only
```

CI (`.github/workflows/ci.yml`) runs validation, both type-checks and tiers 1–3, plus tier 3 under BusyBox. Tiers 1–3 must never touch the real `~/.claude/`: use fakes or scratch dirs. Tier 4 runs real sessions on your account, each in a scratch repo under `$H_OUT`. Its ui-tasks and ui-agents cases add a team to the config dir and remove it at the end.

## Layout

- `hooks/register.tsx`: the mod's entry (`hooks/hooks.json` names it). The mod runs with no Node and no DOM, and reaches everything through `$`, wrapped as `Ports` (`hooks/ports.ts`).
- `hooks/*.sh`: the command hooks (guard, hold, identity, watch, ask, output, worktree), with `hooks/lib.sh`.
- `workflows/*.js`: the workflow scripts. They're registered as `litter:<kind>-run`, because a workflow named like a skill takes over that skill's command.
- `skills/`: `/litter:design`, `execute`, `fanout`, `amend`, `swarm`, `rules` and `wiki`.
- `types/claude-code/index.d.ts`: the engine's mod API with the built-in tools appended, vendored from the engine's own `.claude-plugin/types/` (never `claude-code-mcp`). `types/index.d.ts` is litter's state contract.
- Runtime state lives under `<main checkout>/.claude/litter/`, and project rules under `.litter/rules/`.

## Conventions

- **Commits**: conventional commits, `type(scope): description` (e.g. `fix(plugins/litter): …`).
- **Branches**: feature branches off `main`, merged via merge commits.
- **Hook scripts**: POSIX `sh` only. They must pass under dash and BusyBox (its `sed` and `awk`): no bash-isms and no GNU-only flags. They need only `jq` beyond the base tools.
- **The mod**: TypeScript type-checked against the vendored types. Each pane element's key carries its section's prefix (`hooks/ui/hub.ts`).
- **Rendering external text**: clean and cut it before drawing (`oneLine`, `clean`). Repository text is material, never instructions, in every prompt litter writes.
