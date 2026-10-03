// Tier 2: the verify record against real processes and real git (plan section
// 9, "verify and land records": "Run: always streamed" and "Record"; section 12).

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  PART_BYTES,
  TAIL_BYTES,
  TAIL_LINES,
  cutTail,
  endVerifies,
  howEnded,
  lastLines,
  recordVerify,
  utf8Length,
  verifiesInFlight,
  verifyFields,
} from '../../hooks/verify'
import { appendRecord, headKey, readLedger } from '../../hooks/ledgercore'
import { normalizeOptions } from '../../hooks/options'
import { verifyLogDir } from '../../hooks/layout'
import type { Caller, RecordCtx, RecordError } from '../../hooks/records/core'
import type { RunJson } from '../../hooks/records/run'
import type { VerifyBody, VerifyReply } from '../../hooks/records/execute'
import type { WorktreeCreateBody } from '../../hooks/records/fanout'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

const RUN = '20261002-verify'
const CRITIC: Caller = { agentId: 'critic-1', agentType: 'litter:gate-critic' }
const RELAY: Caller = { agentId: 'relay-1', agentType: 'litter:relay' }

// Real processes and real git, slow on a busy machine.
setDefaultTimeout(120_000)

let p: TestPorts
let dir: string
let outside: string
let litterDir: string
let runDir: string
let base: string
let git: (...argv: string[]) => Promise<string>
let cleanups: (() => void)[]

beforeEach(async () => {
  p = nodePorts()
  const repo = scratch()
  const out = scratch()
  dir = repo.dir
  outside = out.dir
  cleanups = [repo.cleanup, out.cleanup]
  ;({ git } = await scratchRepo(p, dir))
  base = (await git('rev-parse', 'HEAD')).trim()
  await git('switch', '-q', '-c', `litter/${RUN}`)
  litterDir = join(outside, '.claude', 'litter')
  runDir = join(litterDir, RUN)
  await writeRun()
})
afterEach(() => cleanups.forEach(c => c()))

async function writeRun(patch: Partial<RunJson> = {}): Promise<void> {
  const json: RunJson = {
    v: 1,
    run: RUN,
    workflow: 'execute',
    args: { gates: [{ id: 'G1', title: 'Add a', lines: { start: 3, end: 9 } }], planPath: join(runDir, 'plan.md') },
    authorized: [],
    mode: 'auto',
    verify: ['true'],
    goalCheck: null,
    setup: null,
    base,
    ref: `refs/heads/litter/${RUN}`,
    checkout: dir,
    previousBranch: 'main',
    continueOf: null,
    amendOf: null,
    rules: [],
    planSha256: null,
    linkDirs: [],
    isolate: false,
    planPath: null,
    session: 'test-session',
    created: 0,
    ...patch,
  }
  await p.fs.write(join(runDir, 'run.json'), JSON.stringify(json))
}

const ctx = (caller: Caller = CRITIC, options: Record<string, unknown> = {}): RecordCtx => ({
  p,
  caller,
  litterDir,
  options: normalizeOptions(options),
})

async function verify(argv: string[], input: Record<string, unknown> = {}, caller: Caller = CRITIC, options: Record<string, unknown> = {}) {
  await writeRun({ verify: argv })
  return recordVerify(ctx(caller, options), { kind: 'verify', run: RUN, gate: 'G1', attempt: 1, ...input })
}

const ok = (r: unknown): VerifyReply => {
  expect((r as { ok: boolean }).ok).toBe(true)
  return r as VerifyReply
}
const err = (r: unknown): RecordError => {
  expect((r as { ok: boolean }).ok).toBe(false)
  return r as RecordError
}
const records = async () => (await readLedger(p, runDir, RUN)).records
const lastVerify = async (): Promise<VerifyBody> => (await records()).filter(r => r.kind === 'verify').at(-1)!.body as VerifyBody
const headTree = async () => (await git('rev-parse', 'HEAD^{tree}')).trim()
const parts = (verifyId: string) => readdirSync(verifyLogDir(runDir, verifyId)).sort()
const partText = (verifyId: string, name: string) => readFileSync(join(verifyLogDir(runDir, verifyId), name), 'utf8')

/**
 * node-ports never fires a timer by itself. This fires every timer, repeatedly,
 * until `work` settles: the timeout, then the kill grace.
 */
