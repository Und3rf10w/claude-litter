// The engine as the pure modules see it. Every module that touches files,
// processes, time or the store takes a `Ports` argument instead of `$`, so
// the same code runs inside the mod (enginePorts in register.tsx) and under
// bun in tier 2 (tests/unit/support/node-ports.ts), where git runs for real
// in scratch repos.
//
// Only register.tsx touches `$`: `claude plugin validate` follows `$` into a
// function declared in the same file, never across an import, so a module
// that took `$` would fail validation.
//
// Contract owner: phase 1a. Implementers use these; they don't change them.
// A port that's missing something is a contract change: say so in your report.

import type {
  AgentInfo,
  AgentStatus,
  CommandSpec,
  EngineInterface,
  ModelCompleteRequest,
  ModelCompleteResult,
  SessionMessage,
  SessionSendResult,
  ToolCallResult,
  ToolSpec,
} from 'claude-code'
import type { BoardView, DoctorPaneView, RulesPaneView, SwarmPaneView } from '../types/index'

/** What `$.agent.register` takes (the engine doesn't export the type's name). */
export type AgentSpec = Parameters<EngineInterface['agent']['register']>[0]

/** One row of `$.agent.list()` (the d.ts's AgentInfo; policy.ts has an AgentInfo of its own). */
export type ListedAgent = AgentInfo
export type { AgentStatus, CommandSpec, ModelCompleteRequest, ModelCompleteResult, SessionMessage, SessionSendResult, ToolCallResult }

/**
 * Whether a listed agent is still alive, so its place, its policy file and
 * its worktree stay: `running` a turn (or finalizing one), `waiting` (2.1.289:
 * mid-turn on foreground Agent calls alone, or ended but still holding a
 * background shell, monitor, child agent or workflow, which wakes it), or
 * `pending`, not started yet. `idle` is between turns (a teammate, or an ended
 * named agent; a litter node is never named), and the rest have ended.
 */
export const agentLive = (status: AgentStatus): boolean => status === 'running' || status === 'waiting' || status === 'pending'

/** The four subagent limits the health check reads (plan 15.7), each read with its name as a literal. */
export const SUBAGENT_LIMIT_NAMES = [
  'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH',
  'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS',
  'CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY',
  'CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION',
] as const
export type SubagentLimitName = (typeof SUBAGENT_LIMIT_NAMES)[number]
/** This process's values, raw: `undefined` when unset, never parsed here. */
export type SubagentLimits = Readonly<Record<SubagentLimitName, string | undefined>>

/** The settings sources the health check reads one by one (`$.settings.read({ source })`; `flag` isn't a file you edit). */
export type SettingsSourceName = 'user' | 'project' | 'local' | 'policy'

/** The panes' views in `$.state` (types/index.d.ts): N's swarm and doctor panes, phase 3's board and rules pane. */
export type PaneName = 'swarm' | 'doctor' | 'board' | 'rules'
export type { BoardView, DoctorPaneView, RulesPaneView, SwarmPaneView }
/** Any pane's view; each view's `view` field names its pane, and setView writes it to that pane's atom. */
export type PaneView = SwarmPaneView | DoctorPaneView | BoardView | RulesPaneView

export type RunInit = {
  cwd?: string
  env?: Record<string, string>
  stdin?: string
  /** Default 30 s, at most 10 minutes (the engine's limits). */
  timeoutMs?: number
}

export type RunResult = {
  /** The exit code. A process that can't start rejects instead. */
  code: number
  stdout: string
  stderr: string
  /** Either stream was cut at 4 MiB. Streamed work uses `spawn`. */
  truncated: boolean
}

export type SpawnRequest = {
  argv: readonly string[]
  cwd?: string
  env?: Record<string, string>
  input?: string
}

export type SpawnChunk = { stream: 'stdout' | 'stderr'; text: string }

/** `code` is null when a signal ended the child, and `signal` then names it. */
export type SpawnEnd = { code: number | null; signal: string | null }

/** Leaving the loop (break, return, throw) kills the child. */
export type SpawnStream = AsyncGenerator<SpawnChunk, SpawnEnd>

export type Stat = {
  kind: 'file' | 'dir' | 'other'
  size: number
  mtimeMs: number
  isLink: boolean
  /** Only with `{ resolve: true }`, and absent when the path leads nowhere. */
  realPath?: string
}

export type Entry = { name: string; kind: 'file' | 'dir' | 'other'; isLink: boolean }

