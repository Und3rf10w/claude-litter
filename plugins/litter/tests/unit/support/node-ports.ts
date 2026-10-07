// Ports over node's fs and child_process, for tier-2 specs under bun: the same
// modules the mod runs, against real files and real git in a scratch folder.
// Matches the engine's limits where a module could come to depend on them
// (4 MiB reads and writes, a 30 s default run timeout, git with hooks off).

import { AsyncLocalStorage } from 'node:async_hooks'
import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join } from 'node:path'
import type { ToolSpec } from 'claude-code'
import type {
  AgentSpec,
  CommandSpec,
  Entry,
  ListedAgent,
  ModelCompleteRequest,
  ModelCompleteResult,
  PaneName,
  PaneView,
  Ports,
  RunInit,
  RunResult,
  SendTo,
  SessionMessage,
  SessionSendResult,
  SessionUsage,
  SettingsSourceName,
  SpawnChunk,
  SpawnEnd,
  SpawnRequest,
  Stat,
  SubagentLimitName,
  ToolCallResult,
} from '../../../hooks/ports'

const MAX_BYTES = 4 * 1024 * 1024

/**
 * One `after` timer: nothing runs until the spec calls `runAfters(p)`. `at`
 * is the clock when it was made (the fake clock's, or real time), so it's
 * due at `at + ms`.
 */
export type FakeAfter = { ms: number; at: number; fn: () => void; state: 'pending' | 'ran' | 'cancelled' }

/**
 * The host's refusal of `$.prompt.submit` from a hook that holds the turn
 * (2.1.288's text for tool.call): the real port is usable only from a timer
 * callback or turn.complete.
 */
export const SUBMIT_REFUSED =
  'prompt.submit: called from a tool.call hook, it would wait on the turn this hook is holding; submit from a later event (turn.complete)'

/** Set while a timer callback runs (runAfters, fireEvery), through its awaits. */
const inTimer = new AsyncLocalStorage<true>()

