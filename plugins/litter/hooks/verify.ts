// The `verify` record: snapshot, run the verify argv streamed, log in parts,
// keep the tail, enforce the timeout, snapshot again, record (plan section 9,
// "verify and land records"). Owner: phase 1b, work package C; a fanout's
// gate `integration`, in the integration worktree, phase 2b, package G.
//
// Also the run facts both records start from (run.json, the ledger's state),
// which land.ts imports.

import type { Ports, SpawnEnd } from './ports'
import type { Author, Caller, RecordCtx, RecordError, RecordHandler, StoredRecord } from './records/core'
import type { RunJson } from './records/run'
import type { VerifyBody, VerifyReply } from './records/execute'
import { fail } from './records/core'
import { RUN_ID, runDir as runDirOf, runJsonPath, verifyLogDir, verifyLogPart } from './layout'
import { mkdirp, randomId, readJson } from './fsx'
import { LedgerTampered, RecordTooLarge, appendRecord, readLedger } from './ledgercore'
import { snapshot } from './snapshot'
import { writeOut } from './output'
import { integrationWorktree } from './integrate'

// ---------------------------------------------------------------------------
// The run's facts, shared with land.ts.

/** A run as verify and land see it: run.json, checked, and where it lives. */
export type RunFacts = { run: string; runDir: string; json: RunJson }

export const OID = /^[0-9a-f]{40}([0-9a-f]{24})?$/
/** The run's branch (plan section 9, step 3): `refs/heads/litter/<run>`, a continuation's on its original's. */
const RUN_REF = /^refs\/heads\/litter\/[0-9]{8}-[a-z0-9][a-z0-9-]{0,62}$/

/** The gates every run may name besides its plan's: the baseline, a goal check, fanout's integration. */
export const FIXED_GATES: readonly string[] = ['baseline', 'goal', 'integration']
const GATE_ID = /^G[0-9]{1,4}$/

export const MOD: Author = { source: 'mod' }

export const authorFor = (caller: Caller): Author =>
  caller.agentId === null ? { source: 'launcher' } : { source: 'agent', agentId: caller.agentId, agentType: caller.agentType }

/** The agent a record speaks for: its author, or the `agent_id` the mod recorded it from (a spooled result). */
export function agentOf(rec: StoredRecord): string | null {
  if (rec.by.source === 'agent') return rec.by.agentId
  const id = rec.body.agent_id
  return rec.by.source === 'mod' && typeof id === 'string' ? id : null
}

/** `litter:gate-critic` → `gate-critic`. */
export const roleOf = (caller: Caller): string | null => caller.agentType?.replace(/^litter:/, '') ?? null

/**
 * Reads and checks run.json. The record tool found the run already; this
 * checks the facts a land and a verify act on, since git argv is built from
 * them (plan section 9, "Mod safety").
 */
export async function loadRun(ctx: RecordCtx, input: Record<string, unknown>): Promise<RunFacts | RecordError> {
  if (ctx.litterDir === null) {
    return fail("litter: this session has no litter directory (see /litter-doctor); start the run from the project's checkout")
  }
  const run = input.run
  if (typeof run !== 'string' || !RUN_ID.test(run)) return fail("litter: 'run' must be a run id like 20261002-my-run", 'run')
  return readRunFacts(ctx.p, runDirOf(ctx.litterDir, run), run)
}

export async function readRunFacts(p: Ports, runDir: string, run: string): Promise<RunFacts | RecordError> {
  let json: RunJson | undefined
  try {
    json = await readJson<RunJson>(p, runJsonPath(runDir))
  } catch (err) {
    return fail(`litter: run ${run}'s run.json doesn't parse (${message(err)})`, 'run')
  }
  if (json === undefined) return fail(`litter: no run '${run}' at ${runDir}`, 'run')
  const bad = runJsonProblem(json, run)
  if (bad) return fail(`litter: run ${run}'s run.json ${bad}; it's written by run.start, and no record call can fix it`, 'run')
  return { run, runDir, json }
}