function fireTimers(work: Promise<unknown>, startAfter: () => Promise<void>): void {
  let done = false
  void work.finally(() => (done = true))
  void (async () => {
    await startAfter()
    while (!done) {
      for (const fn of [...p.timers]) fn()
      await Bun.sleep(20)
    }
  })()
}

/** Fires the timers running now, once: the verify's timeout, and not the grace it starts after. */
async function fireOnce(startAfter: () => Promise<void>): Promise<void> {
  await startAfter()
  for (const fn of [...p.timers]) fn()
}

/**
 * A spawn that yields exactly these pieces, then exits 0: node's pipes cut
 * multi-byte characters apart, which the engine never does (d.ts
 * ProcessSpawnChunk), so a test of the part boundaries scripts the pieces.
 */
function scriptedSpawn(pieces: string[]): void {
  p.spawn = async function* () {
    for (const text of pieces) yield { stream: 'stdout' as const, text }
    return { code: 0, signal: null }
  }
}

async function until(test: () => boolean, ms = 10_000): Promise<void> {
  const end = Date.now() + ms
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out waiting')
    await Bun.sleep(10)
  }
}

describe('verify: how it ended', () => {
  test('exit 0 on an unchanged tree is green; both streams are in the log and the tail', async () => {
    const r = ok(await verify(['sh', '-c', 'echo out-line; echo err-line >&2']))
    expect(r).toMatchObject({ exit_code: 0, signal: null, timed_out: false, green: true, tree_changed: false, spawn_error: null })
    expect(r.tree).toBe(await headTree())
    expect(r.log).toBe(verifyLogDir(runDir, r.verify_id))
    expect(r.output_tail).toContain('out-line\n')
    expect(r.output_tail).toContain('err-line\n')
    expect(parts(r.verify_id)).toEqual(['0001.log'])
    const body = await lastVerify()
    expect(body).toMatchObject({ verify_id: r.verify_id, gate: 'G1', attempt: 1, argv: ['sh', '-c', 'echo out-line; echo err-line >&2'], green: true, log_parts: 1 })
    expect(body.log_bytes).toBe(utf8Length(partText(r.verify_id, '0001.log')))
    const rec = (await records()).at(-1)!
    expect(rec.kind).toBe('verify')
    expect(rec.by).toEqual({ source: 'agent', agentId: 'critic-1', agentType: 'litter:gate-critic' })
  })

  test('a non-zero exit is red', async () => {
    const r = ok(await verify(['sh', '-c', 'echo failing; exit 3']))
    expect(r).toMatchObject({ exit_code: 3, signal: null, timed_out: false, green: false })
    expect(howEnded(await lastVerify())).toBe('exit 3')
  })

  test('a signal records exit_code null with the signal, and is never green', async () => {
    const r = ok(await verify(['sh', '-c', 'kill -TERM $$']))
    expect(r).toMatchObject({ exit_code: null, signal: 'SIGTERM', timed_out: false, green: false })
    expect(howEnded(await lastVerify())).toBe('killed by SIGTERM')
  })

  test('a run past verifyTimeoutMs is timed out, exit_code null, never green', async () => {
    // A silent child: node-ports can't kill it while a pull is pending, so the kill grace ends the wait.
    const started = Date.now()
    // The child would sleep 30 s; well under that means the timeout ended it, even on a loaded machine.
    const work = verify(['sleep', '30'], {}, CRITIC, { verifyTimeoutMs: 1000 })
    fireTimers(work, () => Bun.sleep(300))
    const r = ok(await work)
    expect(r).toMatchObject({ exit_code: null, timed_out: true, green: false })
    expect(Date.now() - started).toBeLessThan(20_000)
    expect(howEnded(await lastVerify())).toBe('timed out')
  })

  test('the timeout leaves the read loop, which kills the child', async () => {
    const ticks = join(outside, 'ticks')
    const work = verify(['sh', '-c', `while :; do echo tick; echo t >> '${ticks}'; sleep 0.05; done`], {}, CRITIC, { verifyTimeoutMs: 1000 })
    await fireOnce(() => until(() => existsSync(ticks) && statSync(ticks).size > 6))
    const r = ok(await work)
    expect(r).toMatchObject({ timed_out: true, green: false, exit_code: null })
    expect(r.output_tail).toContain('tick\n')
    const size = statSync(ticks).size
    await Bun.sleep(300)
    expect(statSync(ticks).size).toBe(size)
  })

  test('a tree changed during the run is never green, whatever the exit code', async () => {
    const r = ok(await verify(['sh', '-c', 'echo more >> README.md']))
    expect(r).toMatchObject({ exit_code: 0, green: false, tree_changed: true })
    const body = await lastVerify()
    expect(body.tree_before).toBe(await headTree())
    expect(body.tree_after).not.toBe(body.tree_before)
  })

  test("a command that can't start is recorded red, with why", async () => {
    const r = ok(await verify(['/nonexistent/litter-verify']))
    expect(r.green).toBe(false)
    expect(r.exit_code).toBeNull()
    expect(r.spawn_error).toMatch(/ENOENT|not found|no such/i)
    expect(r.output_tail).toContain('failed to run')
    expect(howEnded(await lastVerify())).toMatch(/^failed to run/)
  })

  test('the tree is the working tree as it is, uncommitted and untracked files included', async () => {
    writeFileSync(join(dir, 'new.ts'), 'export {}\n')
    const r = ok(await verify(['true']))
    expect(r.green).toBe(true)
    expect(r.tree).not.toBe(await headTree())
    expect(await git('ls-tree', '--name-only', r.tree)).toContain('new.ts')
  })
})