export interface Ports {
  fs: {
    /** Rejects when missing or over 4 MiB. */
    read(path: string): Promise<string>
    /** Creates the file and its parent folders. Rejects over 4 MiB. Not atomic: see fsx.atomicWrite. */
    write(path: string, text: string): Promise<void>
    /** Rejects when the folder is missing. */
    list(path: string): Promise<Entry[]>
    exists(path: string): Promise<boolean>
    /** Rejects when missing. */
    stat(path: string, options?: { resolve?: boolean }): Promise<Stat>
  }
  /** Runs argv with no shell. Git runs with repo hooks off inside the mod. */
  run(argv: readonly string[], init?: RunInit): Promise<RunResult>
  spawn(request: SpawnRequest): SpawnStream
  /** Milliseconds since the epoch. Scripts can't read the clock; the mod can. */
  now(): Promise<number>
  /** Kept across sessions (the engine's `$.store`, 4 MiB in all). */
  store: {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    delete(key: string): Promise<void>
  }
  /** The current session id. It changes at /clear and when a session is backgrounded. */
  sessionId(): Promise<string>
  /** The session's working directory, absolute (`$.session.cwd()`). It moves with EnterWorktree. */
  cwd(): Promise<string>
  /** The plugin's own folder, absolute. */
  pluginRoot: string
  /**
   * `$.settings.read()`: the settings merged over every source, `--settings`
   * and managed policy included, as the engine runs under them. A snapshot.
   */
  settings(): Promise<Readonly<Record<string, unknown>>>
  /** One line in the debug log (`claude --debug`), prefixed `litter: `. */
  log(text: string): void
  /** `$.tool.register`: served as `mcp__litter__<name>`. Rejects when the engine refuses it. */
  registerTool(spec: ToolSpec): Promise<void>
  /** `$.agent.register`: served as `litter:<name>`. Rejects when the engine refuses it. */
  registerAgent(spec: AgentSpec): Promise<void>
  /** `$.clock.every`: `fn` runs every `ms` until `cancel()` or the module unloads. */
  every(ms: number, fn: () => void): { cancel(): void }
  /**
   * `$.ui.ask`: your answer, as the label chosen or the text typed under
   * "Other", so compare it with the labels exactly. Rejects when dismissed and
   * under `-p` or in an eval (no one to ask); a handler that needs an answer
   * refuses then.
   */
  ask(question: string, options: { options: readonly string[]; header?: string }): Promise<string>

  // Phase 2b, for swarms (plan 15.4; WP-C's port table).

  /** `$.agent.list()`: the session's agents so far, subagents and teammates, the model's and the plugins' alike. Liveness is `agentLive`. */
  listAgents(): Promise<ListedAgent[]>
  /**
   * `$.session.send({ to, text })`: `to` as SendMessage spells it (an agent id,
   * a name, a received `from` address). It goes through every litter hook but
   * the calling one, so the mod sends only from a `swarm_send` or `ui.message`
   * dispatch (COMMON, decision 2). Resolves once queued at the recipient.
   */
  send(to: string, text: string): Promise<SessionSendResult>
  /**
   * `$.session.append`: a user-role row of one text block in the lead's
   * conversation, which a busy lead reads in its current turn (spike 10).
   * Rejects with the reason when a hook refuses it (`{ deny }`).
   */
  appendUserRow(text: string): Promise<void>
  /**
   * `$.prompt.submit({ text })`: a lead turn of its own once the session is
   * idle. Resolves once that turn starts, so never await it inside a hook:
   * call it from a `p.after` or `p.every` callback, or a turn.complete (15.9,
   * item 19). Rejects with the host's text on a refusal (from a tool.call
   * hook) and on `{ drop }`.
   */
  submitPrompt(text: string): Promise<void>
  /** `$.prompt.fill({ text })`: the prompt box takes the text as your draft. False under a dialog or headless. */
  fillPrompt(text: string): Promise<boolean>
  /** `$.session.messages()`, or an agent's with its id. Null when the engine can't read that agent's (`{ deny }`). */
  messages(agentId?: string): Promise<SessionMessage[] | null>
  /** `$.model.complete`: one tool-less completion. Resolves the reply or why there's none; rejects only on a request the engine won't send. */
  complete(request: ModelCompleteRequest): Promise<ModelCompleteResult>
  /**
   * `$.tool.call({ tool, ...input })`: TaskStop for a hard stop. It runs
   * through every litter hook but the calling one. Rejects when no tool has
   * that name; refuses Agent, AskUserQuestion and Workflow (spike 7).
   */
  callTool(tool: string, input: Record<string, unknown>): Promise<ToolCallResult>
  /**
   * `$.clock.sleep(ms)`. The d.ts (2.1.288): unlike every other `$` call, the
   * wait is the hook's own time, so a hook that polls with it spends its 10 s
   * budget (WP-C's report). Poll in short steps under a cap well inside it.
   */
  sleep(ms: number): Promise<void>
  /** `$.clock.after`: `fn` runs once after `ms`, outside any hook's dispatch, unless cancelled first. */
  after(ms: number, fn: () => void): { cancel(): void }
  /** The four subagent limits from this process's environment, each read with its name as a literal. */
  limits(): Promise<SubagentLimits>
  /** `$.settings.read({ source })`: that one file as loaded. Null when it has nothing (the engine answers `{}` for a missing file). */
  settingsFrom(source: SettingsSourceName): Promise<Readonly<Record<string, unknown>> | null>
  /** `CLAUDE_CONFIG_DIR`, else `$HOME/.claude`: absolute. Rejects when neither is set, or the value isn't absolute. */
  configDir(): Promise<string>
  /** `$.command.register`: `/<name>`, served by a `command.run` hook on `{ command: name }`. Rejects when refused. */
  registerCommand(spec: CommandSpec): Promise<void>
  /** `$.ui.open({ id, title })`: whether the pane was placed (drawn). An open answering your command is placed at any width. */
  openPane(id: string, title: string): Promise<boolean>
  /** `$.ui.close({ id })`; an id that isn't open is left alone. */
  closePane(id: string): Promise<void>
  /** `$.ui.toast(text)`: a few seconds over the transcript's corner. */
  toast(text: string): void
  /** `$.ui.copy({ text })`: whether the clipboard took it. */
  copy(text: string): Promise<boolean>
  /** Writes a pane's view into `$.state` (the atoms in register.tsx); the write redraws the pane. */
  setView(pane: PaneName, view: PaneView | null): Promise<void>
}