function runJsonProblem(json: RunJson, run: string): string | null {
  if (json.v !== 1) return `has version ${String(json.v)}, not 1`
  if (json.run !== run) return `names run ${String(json.run)}`
  if (typeof json.base !== 'string' || !OID.test(json.base)) return 'has no valid base commit'
  if (typeof json.ref !== 'string' || !RUN_REF.test(json.ref)) return 'has no valid ref'
  if (typeof json.checkout !== 'string' || !json.checkout.startsWith('/')) return 'has no absolute checkout'
  return null
}

/** Why the run takes no more records: its latest lifecycle record is a stop or an end (plan section 9, "Run lifecycle"). */
export function runClosed(records: readonly StoredRecord[]): string | null {
  for (let i = records.length - 1; i >= 0; i--) {
    const kind = records[i]!.kind
    if (kind === 'run.end') return 'has ended'
    if (kind === 'run.stopping') return 'is stopping'
    if (kind === 'run.launch' || kind === 'run.resume') return null
  }
  return null
}

/** The plan's gate ids from the stored args, or null when the args carry none (then any `G<n>` is taken). */
export function planGates(json: RunJson): { id: string; title?: string; lines?: string }[] | null {
  const gates = json.args?.gates
  if (!Array.isArray(gates)) return null
  const out: { id: string; title?: string; lines?: string }[] = []
  for (const g of gates) {
    if (g === null || typeof g !== 'object' || typeof (g as { id?: unknown }).id !== 'string') continue
    const { id, title, lines } = g as { id: string; title?: unknown; lines?: unknown }
    const entry: { id: string; title?: string; lines?: string } = { id }
    if (typeof title === 'string') entry.title = title
    const range = linesOf(lines)
    if (range) entry.lines = range
    out.push(entry)
  }
  return out
}

/** A gate's line range as `12-30`, from `{ start, end }` (gates.ts) or a string. */
function linesOf(v: unknown): string | null {
  if (typeof v === 'string' && /^[0-9]+(-[0-9]+)?$/.test(v)) return v
  if (v !== null && typeof v === 'object') {
    const { start, end } = v as { start?: unknown; end?: unknown }
    if (Number.isInteger(start) && Number.isInteger(end)) return `${start}-${end}`
  }
  return null
}

/**
 * One of the plan's gates: listed in the stored args, or any `G<n>` when they
 * list none. A gate id is also a folder name (verify/<verify_id>/), so it's
 * held to a safe spelling either way.
 */
export function isPlanGate(json: RunJson, gate: string): boolean {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(gate) || FIXED_GATES.includes(gate)) return false
  const gates = planGates(json)
  return gates ? gates.some(g => g.id === gate) : GATE_ID.test(gate)
}

/** The ids a gate field may take, for the error's `allowed`. */
export const gateIds = (json: RunJson): string[] => (planGates(json) ?? []).map(g => g.id)

/** Writes the observed fields for the caller's StructuredOutput. A failure is logged: output.sh then denies, and the agent records again. */
export async function observe(ctx: RecordCtx, forWhat: { verify_id?: string; land_of?: string }, fields: Record<string, unknown>): Promise<void> {
  const agentId = ctx.caller.agentId
  if (agentId === null || ctx.litterDir === null) return
  try {
    await writeOut(ctx.p, ctx.litterDir, { v: 1, agent_id: agentId, for: forWhat, fields })
  } catch (err) {
    ctx.p.log(`out file for ${agentId} not written: ${message(err)}`)
  }
}

export const message = (err: unknown): string => (err instanceof Error ? err.message : String(err))

/** A ledger error as the record tool's answer. Anything else rejects, for the dispatcher's catch. */
export function ledgerFailure(err: unknown): RecordError {
  if (err instanceof LedgerTampered) return fail(`litter: the run's ledger is tampered (${err.message}); nothing more is recorded for it`, 'run')
  if (err instanceof RecordTooLarge) return fail(`litter: ${err.message}`, err.field ?? undefined)
  throw err
}

