// Ports over node's fs and child_process, for tier-2 specs under bun: the same
// modules the mod runs, against real files and real git in a scratch folder.
// Matches the engine's limits where a module could come to depend on them
// (4 MiB reads and writes, a 30 s default run timeout, git with hooks off).

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { lstat, mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { StringDecoder } from 'node:string_decoder'
import { dirname, join } from 'node:path'
import type { Entry, Ports, RunInit, RunResult, SpawnChunk, SpawnEnd, SpawnRequest, Stat } from '../../../hooks/ports'

const MAX_BYTES = 4 * 1024 * 1024

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
  const clone = (v: unknown) => (v === undefined ? undefined : structuredClone(v))
  return {
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
    log: text => void logs.push(text),
    registerTool: async () => {},
    registerAgent: async () => {},
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
  }
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