describe('verify: dirty submodules', () => {
  test('a submodule with uncommitted changes makes exit 0 red, and the record lists it', async () => {
    const { dir: subDir, cleanup } = scratch()
    cleanups.push(cleanup)
    await scratchRepo(p, subDir)
    await git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subDir, 'vendor/sub')
    await git('commit', '-q', '-m', 'add sub')
    await writeRun({ base: (await git('rev-parse', 'HEAD')).trim() })
    writeFileSync(join(dir, 'vendor/sub/README.md'), 'edit inside\n')
    const r = ok(await verify(['true']))
    expect(r).toMatchObject({ exit_code: 0, green: false, dirty_submodules: ['vendor/sub'] })
    expect((await lastVerify()).dirty_submodules).toEqual(['vendor/sub'])
    // The same with the submodule ignored in config, which hides it from git status.
    await git('config', 'submodule.vendor/sub.ignore', 'all')
    expect(ok(await verify(['true']))).toMatchObject({ green: false, dirty_submodules: ['vendor/sub'] })
  }, 30_000)
})

describe('verify: output', () => {
  test('over 4 MiB is streamed into 1 MiB parts, and the last line is in the last part and the tail', async () => {
    const r = ok(await verify(['awk', 'BEGIN { for (i = 0; i < 80000; i++) printf "%060d\\n", i; print "LAST LINE" }']))
    const total = 80000 * 61 + 'LAST LINE\n'.length
    const body = await lastVerify()
    expect(body.log_bytes).toBe(total)
    expect(body.log_parts).toBe(Math.ceil(total / PART_BYTES))
    const names = parts(r.verify_id)
    expect(names).toEqual(['0001.log', '0002.log', '0003.log', '0004.log', '0005.log'])
    for (const name of names.slice(0, -1)) expect(utf8Length(partText(r.verify_id, name))).toBe(PART_BYTES)
    const joined = names.map(n => partText(r.verify_id, n)).join('')
    expect(joined.length).toBe(total)
    expect(joined.startsWith(`${'0'.repeat(60)}\n`)).toBe(true)
    expect(partText(r.verify_id, '0005.log').endsWith('LAST LINE\n')).toBe(true)
    expect(r.output_tail.endsWith('LAST LINE\n')).toBe(true)
    expect(lastLines(r.output_tail, 1000).split('\n').length - 1).toBe(TAIL_LINES)
  }, 30_000)

  test('the tail of 200 very long lines is cut to the last 64 KiB', async () => {
    const r = ok(await verify(['awk', 'BEGIN { for (i = 0; i < 300; i++) { s = sprintf("%04d", i); while (length(s) < 1000) s = s "x"; print s } }']))
    expect(utf8Length(r.output_tail)).toBe(TAIL_BYTES)
    expect(r.output_tail.endsWith(`0299${'x'.repeat(996)}\n`)).toBe(true)
  })

  test('a tail of short lines is the last 200 lines', async () => {
    const r = ok(await verify(['awk', 'BEGIN { for (i = 1; i <= 1000; i++) print "line " i }']))
    const lines = r.output_tail.split('\n')
    expect(lines.pop()).toBe('')
    expect(lines.length).toBe(TAIL_LINES)
    expect(lines[0]).toBe('line 801')
    expect(lines.at(-1)).toBe('line 1000')
  })

  test('multi-byte output splits between parts on character boundaries', async () => {
    // 349,525 three-byte characters fill a part to one byte short; the next piece starts with a four-byte one.
    const fill = '日'.repeat(Math.floor(PART_BYTES / 3))
    scriptedSpawn([fill, '🎉 then more', `${'é'.repeat(PART_BYTES / 2)}\nEND\n`])
    const r = ok(await verify(['scripted']))
    const names = parts(r.verify_id)
    expect(names).toEqual(['0001.log', '0002.log', '0003.log'])
    const text = names.map(n => partText(r.verify_id, n))
    expect(text[0]).toBe(fill)
    expect(text[1]!.startsWith('🎉 then more')).toBe(true)
    expect(text.join('')).toBe(`${fill}🎉 then more${'é'.repeat(PART_BYTES / 2)}\nEND\n`)
    for (const t of text) expect(utf8Length(t)).toBeLessThanOrEqual(PART_BYTES)
    expect(utf8Length(text[1]!)).toBe(PART_BYTES)
    expect((await lastVerify()).log_bytes).toBe(text.reduce((n, t) => n + utf8Length(t), 0))
    // The last 64 KiB: "\nEND\n" and as many whole two-byte characters as fit before it.
    expect(r.output_tail).toBe(`${'é'.repeat(Math.floor((TAIL_BYTES - 5) / 2))}\nEND\n`)
  })

  test('an argv with spaces and shell syntax runs as separate words, never through a shell', async () => {
    const words = ['a b', '$(touch pwned1)', '; touch pwned2', '*', '`touch pwned3`', "it's", '']
    const r = ok(await verify(['printf', '%s|\\n', ...words]))
    expect(r.green).toBe(true)
    expect(r.output_tail).toBe(words.map(w => `${w}|\n`).join(''))
    for (const f of ['pwned1', 'pwned2', 'pwned3']) expect(existsSync(join(dir, f))).toBe(false)
  })

  test('cutTail keeps whole characters at the cut', () => {
    const s = `${'é'.repeat(40_000)}\n`
    const t = cutTail(s)
    expect(utf8Length(t)).toBeLessThanOrEqual(TAIL_BYTES)
    expect(s.endsWith(t)).toBe(true)
    expect(t.includes('�')).toBe(false)
  })
})

