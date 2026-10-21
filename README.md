<div align="center">
  <img src="./assets/logo.png" alt="Claude Litter" width="320" />
  <br />
  <em>Verified multi-agent runs for Claude Code</em>
  <br /><br />

<a href="https://github.com/Und3rf10w/claude-litter/releases"><img src="https://img.shields.io/badge/version-4.0.0-22c55e?style=flat-square" alt="Version 4.0.0" /></a>
<a href="https://code.claude.com/"><img src="https://img.shields.io/badge/Claude_Code-2.1.288%2B-orange?style=flat-square" alt="Claude Code 2.1.288+" /></a>

</div>

---

**Claude Litter** is a plugin marketplace built around **[litter](plugins/litter)**. `litter` runs multi-agent work as [Claude Code](https://code.claude.com) workflows: adversarial designs, gate-by-gate plan executions, parallel task fan-outs, and hierarchical agent swarms led from your session. A hooks module (a **mod**) runs beside them: it records every step to an append-only ledger, runs your `verify` command itself, holds each agent to its role's files and tools, and lands only trees that passed verification and independent review.

`litter` replaces this repository's earlier plugins (`swarm-loop`, `deepwork`, and `team-overlord`) and its standalone Python TUI. The last release containing them is tagged [`legacy-3.8`](https://github.com/Und3rf10w/claude-litter/tree/legacy-3.8).

## Install

```
/plugin install litter --marketplace Und3rf10w/claude-litter
```

Or add the marketplace first, then install from it:

```
/plugin marketplace add Und3rf10w/claude-litter
/plugin install litter@claude-litter
```

`litter` requires:
- Claude Code `2.1.288` or later;
- `git`;
- `jq` on `PATH` (for the command hooks);
- a POSIX `sh`.

Runs start from a clean, committed working tree in `auto` or `default` permission mode. The mod refuses to launch under `bypass-permissions` or `accept-edits`.

## What it does

| Command | What runs |
| --- | --- |
| `/litter:design <problem>` | Independent investigators (`falsifier`, `coverage`, `mechanism`), an isolated `prober`, a `reframer` that challenges the goal, an `author`, and a `design-critic` with the only veto iterate against a written bar agreed first. An approved plan comes back for review in plan mode. |
| `/litter:execute <plan.md \| goal>` | Implements an approved plan gate by gate (or turns a goal into gates first via `litter:plan-run`). An independent `gate-critic` must pass each gate, and the mod commits it only after its own run of the `verify` command passes on that exact tree. |
| `/litter:fanout <tasks>` | Runs independent tasks in parallel, with each writer task in its own git worktree. A `verifier` checks each task, and the mod merges the branches and verifies the combined tree before anything lands. |
| `/litter:amend <gate-id> <change>` | Reworks one gate of an execute plan with a stated change in a single-gate background run, judged by the same independent critic and verified by the mod. |
| `/litter:swarm <description>` | Drafts, starts, leads, and ends a tree of agents where orchestrators each own a scoped part of the work and delegate to their own workers. The swarm is drafted into the swarm builder and starts when you press **Launch** there. |
| `/litter:rules list \| add \| show \| retire \| import` | Manages standing rules and bans that `litter` agents receive wherever they apply (`user`, `project`, and `local` scopes). Rules are accepted in the Rules pane, can be imported from `deepwork` guardrails, and export as Claude Code rule files. |
| `/litter:wiki` | Rebuilds `.claude/litter/WIKI.md`, an index of every `litter` run and swarm in the repository and the decisions they produced. |

### How runs are verified and landed

- **Workflows (`workflows/*.js`)**: `design-run`, `plan-run`, `execute-run`, and `fanout-run` execute as deterministic Claude Code `Workflow` scripts using structured output schemas and fresh context per agent call.
- **The Mod (`hooks/register.tsx`)**: The single writer for `.claude/litter/`. It validates workflow launches against recorded `run.start` specs, runs `verify` itself as an argument vector (never a shell string), snapshots the git tree before and after verification, overwrites test claims with observed exit codes, and commits only the exact verified tree on `land`.
- **Command Hook Guard (`hooks/*.sh`)**: POSIX `sh` hooks enforce per-role and per-swarm-node file ownership, read-only vs. read-write Bash policies, and worktree setup or directory linking.
- **When a run fails (`repair`)**: With `repair` set to `auto` (the default), a failed fanout, or an execute run that halted on a plan gap or ran out of attempts, continues as a bounded repair swarm and lands only verified, independently approved work. With `off`, the run stops, preserves all state and worktrees, and offers continuation routes.

### The `/litter` pane

`/litter [section] [arg]` opens `litter`'s in-session UI pane with eight sections:

1. **Home** — overview of active runs, live swarms, open questions, and pending rule proposals
2. **Runs** — the board of runs, gates, attempts, verdicts, and summaries
3. **Swarms** — the interactive swarm builder and live swarm tree browser
4. **Rules** — review, accept, dismiss, retire, or import `user`, `project`, and `local` rules
5. **Tasks** — view and edit a team's tasks
6. **Agents** — inspect agents, write to an agent's inbox, broadcast to a team, and stop an agent
7. **Stats** — session and per-swarm spend, token/cache breakdown, context, and limits
8. **Doctor** — environment, hook, and policy diagnostics

`ctrl+x tab` focuses the pane, `1`–`8` switch sections, and `esc` returns focus to the prompt.

`litter` keeps runtime state under `.claude/litter/` in your repository's main checkout (each run's plan, ledger, and summary, swarm state, and hook state). Project rules live in `.litter/rules/` so they can be committed and shared.

