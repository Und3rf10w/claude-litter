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

import type { EngineInterface, ToolSpec } from 'claude-code'

/** What `$.agent.register` takes (the engine doesn't export the type's name). */
export type AgentSpec = Parameters<EngineInterface['agent']['register']>[0]

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
}