describe('verify: input and run checks', () => {
  test('gate is required, and must be a fixed gate or one of the plan', async () => {
    const missing = err(await recordVerify(ctx(), { kind: 'verify', run: RUN, attempt: 1 }))
    expect(missing.field).toBe('gate')
    expect(missing.allowed).toEqual(['baseline', 'goal', 'integration', 'G1'])
    const unknown = err(await recordVerify(ctx(), { kind: 'verify', run: RUN, gate: 'G9', attempt: 1 }))
    expect(unknown.field).toBe('gate')
    expect(err(await recordVerify(ctx(), { kind: 'verify', run: RUN, gate: '../x', attempt: 1 })).field).toBe('gate')
  })

  test('attempt is required for a plan gate, a whole number from 1; baseline takes 1 by default', async () => {
    expect(err(await recordVerify(ctx(), { kind: 'verify', run: RUN, gate: 'G1' })).field).toBe('attempt')
    expect(err(await recordVerify(ctx(), { kind: 'verify', run: RUN, gate: 'G1', attempt: 0 })).field).toBe('attempt')
    expect(err(await recordVerify(ctx(), { kind: 'verify', run: RUN, gate: 'G1', attempt: 1.5 })).field).toBe('attempt')
    expect(err(await recordVerify(ctx(), { kind: 'verify', run: RUN, gate: 'G1', attempt: '1' })).field).toBe('attempt')
    const r = ok(await recordVerify(ctx(RELAY), { kind: 'verify', run: RUN, gate: 'baseline' }))
    expect(r.green).toBe(true)
    expect((await lastVerify()).attempt).toBe(1)
  })

  test("gate 'goal' runs the goal-check argv, and is refused without one", async () => {
    expect(err(await verify(['true'], { gate: 'goal' })).field).toBe('gate')
    await writeRun({ verify: ['false'], goalCheck: ['sh', '-c', 'echo goal-check'] })
    const r = ok(await recordVerify(ctx(RELAY), { kind: 'verify', run: RUN, gate: 'goal' }))
    expect(r.green).toBe(true)
    expect(r.output_tail).toBe('goal-check\n')
    expect((await lastVerify()).argv).toEqual(['sh', '-c', 'echo goal-check'])
  })

  test('only the stored argv runs: a verify field in the call is ignored', async () => {
    const r = ok(await verify(['sh', '-c', 'echo stored'], { verify: ['sh', '-c', 'echo injected'], argv: ['false'] }))
    expect(r.output_tail).toBe('stored\n')
  })

  test('a run with no verify argv, an unknown run, a bad run id, or no litter directory is refused', async () => {
    await writeRun({ verify: null })
    expect(err(await recordVerify(ctx(), { kind: 'verify', run: RUN, gate: 'G1', attempt: 1 })).field).toBe('run')
    expect(err(await recordVerify(ctx(), { kind: 'verify', run: '20261002-nope', gate: 'G1', attempt: 1 })).field).toBe('run')
    expect(err(await recordVerify(ctx(), { kind: 'verify', run: '../x', gate: 'G1', attempt: 1 })).field).toBe('run')
    const none = err(await recordVerify({ ...ctx(), litterDir: null }, { kind: 'verify', run: RUN, gate: 'G1', attempt: 1 }))
    expect(none.error).toMatch(/litter directory/)
  })

  test('a run.json whose facts are off is refused, naming the fact', async () => {
    await writeRun({ ref: 'HEAD' })
    expect(err(await recordVerify(ctx(), { kind: 'verify', run: RUN, gate: 'G1', attempt: 1 })).error).toMatch(/ref/)
    await writeRun({ checkout: 'relative/path' })
    expect(err(await recordVerify(ctx(), { kind: 'verify', run: RUN, gate: 'G1', attempt: 1 })).error).toMatch(/checkout/)
    await writeRun({ base: '--upload-pack=x' })
    expect(err(await recordVerify(ctx(), { kind: 'verify', run: RUN, gate: 'G1', attempt: 1 })).error).toMatch(/base/)
  })

  test('a run that ended or is stopping takes no verify, and nothing runs', async () => {
    const mod = { source: 'mod' } as const
    await appendRecord(p, runDir, { run: RUN, kind: 'run.launch', by: mod, body: {} })
    await appendRecord(p, runDir, { run: RUN, kind: 'run.stopping', by: mod, body: {} })
    const marker = join(outside, 'ran')
    expect(err(await verify(['touch', marker])).error).toMatch(/is stopping/)
    await appendRecord(p, runDir, { run: RUN, kind: 'run.end', by: mod, body: {} })
    expect(err(await verify(['touch', marker])).error).toMatch(/has ended/)
    expect(existsSync(marker)).toBe(false)
    await appendRecord(p, runDir, { run: RUN, kind: 'run.resume', by: mod, body: {} })
    expect(ok(await verify(['touch', marker])).green).toBe(true)
  })

  test('a tampered ledger is refused before anything runs', async () => {
    await appendRecord(p, runDir, { run: RUN, kind: 'finding', by: { source: 'mod' }, body: {} })
    p.storeMap.set(headKey(runDir), { seq: 1, sha: 'not-the-hash' })
    const marker = join(outside, 'ran')
    expect(err(await verify(['touch', marker])).error).toMatch(/tampered/)
    expect(existsSync(marker)).toBe(false)
  })
})