export type TestPorts = Ports & {
  /** Every line `log` got, in order. */
  logs: string[]
  /** The answers `ask` gives, in order; with none left it rejects, as under -p. */
  answers: string[]
  /** Every question `ask` got. */
  asked: { question: string; options: readonly string[] }[]
  /** The store, as a plain map. */
  storeMap: Map<string, unknown>
  /** Every `every` timer still running. */
  timers: Set<() => void>
  /** The fake clock's value, read by `now` (real time when null). */
  clock: { now: number | null }
  /** What `settings()` answers, the merged settings; a spec sets its keys. */
  settingsValue: Record<string, unknown>

  // Phase 2b, the swarm's ports (WP-C). Each records its calls; a spec sets each answer.

  /** What `listAgents` answers (a copy); a spec changes it between calls. */
  agents: ListedAgent[]
  /** Every `send`, in order, as the module called the port (before `sendHook`); `to` as given, a name or `{ agentId }`. */
  sent: { to: SendTo; text: string }[]
  /** Answers a send; unset, it's delivered. */
  sendAnswer?: (to: SendTo, text: string) => SessionSendResult | Promise<SessionSendResult>
  /**
   * The session.send hook a send goes through, as the real port goes through
   * litter's own (a spec sets it to call its admitSend). `deliver` is what's
   * beneath: `sendAnswer`, or delivered. Unset, a send is delivered as `sendAnswer` says.
   */
  sendHook?: (
    to: SendTo,
    text: string,
    deliver: (to: SendTo, text: string) => Promise<SessionSendResult>,
  ) => SessionSendResult | Promise<SessionSendResult>
  /** Every `appendUserRow` text, in order. */
  appended: string[]
  /**
   * Every `submitPrompt` text the host took, in order (recorded before
   * `submitAnswer` runs). As the real port, a submit outside a timer callback
   * (runAfters, fireEvery) rejects with SUBMIT_REFUSED and isn't recorded,
   * unless `submitAnywhere` is set.
   */
  submitted: string[]
  /** Answers a submit: return to resolve, throw to reject with the host's text. Unset, it resolves. */
  submitAnswer?: (text: string) => void | Promise<void>
  /** A submit is taken from anywhere: for a spec of a turn.complete hook, where the host takes one. */
  submitAnywhere: boolean
  /** Every `fillPrompt` text, in order. */
  filled: string[]
  /** Answers a fill; unset, the box takes it (true). */
  fillAnswer?: (text: string) => boolean
  /** What `messages` answers, by agentId, `main` for the lead's. An agent with none answers null (the engine's deny); the lead's, []. */
  transcripts: Record<string, SessionMessage[]>
  /** Every `complete` request, in order. */
  completions: ModelCompleteRequest[]
  /** Answers a completion; unset, it rejects ("no model in tier 2"). */
  completeAnswer?: (request: ModelCompleteRequest) => ModelCompleteResult | Promise<ModelCompleteResult>
  /** Every `callTool`, in order. */
  toolCalls: { tool: string; input: Record<string, unknown> }[]
  /** Answers a tool call; unset, it rejects ("no tool in tier 2"). */
  toolAnswer?: (tool: string, input: Record<string, unknown>) => ToolCallResult | Promise<ToolCallResult>
  /**
   * Every `sleep`'s ms, in order. A sleep advances `clock.now` by its ms when
   * the fake clock is set, calls `onSleep`, then resolves on the next
   * macrotask, so another hook's work runs in between. No real waiting.
   */
  sleeps: number[]
  onSleep?: (ms: number) => void
  /** Every `after`, in order: nothing runs until `runAfters(p)`. */
  afters: FakeAfter[]
  /** What `limits()` answers; unset names are undefined. */
  limitsValue: { [K in SubagentLimitName]: string | undefined }
  /** What `settingsFrom(source)` answers, by source; a source left out, or `{}` (the engine's answer for a missing file), answers null. */
  sourceSettings: Partial<Record<SettingsSourceName, Record<string, unknown>>>
  /** What `configDir()` answers; null (the default) rejects, so no spec reaches your own ~/.claude by accident. */
  configDirValue: string | null
  /** Every `registerCommand` spec, in order. */
  commands: CommandSpec[]
  /** Every `openPane` and `closePane`, in order. `openPane` answers true (placed); `focus` is there when the open asked for it (WP-DA). */
  panes: { opened: { id: string; title: string; focus?: true }[]; closed: string[] }
  /**
   * What `paneOpen(id)` answers (WP-DA). Null (the default): whether `id` was
   * opened and not closed since; `paneOpenThrows` makes it reject.
   */
  paneOpenValue: boolean | null
  paneOpenThrows: boolean
  toasts: string[]
  /** Every transcript row `note` wrote, in order (WP-CK). */
  notes: string[]
  copied: string[]
  /** The last view `setView` wrote, by pane. */
  views: Partial<Record<PaneName, PaneView | null>>
  /** Every `registerAgent` and `registerTool` spec, in order (a spec that replaces the method records nothing here). */
  registeredAgents: AgentSpec[]
  registeredTools: ToolSpec[]
  /** Answer a registration: throw to refuse it. Unset, it resolves. */
  registerAgentAnswer?: (spec: AgentSpec) => void | Promise<void>
  registerToolAnswer?: (spec: ToolSpec) => void | Promise<void>

  // Phase 5 (WP-CA). Each records its calls or answers what a spec set.

  /** Every `notice`, in order, `text` undefined for a removal. */
  notices: { toolUseId: string; text: string | undefined }[]
  /** What `notice` answers (true, the call was made); false as when `$.ui.notice` throws. */
  noticeAnswer: boolean
  /** What `toolNames` answers (a copy); empty by default, so TaskUpdate isn't there. */
  toolNamesValue: string[]
  /** What `envVar` answers, by name; a name left out is unset. */
  envValues: Partial<Record<'CLAUDE_CODE_TASK_LIST_ID', string>>

  // Phase 5b (WP-DH).

  /** What `usage` answers (a copy): no response yet, no limits, nothing spent, by default; null makes it reject. */
  usageValue: SessionUsage | null
}