## Options

Configure `litter` via `/plugin` or under `pluginConfigs.litter.options` in a Claude Code settings file (`userConfig` in [`plugins/litter/.claude-plugin/plugin.json`](plugins/litter/.claude-plugin/plugin.json)):

| Option | Default | Description |
| --- | --- | --- |
| `verify` | — | Command that decides whether a gate is done, as an argument list with no shell string (e.g. `["uv", "run", "pytest", "tests/", "-q"]`). `litter` runs it directly and records the exit code. |
| `goalCheck` | — | Optional argument list that checks a goal-mode run's goal at the end. Usually set per run at launch. |
| `setup` | — | Optional argument list run in the root of each fresh worktree to install dependencies (e.g. `["npm", "ci"]`). Must be idempotent. |
| `linkDirs` | — | Optional ignored directories (e.g. `["node_modules"]`) symlinked from your checkout into each fresh worktree instead of running `setup`. |
| `verifyTimeoutMs` | `1800000` | Maximum duration (ms) for a `verify`, `goalCheck`, or `setup` command before `litter` terminates it and records a timeout. |
| `maxAttempts` | `3` | Maximum executor attempts per gate (`1`–`10`) before an execute run halts. |
| `maxRounds` | `4` | Maximum rounds (`1`–`10`) a design run executes before stopping for you. |
| `summaryModel` | `"haiku"` | Model used for the swarm browser's generated summary (`"off"` disables it). |
| `summaryEverySec` | `60` | Minimum interval in seconds (`>= 10`) between generated swarm summaries. |
| `repair` | `"auto"` | `"auto"` continues a failed fanout or halted execute run as a bounded repair swarm; `"off"` stops, keeps all state, and offers routes. |
| `repairRounds` | `3` | Maximum verified and independently judged repairs (`1`–`10`) a repair swarm may run before asking for more budget. |
| `repairAgents` | `6` | Maximum total workers and helpers (`1`–`50`) a repair swarm's nodes may spawn before asking for more budget. |
| `widen` | `"ask"` | Who may add files outside a gate's `Files` list during an execute run: `"ask"` (only you, via a dialog) or `"critic"` (the gate's critic may also accept required files, listed in the run summary). |
| `trailers` | — | Optional commit trailers (`Key: value`) appended to every commit `litter` creates. |
| `bandEndedMinutes` | `10` | Minutes (`0`–`1440`) an ended run remains visible in the status band above the prompt (`0` removes it immediately). |

## Development

```bash
cd plugins/litter
claude plugin validate --strict .
tests/unit/node_modules/.bin/tsc -p .            # type-check the mod (after `bun install` in tests/unit)
tests/unit/node_modules/.bin/tsc -p tests/unit   # type-check the unit specs
claude plugin test .                             # tier 1: the engine's plugin tests
(cd tests/unit && bun install && bun run test)   # tier 2: bun specs
sh tests/hooks/run.sh                            # tier 3: hook scripts (also SHELL_UNDER_TEST=dash)
sh tests/headless/run.sh                         # tier 4: live sessions; spends tokens, run by hand
```

To run Claude Code with your working copy of `litter` loaded, use `claude --plugin-dir plugins/litter`.

## Acknowledgements

- [Claude Code](https://code.claude.com) by Anthropic — the agent and workflow engine `litter` runs on.
- [Harness design for long-running application development](https://www.anthropic.com/engineering/harness-design-long-running-apps) — inspiration for the original swarm loop.
- [Geoffrey Huntley's Ralph Wiggum approach](https://ghuntley.com/ralph/) — foundational research for iterative coding-agent loops.