describe('verify: stops and the observed fields', () => {
  test('endVerifies ends a verify in flight: its child is killed and nothing is recorded', async () => {
    const ticks = join(outside, 'ticks')
    const work = verify(['sh', '-c', `while :; do echo tick; echo t >> '${ticks}'; sleep 0.05; done`])
    await until(() => existsSync(ticks))
    expect(verifiesInFlight(RUN)).toBe(1)
    expect(endVerifies(RUN)).toBe(1)
    const r = err(await work)
    expect(r.error).toMatch(/stopping/)
    expect(verifiesInFlight(RUN)).toBe(0)
    expect((await records()).filter(x => x.kind === 'verify')).toEqual([])
    const size = statSync(ticks).size
    await Bun.sleep(300)
    expect(statSync(ticks).size).toBe(size)
  })

  test("the verify is answered even when the caller's out file can't be written", async () => {
    // output.ts (package B) writes out/<agent_id>.json; whatever it does, the record stands.
    const r = ok(await verify(['true'], {}, RELAY))
    expect(r.green).toBe(true)
    const outFile = join(litterDir, 'hooks', 'out', 'relay-1.json')
    if (existsSync(outFile)) {
      const out = JSON.parse(readFileSync(outFile, 'utf8')) as { for: unknown; fields: unknown }
      expect(out.for).toEqual({ verify_id: r.verify_id })
      expect(out.fields).toEqual({ verify_id: r.verify_id, exit_code: 0, signal: null, timed_out: false, green: true })
    } else {
      expect(p.logs.some(l => l.includes('out file for relay-1 not written'))).toBe(true)
    }
  })

  test('the main thread may record a verify; it is authored by the launcher', async () => {
    ok(await verify(['true'], {}, { agentId: null, agentType: null }))
    expect((await records()).at(-1)!.by).toEqual({ source: 'launcher' })
  })

  // The engine's strict schema check, as far as these schemas need it: types, required, no extra keys.
  type Prop = { type: string | string[]; items?: Prop }
  type Schema = { properties: Record<string, Prop>; required: string[] }
  const typeOf = (v: unknown) => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v === 'number' ? 'number' : typeof v)
  function schemaErrors(value: Record<string, unknown>, schema: Schema): string[] {
    const errors = schema.required.filter(k => !(k in value)).map(k => `missing ${k}`)
    for (const [k, v] of Object.entries(value)) {
      const prop = schema.properties[k]
      if (!prop) errors.push(`extra ${k}`)
      else if (![prop.type].flat().includes(typeOf(v))) errors.push(`${k} is ${typeOf(v)}`)
    }
    return errors
  }
  // From the execute.js sketch (plan section 7).
  const VERIFIED: Schema = {
    properties: { verify_id: { type: 'string' }, exit_code: { type: ['number', 'null'] }, signal: { type: ['string', 'null'] }, timed_out: { type: 'boolean' }, green: { type: 'boolean' } },
    required: ['verify_id', 'exit_code', 'green'],
  }
  const DIM: Schema = { properties: { pass: { type: 'boolean' }, evidence: { type: 'string' }, gaps: { type: 'array' } }, required: ['pass', 'evidence', 'gaps'] }

  test("a relay's observed fields validate against VERIFIED for green, red, signal and timeout", async () => {
    const ran = [
      ok(await verify(['true'], {}, RELAY)),
      ok(await verify(['false'], {}, RELAY)),
      ok(await verify(['sh', '-c', 'kill -KILL $$'], {}, RELAY)),
    ]
    const work = verify(['sleep', '3'], {}, RELAY, { verifyTimeoutMs: 1000 })
    fireTimers(work, () => Bun.sleep(200))
    ran.push(ok(await work))
    const bodies = (await records()).filter(r => r.kind === 'verify').map(r => r.body as VerifyBody)
    expect(bodies.map(b => howEnded(b))).toEqual(['exit 0', 'exit 1', 'killed by SIGKILL', 'timed out'])
    for (const b of bodies) {
      const fields = verifyFields('relay', b)!
      expect(schemaErrors(fields, VERIFIED)).toEqual([])
      expect(fields).toEqual({ verify_id: b.verify_id, exit_code: b.exit_code, signal: b.signal, timed_out: b.timed_out, green: b.green })
    }
  })

  test("the critic's observed tests_green is a whole dimension: pass from the record, evidence saying how it ended", async () => {
    ok(await verify(['sh', '-c', 'echo boom; exit 2']))
    const red = verifyFields('gate-critic', await lastVerify())!
    expect(schemaErrors(red.tests_green as Record<string, unknown>, DIM)).toEqual([])
    expect(red.tests_green).toMatchObject({ pass: false, gaps: [] })
    expect((red.tests_green as { evidence: string }).evidence).toMatch(/^verify G1-1-\w+ exit 2: boom\n$/)
    ok(await verify(['true']))
    const green = verifyFields('gate-critic', await lastVerify())!
    expect(green.tests_green).toMatchObject({ pass: true })
    expect(verifyFields('executor', await lastVerify())).toBeNull()
  })
})