/**
 * Runs the `after` timers pending now that are due, in due order (`at + ms`,
 * ties in the order made), awaiting each one's result (the engine doesn't; a
 * spec wants their effects settled). Due means by `clock.now` with the fake
 * clock set; with the real clock, every pending one. `{ all: true }` runs
 * every pending one, due or not, in the order made. Each runs as a timer
 * callback (submitPrompt takes it). Timers they make wait for the next call;
 * one an earlier callback cancelled doesn't run. Answers how many ran.
 */
export async function runAfters(p: TestPorts, opts: { all?: boolean } = {}): Promise<number> {
  const now = p.clock.now
  const pending = p.afters.filter(x => x.state === 'pending')
  const chosen = opts.all
    ? pending
    : pending
        .map((a, i) => ({ a, i }))
        .filter(({ a }) => now === null || a.at + a.ms <= now)
        .sort((x, y) => x.a.at + x.a.ms - (y.a.at + y.a.ms) || x.i - y.i)
        .map(({ a }) => a)
  let ran = 0
  for (const a of chosen) {
    if (a.state !== 'pending') continue
    a.state = 'ran'
    ran++
    await inTimer.run(true, async () => {
      await (a.fn() as unknown)
    })
  }
  return ran
}

/**
 * Fires every `every` timer once, as the engine's tick would, each as a timer
 * callback (submitPrompt takes it), awaiting each one's result. Answers how many ran.
 */
export async function fireEvery(p: TestPorts): Promise<number> {
  let ran = 0
  for (const fn of [...p.timers]) {
    ran++
    await inTimer.run(true, async () => {
      await (fn() as unknown)
    })
  }
  return ran
}

const kindOf = (s: { isFile(): boolean; isDirectory(): boolean }): Entry['kind'] =>
  s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other'

/** git with repo hooks off, as the engine runs it. */
function gitArgv(argv: readonly string[]): string[] {
  return argv[0] === 'git' ? ['git', '-c', 'core.hooksPath=/dev/null', ...argv.slice(1)] : [...argv]
}

/**
 * Every git run here ignores your global and system config and has a fixed
 * identity, so no spec depends on the machine it runs on. A spec's own env wins.
 */
export const HERMETIC_GIT_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'litter-test',
  GIT_AUTHOR_EMAIL: 'test@litter.invalid',
  GIT_COMMITTER_NAME: 'litter-test',
  GIT_COMMITTER_EMAIL: 'test@litter.invalid',
}

const envFor = (argv: readonly string[], env: Record<string, string> | undefined) => ({
  ...process.env,
  ...(argv[0] === 'git' ? HERMETIC_GIT_ENV : {}),
  ...env,
})

function runNode(argv: readonly string[], init: RunInit = {}): Promise<RunResult> {
  const full = gitArgv(argv)
  return new Promise((resolve, reject) => {
    const child = nodeSpawn(full[0]!, full.slice(1), {
      cwd: init.cwd,
      env: envFor(argv, init.env),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let truncated = false
    // One decoder per stream, so a character split across chunks survives.
    const outText = new StringDecoder('utf8')
    const errText = new StringDecoder('utf8')
    const take = (cur: string, text: string): string => {
      if (cur.length >= MAX_BYTES) {
        if (text !== '') truncated = true
        return cur
      }
      const next = cur + text
      if (next.length > MAX_BYTES) truncated = true
      return next.slice(0, MAX_BYTES)
    }
    child.stdout.on('data', (c: Buffer) => (stdout = take(stdout, outText.write(c))))
    child.stderr.on('data', (c: Buffer) => (stderr = take(stderr, errText.write(c))))
    child.stdout.on('end', () => (stdout = take(stdout, outText.end())))
    child.stderr.on('end', () => (stderr = take(stderr, errText.end())))
    // As the engine: a child past its time is killed and the call rejects; one ended by a signal reads as 1.
    let timedOut = false
    const ms = Math.min(init.timeoutMs ?? 30_000, 600_000)
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, ms)
    child.on('error', err => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', code => {
      clearTimeout(timer)
      if (timedOut) reject(new Error(`${full[0]} timed out after ${ms} ms`))
      else resolve({ code: code ?? 1, stdout, stderr, truncated })
    })
    child.stdin.end(init.stdin ?? '')
  })
}