// ---------------------------------------------------------------------------
// Output: the log parts and the tail (plan section 9, "Run: always streamed").

export const PART_BYTES = 1024 * 1024
export const TAIL_LINES = 200
export const TAIL_BYTES = 64 * 1024
/** How long a killed child gets to end before the after-snapshot is taken anyway. */
const KILL_GRACE_MS = 5_000

/** UTF-8 length without encoding: what $.fs.write counts. */
export function utf8Length(s: string, from = 0, to = s.length): number {
  let n = 0
  for (let i = from; i < to; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < to) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

/** The index where the longest prefix of `s` within `max` bytes ends, never inside a surrogate pair. */
function prefixEnd(s: string, max: number): number {
  let n = 0
  let i = 0
  while (i < s.length) {
    const c = s.charCodeAt(i)
    const pair = c >= 0xd800 && c <= 0xdbff && i + 1 < s.length
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3
    if (n + w > max) break
    n += w
    i += pair ? 2 : 1
  }
  return i
}

/** The index where the longest suffix of `s` within `max` bytes starts, never inside a surrogate pair. */
function suffixStart(s: string, max: number): number {
  let n = 0
  let i = s.length
  while (i > 0) {
    const c = s.charCodeAt(i - 1)
    const pair = c >= 0xdc00 && c <= 0xdfff && i - 2 >= 0 && s.charCodeAt(i - 2) >= 0xd800 && s.charCodeAt(i - 2) <= 0xdbff
    const w = c < 0x80 ? 1 : c < 0x800 ? 2 : pair ? 4 : 3
    if (n + w > max) break
    n += w
    i -= pair ? 2 : 1
  }
  return i
}

/** The last `n` lines of `s` (a final newline ends the last line, it doesn't start another). */
export function lastLines(s: string, n: number): string {
  let from = s.endsWith('\n') ? s.length - 2 : s.length - 1
  for (let k = 0; k < n; k++) {
    if (from < 0) return s
    const j = s.lastIndexOf('\n', from)
    if (j < 0) return s
    if (k === n - 1) return s.slice(j + 1)
    from = j - 1
  }
  return s
}

/** The last 200 lines across both streams, cut to the last 64 KiB. */
export function cutTail(s: string): string {
  const lines = lastLines(s, TAIL_LINES)
  return lines.slice(suffixStart(lines, TAIL_BYTES))
}

/**
 * Keeps the end of the output in memory. The window holds at least the last
 * 64 KiB (each UTF-16 unit is at least one byte), and the last 200 lines of
 * the window, cut to 64 KiB, are the last 200 lines of the whole output, cut.
 */
class Tail {
  private s = ''
  add(text: string): void {
    this.s += text
    if (this.s.length > 2 * TAIL_BYTES) this.s = this.s.slice(this.s.length - TAIL_BYTES - 1)
  }
  value(): string {
    return cutTail(this.s)
  }
}

/** The output in numbered parts of at most 1 MiB, both streams interleaved as they arrived. */
class Log {
  parts = 0
  bytes = 0
  private buf = ''
  private bufBytes = 0
  constructor(
    private readonly p: Ports,
    private readonly runDir: string,
    private readonly verifyId: string,
  ) {}

  async add(text: string): Promise<void> {
    let rest = text
    while (rest !== '') {
      const n = utf8Length(rest)
      if (this.bufBytes + n <= PART_BYTES) {
        this.buf += rest
        this.bufBytes += n
        return
      }
      const cut = prefixEnd(rest, PART_BYTES - this.bufBytes)
      this.buf += rest.slice(0, cut)
      this.bufBytes += utf8Length(rest, 0, cut)
      rest = rest.slice(cut)
      await this.flush()
    }
  }

  async close(): Promise<void> {
    if (this.bufBytes > 0) await this.flush()
  }

  private async flush(): Promise<void> {
    this.parts++
    await this.p.fs.write(verifyLogPart(this.runDir, this.verifyId, this.parts), this.buf)
    this.bytes += this.bufBytes
    this.buf = ''
    this.bufBytes = 0
  }
}

// ---------------------------------------------------------------------------
// The run itself.

/** The verifies in flight, per run, so a stop can end them (plan section 9, "Run lifecycle": TaskStop). */
const inflight = new Map<string, Set<() => void>>()

/** Ends every verify in flight for `run`: each leaves its read loop, which kills its child, and records nothing. */
export function endVerifies(run: string): number {
  const ends = inflight.get(run)
  if (!ends) return 0
  for (const end of ends) end()
  return ends.size
}

/** How many verifies are in flight for `run` (a stop settles only once there are none). */
export const verifiesInFlight = (run: string): number => inflight.get(run)?.size ?? 0

type Ran = {
  end: SpawnEnd
  timedOut: boolean
  ended: boolean
  spawnError: string | null
  tail: string
  parts: number
  bytes: number
}

/** A promise and the function that settles it. */
function signal<T>(value: T): { promise: Promise<T>; fire: () => void } {
  let fire!: () => void
  const promise = new Promise<T>(resolve => (fire = () => resolve(value)))
  return { promise, fire }
}

/** A timer through the ports, so the engine's clock runs it (and a test fires it). */
function after(p: Ports, ms: number): { promise: Promise<'timeout'>; cancel: () => void } {
  const s = signal<'timeout'>('timeout')
  const t = p.every(Math.max(1, ms), () => {
    t.cancel()
    s.fire()
  })
  return { promise: s.promise, cancel: () => t.cancel() }
}

/**
 * Runs the argv with `$.process.spawn` in the checkout, streaming its output
 * into the log parts and the tail. `$.process.spawn` has no timeout of its own,
 * so the mod leaves the read loop at `timeoutMs`, which kills the child.
 */
async function runStreamed(p: Ports, argv: readonly string[], cwd: string, runDir: string, verifyId: string, timeoutMs: number, stop: Promise<'ended'>): Promise<Ran> {
  const log = new Log(p, runDir, verifyId)
  const tail = new Tail()
  const clock = after(p, timeoutMs)
  const stream = p.spawn({ argv, cwd })
  let end: SpawnEnd = { code: null, signal: null }
  let timedOut = false
  let ended = false
  let spawnError: string | null = null
  let pending = stream.next()
  try {
    for (;;) {
      const r = await Promise.race([pending, clock.promise, stop])
      if (r === 'timeout') {
        timedOut = true
        break
      }
      if (r === 'ended') {
        ended = true
        break
      }
      if (r.done) {
        end = r.value
        break
      }
      tail.add(r.value.text)
      await log.add(r.value.text)
      pending = stream.next()
    }
  } catch (err) {
    // It couldn't start (the first pull rejects), or the stream or a log write
    // broke: never green, and the child, if any, is killed.
    spawnError = message(err)
    void stream.return({ code: null, signal: null }).catch(() => undefined)
    const note = `litter: the verify command failed to run: ${spawnError}\n`
    tail.add(note)
    await log.add(note)
  } finally {
    clock.cancel()
  }
  if (timedOut || ended) {
    // Leaving the loop kills the child. A pull still pending may bring its end
    // (the signal); the snapshot after waits for the child, within a grace.
    pending.then(
      r => {
        if (r.done) end = r.value
      },
      () => {},
    )
    const grace = after(p, KILL_GRACE_MS)
    await Promise.race([stream.return({ code: null, signal: null }).catch(() => undefined), grace.promise])
    grace.cancel()
    end = { code: null, signal: end.signal }
  }
  await log.close()
  return { end, timedOut, ended, spawnError, tail: tail.value(), parts: log.parts, bytes: log.bytes }
}

/** How a verify ended, as feedback and halts say it (plan section 9, "Record"). */
export function howEnded(v: Pick<VerifyBody, 'exit_code' | 'signal' | 'timed_out' | 'spawn_error'>): string {
  if (v.spawn_error !== null) return `failed to run (${v.spawn_error})`
  if (v.timed_out) return 'timed out'
  if (v.exit_code === null) return `killed by ${v.signal ?? 'a signal'}`
  return `exit ${v.exit_code}`
}

/** Green: exit 0, not timed out, the tree unchanged, no dirty submodules (plan section 9, "Record"). */
export const isGreen = (v: VerifyBody): boolean =>
  v.exit_code === 0 && !v.timed_out && v.spawn_error === null && v.tree_before === v.tree_after && v.dirty_submodules.length === 0

/** Why a verify isn't green, in the record's own terms. */
export function notGreen(v: VerifyBody): string {
  const why = [howEnded(v)]
  if (v.tree_before !== v.tree_after) why.push('the tree changed during the run')
  if (v.dirty_submodules.length > 0) why.push(`submodules with uncommitted changes: ${v.dirty_submodules.join(', ')}`)
  return why.join('; ')
}

/**
 * The observed fields for the caller's StructuredOutput, already in its
 * role's schema (plan section 9, "Observed facts beat claimed ones"): a
 * relay's VERIFIED, or the critic's tests_green (prompts: "When the mod
 * overwrites tests_green"). Null for a role whose result carries none.
 */
export function verifyFields(role: string | null, v: VerifyBody): Record<string, unknown> | null {
  if (role === 'relay') {
    return { verify_id: v.verify_id, exit_code: v.exit_code, signal: v.signal, timed_out: v.timed_out, green: v.green }
  }
  if (role === 'gate-critic') {
    const tests_green = v.green
      ? { pass: true, evidence: `verify ${v.verify_id} exit 0 on tree ${v.tree_after}`, gaps: [] }
      : { pass: false, evidence: `verify ${v.verify_id} ${notGreen(v)}: ${v.output_tail}`, gaps: [] }
    return { verify_id: v.verify_id, tests_green }
  }
  // A fanout verifier's FANOUT_CHECK carries no observed field, but output.sh
  // still checks its verify_id against the out file's, as the gate critic's.
  if (role === 'verifier') return {}
  return null
}

/**
 * Where a verify runs: the run's checkout, or for a fanout's gate
 * `integration` the integration worktree from its `worktree.create` record,
 * chosen by the mod, never a path from the call (plan section 7, fanout.js step 4).
 */
function verifyTarget(f: RunFacts, gate: string, records: readonly StoredRecord[]): { ok: true; where: string } | RecordError {
  if (f.json.workflow !== 'fanout' || gate !== 'integration') return { ok: true, where: f.json.checkout }
  const wt = integrationWorktree(records, f.run)
  if (!wt) return fail(`litter: run ${f.run} has no integration worktree yet, so there's nothing to verify for gate integration; record integrate first`, 'gate')
  return { ok: true, where: wt.path }
}

/** `mcp__litter__record({ kind: 'verify', run, gate, attempt })`. */
export const recordVerify: RecordHandler = async (ctx, input) => {
  const facts = await loadRun(ctx, input)
  if ('ok' in facts) return facts
  const { p } = ctx
  const { json, run, runDir } = facts

  const allowed = [...FIXED_GATES, ...gateIds(json)]
  const gate = input.gate
  if (typeof gate !== 'string' || gate === '') {
    return fail("litter: 'gate' must name the gate this verify is for: baseline, goal, integration or a gate id from the plan", 'gate', allowed)
  }
  if (!FIXED_GATES.includes(gate) && !isPlanGate(json, gate)) return fail(`litter: run ${run} has no gate '${gate}'`, 'gate', allowed)
  const fixedAttempt = gate === 'baseline' || gate === 'goal'
  const attempt = input.attempt ?? (fixedAttempt ? 1 : undefined)
  if (typeof attempt !== 'number' || !Number.isInteger(attempt) || attempt < 1) {
    return fail("litter: 'attempt' must be the attempt number from your instruction, a whole number from 1", 'attempt')
  }

  // The stored argv, never text from the call or the args (plan section 9, "Mod safety").
  const argv = gate === 'goal' ? json.goalCheck : json.verify
  if (!Array.isArray(argv) || argv.length === 0 || !argv.every(a => typeof a === 'string')) {
    return gate === 'goal'
      ? fail(`litter: run ${run} has no goal check; a verify for gate 'goal' runs only the approved goal-check argv`, 'gate', allowed.filter(g => g !== 'goal'))
      : fail(`litter: run ${run} has no verify argv in run.json; set the verify option and start a new run`, 'run')
  }

  const ledger = await readLedger(p, runDir, run)
  if (ledger.tampered) return ledgerFailure(new LedgerTampered(ledger.tampered.seq, ledger.tampered.reason))
  const closed = runClosed(ledger.records)
  if (closed) return fail(`litter: run ${run} ${closed}; it takes no more verifies`, 'run')
  const target = verifyTarget(facts, gate, ledger.records)
  if (!target.ok) return target
  const where = target.where

  const verifyId = `${gate}-${attempt}-${randomId().replace(/-/g, '').slice(0, 10)}`
  const ends = inflight.get(run) ?? new Set<() => void>()
  inflight.set(run, ends)
  const stop = signal<'ended'>('ended')
  ends.add(stop.fire)
  let ran: Ran
  let before: Awaited<ReturnType<typeof snapshot>>
  let afterSnap: Awaited<ReturnType<typeof snapshot>>
  try {
    try {
      before = await snapshot(p, where)
    } catch (err) {
      return fail(`litter: the snapshot before the verify failed: ${message(err)}`)
    }
    await mkdirp(p, verifyLogDir(runDir, verifyId))
    ran = await runStreamed(p, argv, where, runDir, verifyId, ctx.options.verifyTimeoutMs, stop.promise)
    if (ran.ended) return fail(`litter: run ${run} is stopping; verify ${verifyId} was ended and isn't recorded`, 'run')
    try {
      afterSnap = await snapshot(p, where)
    } catch (err) {
      return fail(`litter: the snapshot after verify ${verifyId} failed, so it isn't recorded: ${message(err)}`)
    }
  } finally {
    ends.delete(stop.fire)
    if (ends.size === 0) inflight.delete(run)
  }

  const body: VerifyBody = {
    verify_id: verifyId,
    gate,
    attempt,
    argv: [...argv],
    tree_before: before.tree,
    tree_after: afterSnap.tree,
    // Either snapshot's: a submodule dirty before the run or after it.
    dirty_submodules: [...new Set([...before.dirty_submodules, ...afterSnap.dirty_submodules])].sort(),
    exit_code: ran.timedOut ? null : ran.end.code,
    signal: ran.end.signal,
    timed_out: ran.timedOut,
    spawn_error: ran.spawnError,
    green: false,
    log_parts: ran.parts,
    log_bytes: ran.bytes,
    output_tail: ran.tail,
  }
  body.green = isGreen(body)
  try {
    await appendRecord(p, runDir, { run, kind: 'verify', by: authorFor(ctx.caller), body })
  } catch (err) {
    return ledgerFailure(err)
  }

  const fields = verifyFields(roleOf(ctx.caller), body)
  if (fields) await observe(ctx, { verify_id: verifyId }, fields)

  const reply: VerifyReply = {
    ok: true,
    verify_id: verifyId,
    exit_code: body.exit_code,
    signal: body.signal,
    timed_out: body.timed_out,
    green: body.green,
    tree: body.tree_before,
    tree_changed: body.tree_before !== body.tree_after,
    dirty_submodules: body.dirty_submodules,
    spawn_error: body.spawn_error,
    log: verifyLogDir(runDir, verifyId),
    output_tail: body.output_tail,
  }
  return reply
}

/** A record's body as a verify's, when it is one. */
export function verifyBody(rec: StoredRecord): VerifyBody | null {
  if (rec.kind !== 'verify') return null
  const b = rec.body as Partial<VerifyBody>
  return typeof b.verify_id === 'string' && typeof b.gate === 'string' && typeof b.tree_after === 'string' ? (b as VerifyBody) : null
}