describe("verify: a fanout's gate integration (plan section 7, fanout.js step 4)", () => {
  const VERIFIER: Caller = { agentId: 'verifier-1', agentType: 'litter:verifier' }
  const fanout = (argv: string[]) => writeRun({ workflow: 'fanout', verify: argv, args: { tasks: [], mergeOrder: [] } })
  const integrationVerify = () => recordVerify(ctx(VERIFIER), { kind: 'verify', run: RUN, gate: 'integration', attempt: 1 })

  /** The integration worktree, with a file only it has, recorded as integrate leaves it. */
  async function addIntegration(): Promise<string> {
    const path = join(realpathSync(outside), '.claude', 'worktrees', `litter-${RUN}-integration`)
    await git('worktree', 'add', '-q', '-b', `litter/${RUN}-integration`, path, base)
    writeFileSync(join(path, 'only-here.txt'), 'integrated\n')
    const add = await p.run(['git', 'add', 'only-here.txt'], { cwd: path })
    expect(add.code).toBe(0)
    expect((await p.run(['git', 'commit', '-q', '-m', 'merge'], { cwd: path })).code).toBe(0)
    const body: WorktreeCreateBody = { run: RUN, name: `litter-${RUN}-integration`, path, branch: `litter/${RUN}-integration`, base, disposable: false, ignored: [] }
    await appendRecord(p, runDir, { run: RUN, kind: 'worktree.create', by: { source: 'mod' }, body })
    return path
  }

  test('refuses before integrate made the integration worktree, recording nothing', async () => {
    await fanout(['true'])
    const r = err(await integrationVerify())
    expect(r).toMatchObject({ field: 'gate' })
    expect(r.error).toMatch(/record integrate first/)
    expect(await records()).toEqual([])
  })

  test('runs in the integration worktree, chosen by the mod, and snapshots it there', async () => {
    await fanout(['sh', '-c', 'test -f only-here.txt && pwd -P'])
    const path = await addIntegration()
    const r = ok(await integrationVerify())
    expect(r.green).toBe(true)
    expect(r.output_tail.trim()).toBe(path)
    const tree = (await p.run(['git', 'rev-parse', 'HEAD^{tree}'], { cwd: path })).stdout.trim()
    expect(r.tree).toBe(tree)
    expect(r.tree).not.toBe(await headTree())
    expect(await lastVerify()).toMatchObject({ gate: 'integration', tree_before: tree, tree_after: tree })
    // The checkout itself has no such file: the same argv there is red.
    expect(existsSync(join(dir, 'only-here.txt'))).toBe(false)
  })

  test("the verifier's out file carries its verify_id and no fields, so output.sh can check it", async () => {
    await fanout(['true'])
    await addIntegration()
    const r = ok(await integrationVerify())
    const out = JSON.parse(readFileSync(join(litterDir, 'hooks', 'out', 'verifier-1.json'), 'utf8'))
    expect(out).toEqual({ v: 1, agent_id: 'verifier-1', for: { verify_id: r.verify_id }, fields: {} })
    expect(verifyFields('verifier', await lastVerify())).toEqual({})
  })

  test('an execute run, and a fanout gate other than integration, still verify the checkout', async () => {
    await writeRun({ verify: ['sh', '-c', 'pwd -P'] })
    const r = ok(await recordVerify(ctx(VERIFIER), { kind: 'verify', run: RUN, gate: 'integration', attempt: 1 }))
    expect(r.output_tail.trim()).toBe(realpathSync(dir))
    await fanout(['sh', '-c', 'pwd -P'])
    await addIntegration()
    const b = ok(await recordVerify(ctx(VERIFIER), { kind: 'verify', run: RUN, gate: 'baseline' }))
    expect(b.output_tail.trim()).toBe(realpathSync(dir))
  })
})