/**
 * The stream is a hand-built iterator, not an `async function*`: a generator
 * can't run its `return()` while a `next()` is still pending, so a silent
 * child would live on until it wrote or exited. Here `return()` and `throw()`
 * kill the child at once and settle the pending `next()`.
 */
function spawnNode(request: SpawnRequest): AsyncGenerator<SpawnChunk, SpawnEnd> {
  const full = gitArgv(request.argv)
  const child = nodeSpawn(full[0]!, full.slice(1), {
    cwd: request.cwd,
    env: envFor(request.argv, request.env),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  type Item = SpawnChunk | { end: SpawnEnd } | { error: Error }
  type Result = IteratorResult<SpawnChunk, SpawnEnd>
  const queue: Item[] = []
  let waiting: { resolve: (r: Result) => void; reject: (e: unknown) => void } | null = null
  let finished: Result | null = null
  const kill = () => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  const pump = () => {
    if (!waiting || queue.length === 0) return
    const w = waiting
    waiting = null
    const item = queue.shift()!
    if ('error' in item) {
      finished = { done: true, value: { code: null, signal: null } }
      w.reject(item.error)
    } else if ('end' in item) {
      finished = { done: true, value: item.end }
      w.resolve(finished)
    } else w.resolve({ done: false, value: item })
  }
  const push = (item: Item) => {
    if (finished) return
    queue.push(item)
    pump()
  }
  const decoded = (stream: 'stdout' | 'stderr', source: NodeJS.ReadableStream) => {
    const decoder = new StringDecoder('utf8')
    source.on('data', (c: Buffer) => {
      const text = decoder.write(c)
      if (text !== '') push({ stream, text })
    })
    source.on('end', () => {
      const text = decoder.end()
      if (text !== '') push({ stream, text })
    })
  }
  decoded('stdout', child.stdout)
  decoded('stderr', child.stderr)
  child.on('error', err => push({ error: err }))
  child.on('close', (code, signal) => push({ end: { code, signal } }))
  child.stdin.end(request.input ?? '')
  const stop = (value: SpawnEnd): Result => {
    kill()
    const done: Result = { done: true, value }
    finished ??= done
    queue.length = 0
    if (waiting) {
      const w = waiting
      waiting = null
      w.resolve(done)
    }
    return done
  }
  const stream: AsyncGenerator<SpawnChunk, SpawnEnd> = {
    next: () =>
      finished
        ? Promise.resolve(finished)
        : new Promise<Result>((resolve, reject) => {
            waiting = { resolve, reject }
            pump()
          }),
    return: async value => stop((await value) ?? { code: null, signal: 'SIGKILL' }),
    throw: async err => {
      stop({ code: null, signal: 'SIGKILL' })
      throw err
    },
    [Symbol.asyncIterator]() {
      return stream
    },
    async [Symbol.asyncDispose]() {
      stop({ code: null, signal: 'SIGKILL' })
    },
  }
  return stream
}

/** Node ports. `root` is only the plugin root it reports. */
export function nodePorts(options: { pluginRoot?: string; sessionId?: string; cwd?: string } = {}): TestPorts {
  const storeMap = new Map<string, unknown>()
  const logs: string[] = []
  const timers = new Set<() => void>()
  const clock: { now: number | null } = { now: null }
  const answers: string[] = []
  const asked: { question: string; options: readonly string[] }[] = []
  const settingsValue: Record<string, unknown> = {}
  const clone = (v: unknown) => (v === undefined ? undefined : structuredClone(v))
  /** The panes open now: an open adds one, a close takes it away (paneOpen's default). */
  const openNow = new Set<string>()
  // The methods below read the fakes' fields through `p` when called, so a spec may set an answer at any time.
  const p: TestPorts = {
    fs: {
      read: async path => {
        const s = await stat(path)
        if (s.size > MAX_BYTES) throw new Error(`${path}: over 4 MiB`)
        return readFile(path, 'utf8')
      },
      write: async (path, text) => {
        if (Buffer.byteLength(text) > MAX_BYTES) throw new Error(`${path}: over 4 MiB`)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, text)
      },
      list: async path =>
        (await readdir(path, { withFileTypes: true })).map(d => ({
          name: d.name,
          kind: d.isSymbolicLink() ? 'other' : kindOf(d),
          isLink: d.isSymbolicLink(),
        })),
      exists: async path => existsSync(path),
      stat: async (path, opts) => {
        // The engine follows a link; one that leads nowhere is `other`, described by the link itself.
        const l = await lstat(path)
        const isLink = l.isSymbolicLink()
        const target = isLink ? await stat(path).catch(() => null) : l
        const s = target ?? l
        const out: Stat = { kind: target ? kindOf(target) : 'other', size: s.size, mtimeMs: s.mtimeMs, isLink }
        if (opts?.resolve) {
          const real = await realpath(path).catch(() => undefined)
          if (real !== undefined) out.realPath = real
        }
        return out
      },
    },
    run: runNode,
    spawn: spawnNode,
    now: async () => clock.now ?? Date.now(),
    store: {
      get: async key => clone(storeMap.get(key)),
      set: async (key, value) => void storeMap.set(key, clone(value)),
      delete: async key => void storeMap.delete(key),
    },
    sessionId: async () => options.sessionId ?? 'test-session',
    cwd: async () => options.cwd ?? process.cwd(),
    pluginRoot: options.pluginRoot ?? join(import.meta.dir, '..', '..', '..'),
    settings: async () => structuredClone(settingsValue),
    log: text => void logs.push(text),
    registerTool: async spec => {
      p.registeredTools.push(spec)
      await p.registerToolAnswer?.(spec)
    },
    registerAgent: async spec => {
      p.registeredAgents.push(spec)
      await p.registerAgentAnswer?.(spec)
    },
    every: (_ms, fn) => {
      timers.add(fn)
      return { cancel: () => void timers.delete(fn) }
    },
    ask: async (question, opts) => {
      asked.push({ question, options: opts.options })
      const answer = answers.shift()
      if (answer === undefined) throw new Error('no one to ask (as under -p)')
      return answer
    },
    logs,
    answers,
    asked,
    storeMap,
    timers,
    clock,
    settingsValue,

    // Phase 2b, the swarm's ports.
    listAgents: async () => structuredClone(p.agents),
    send: async (to, text) => {
      p.sent.push({ to: typeof to === 'string' ? to : { ...to }, text })
      const deliver = async (t: SendTo, x: string): Promise<SessionSendResult> => (p.sendAnswer ? p.sendAnswer(t, x) : { isDelivered: true })
      return p.sendHook ? p.sendHook(to, text, deliver) : deliver(to, text)
    },
    appendUserRow: async text => void p.appended.push(text),
    submitPrompt: async text => {
      if (!p.submitAnywhere && inTimer.getStore() !== true) throw new Error(SUBMIT_REFUSED)
      p.submitted.push(text)
      await p.submitAnswer?.(text)
    },
    fillPrompt: async text => {
      p.filled.push(text)
      return p.fillAnswer ? p.fillAnswer(text) : true
    },
    messages: async agentId => {
      const found = p.transcripts[agentId ?? 'main']
      if (found) return structuredClone(found)
      return agentId === undefined ? [] : null
    },
    complete: async request => {
      p.completions.push(request)
      if (!p.completeAnswer) throw new Error('no model in tier 2')
      return p.completeAnswer(request)
    },
    callTool: async (tool, input) => {
      p.toolCalls.push({ tool, input })
      if (!p.toolAnswer) throw new Error(`no tool in tier 2 (${tool})`)
      return p.toolAnswer(tool, input)
    },
    sleep: async ms => {
      p.sleeps.push(ms)
      if (p.clock.now !== null) p.clock.now += ms
      p.onSleep?.(ms)
      await new Promise<void>(resolve => setTimeout(resolve, 0))
    },
    after: (ms, fn) => {
      const a: FakeAfter = { ms, at: p.clock.now ?? Date.now(), fn, state: 'pending' }
      p.afters.push(a)
      return {
        cancel: () => {
          if (a.state === 'pending') a.state = 'cancelled'
        },
      }
    },
    limits: async () => ({ ...p.limitsValue }),
    settingsFrom: async source => {
      // As the real port: the engine answers {} for a missing file, read as null.
      const s = p.sourceSettings[source]
      return s === undefined || Object.keys(s).length === 0 ? null : structuredClone(s)
    },
    configDir: async () => {
      if (p.configDirValue === null) throw new Error('no config dir in tier 2 (set configDirValue)')
      return p.configDirValue
    },
    registerCommand: async spec => void p.commands.push(spec),
    openPane: async (id, title, focus) => {
      p.panes.opened.push(focus === true ? { id, title, focus: true } : { id, title })
      openNow.add(id)
      return true
    },
    paneOpen: async id => {
      if (p.paneOpenThrows) throw new Error('ui.panes failed in tier 2 (paneOpenThrows)')
      return p.paneOpenValue ?? openNow.has(id)
    },
    closePane: async id => {
      p.panes.closed.push(id)
      openNow.delete(id)
    },
    toast: text => void p.toasts.push(text),
    note: text => void p.notes.push(text),
    copy: async text => {
      p.copied.push(text)
      return true
    },
    setView: async (pane, view) => {
      p.views[pane] = view === null ? null : structuredClone(view)
    },
    notice: (toolUseId, text) => {
      p.notices.push({ toolUseId, text })
      return p.noticeAnswer
    },
    toolNames: async () => [...p.toolNamesValue],
    envVar: async name => p.envValues[name],
    usage: async () => {
      if (p.usageValue === null) throw new Error('no usage in tier 2 (usageValue is null)')
      return structuredClone(p.usageValue)
    },
    agents: [],
    sent: [],
    appended: [],
    submitted: [],
    submitAnywhere: false,
    filled: [],
    transcripts: {},
    completions: [],
    toolCalls: [],
    sleeps: [],
    afters: [],
    limitsValue: {
      CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH: undefined,
      CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS: undefined,
      CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY: undefined,
      CLAUDE_CODE_MAX_SUBAGENTS_PER_SESSION: undefined,
    },
    sourceSettings: {},
    configDirValue: null,
    commands: [],
    panes: { opened: [], closed: [] },
    paneOpenValue: null,
    paneOpenThrows: false,
    toasts: [],
    notes: [],
    copied: [],
    views: {},
    registeredAgents: [],
    registeredTools: [],
    notices: [],
    noticeAnswer: true,
    toolNamesValue: [],
    envValues: {},
    usageValue: { startedAt: 0, context: { window: 200_000 }, rateLimits: [], cost: { usd: 0 } },
  }
  return p
}

/** A scratch folder, removed by the returned cleanup. */
export function scratch(prefix = 'litter-'): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** A scratch git repo with one commit on `main`; `git` runs argv in it and throws on failure. */
export async function scratchRepo(p: Ports, dir: string): Promise<{ git: (...argv: string[]) => Promise<string> }> {
  const git = async (...argv: string[]): Promise<string> => {
    const r = await p.run(['git', ...argv], { cwd: dir })
    if (r.code !== 0) throw new Error(`git ${argv.join(' ')}: ${r.stderr.trim()}`)
    return r.stdout
  }
  await git('init', '-q', '-b', 'main')
  await p.fs.write(join(dir, 'README.md'), 'scratch\n')
  await git('add', 'README.md')
  await git('commit', '-q', '-m', 'init')
  return { git }
}
