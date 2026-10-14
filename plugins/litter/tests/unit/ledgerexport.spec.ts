// Tier 2: the ledger's export (hooks/ledgerexport.ts; plan section 9,
// "The export is partitioned and optional", and section 12's ledger bounds):
// parts under 1 MiB that read back to every record in order, a later export
// that rewrites only what changed, and run.end, which schedules it after
// summary.md and never waits for it, so a failed export changes nothing.

import { afterEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { RecordCtx, RecordInput, StoredRecord } from '../../hooks/records/core'
import type { RunStartReply } from '../../hooks/records/run'
import { endRun, recordRunStart } from '../../hooks/lifecycle'
import { readLock, stopLease } from '../../hooks/lock'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { ledgerExportDir, ledgerExportPart, modePath, summaryPath } from '../../hooks/layout'
import { EXPORT_PART_MAX_BYTES, exportLedger, exportParts } from '../../hooks/ledgerexport'
import { normalizeOptions } from '../../hooks/options'
import { nodePorts, runAfters, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Real git for the run.end cases; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const PLAN = ['# Plan', '', '### G1: First', 'Files: a.txt', 'Checks: test -f a.txt', 'Done when: a.txt exists', ''].join('\n')
const RUN = '20261014-execute-abc123'
const MIB = 1024 * 1024

const cleanups: (() => void)[] = []
afterEach(() => {
  stopLease()
  for (const c of cleanups.splice(0)) c()
})

function tmp(): string {
  const s = scratch()
  cleanups.push(s.cleanup)
  return realpathSync(s.dir)
}

/** The export's parts as files, in order, and every line parsed. */
function exported(runDir: string): { sizes: number[]; records: StoredRecord[] } {
  const dir = ledgerExportDir(runDir)
  const names = readdirSync(dir).sort()
  expect(names).toEqual(names.map((_, i) => `${String(i + 1).padStart(4, '0')}.jsonl`))
  const texts = names.map(n => readFileSync(join(dir, n), 'utf8'))
  return {
    sizes: texts.map(t => Buffer.byteLength(t)),
    records: texts.flatMap(t => t.split('\n').filter(l => l !== '').map(l => JSON.parse(l) as StoredRecord)),
  }
}

/** A run folder with `n` records whose bodies carry `pad` characters each. */
async function ledgerOf(p: TestPorts, runDir: string, n: number, pad: number): Promise<void> {
  for (let i = 0; i < n; i++) await appendRecord(p, runDir, { run: RUN, kind: 'finding', by: { source: 'mod' }, body: { i, text: 'x'.repeat(pad) } })
}

describe('the parts', () => {
  test('a part ends before it would pass the cap, a record as big as the cap stands alone, and the lines keep seq order', () => {
    const rec = (seq: number, size: number): StoredRecord => ({ v: 1, seq, kind: 'finding', run: RUN, at: 0, by: { source: 'mod' }, prev: null, body: { t: 'y'.repeat(size) } })
    const line = (r: StoredRecord) => Buffer.byteLength(`${JSON.stringify(r)}\n`)
    const small = [rec(1, 10), rec(2, 10), rec(3, 10)]
    const cap = line(small[0]!) + line(small[1]!)
    expect(exportParts(small, cap).map(t => t.split('\n').filter(Boolean).length)).toEqual([2, 1])
    // One over the cap on its own still gets its part: a bounded record always fits one.
    const parts = exportParts([rec(1, 10), rec(2, 200), rec(3, 10)], cap)
    expect(parts.map(t => (JSON.parse(t.split('\n')[0]!) as StoredRecord).seq)).toEqual([1, 2, 3])
    expect(exportParts([], cap)).toEqual([])
  })

  test('over 4 MiB of records come out as parts under 1 MiB each that read back to every record in order', async () => {
    const p = nodePorts()
    const runDir = join(tmp(), RUN)
    await ledgerOf(p, runDir, 50, 100_000)
    const n = await exportLedger(p, runDir, RUN)
    const out = exported(runDir)
    expect(n).toBe(out.sizes.length)
    expect(out.sizes.length).toBeGreaterThan(4)
    for (const size of out.sizes) expect(size).toBeLessThanOrEqual(EXPORT_PART_MAX_BYTES)
    expect(out.sizes.reduce((a, b) => a + b, 0)).toBeGreaterThan(4 * MIB)
    expect(out.records).toEqual((await readLedger(p, runDir, RUN)).records)
  })

  test("a later export adds to the last part and writes no part that didn't change", async () => {
    const p = nodePorts()
    const runDir = join(tmp(), RUN)
    await ledgerOf(p, runDir, 25, 100_000)
    await exportLedger(p, runDir, RUN)
    const first = exported(runDir).sizes.length
    const before = new Map(Array.from({ length: first }, (_, i) => [i + 1, statSync(ledgerExportPart(runDir, i + 1)).mtimeMs]))
    const writes: string[] = []
    const write = p.fs.write
    p.fs.write = async (path, text) => {
      writes.push(path)
      return write(path, text)
    }
    await ledgerOf(p, runDir, 15, 100_000)
    await exportLedger(p, runDir, RUN)
    const out = exported(runDir)
    expect(out.records).toEqual((await readLedger(p, runDir, RUN)).records)
    // The full parts before the last weren't written again.
    const rewritten = writes.map(w => w.replace(/\.tmp-.*$/, ''))
    for (let i = 1; i < first; i++) {
      expect(rewritten).not.toContain(ledgerExportPart(runDir, i))
      expect(statSync(ledgerExportPart(runDir, i)).mtimeMs).toBe(before.get(i)!)
    }
    expect(rewritten).toContain(ledgerExportPart(runDir, out.sizes.length))
    // And again with nothing new: nothing written.
    writes.length = 0
    await exportLedger(p, runDir, RUN)
    expect(writes).toEqual([])
  })
})

describe('run.end', () => {
  async function started(p: TestPorts): Promise<{ ref: { run: string; runDir: string; litterDir: string }; dir: string }> {
    const dir = tmp()
    const { git } = await scratchRepo(p, dir)
    await p.fs.write(join(dir, 'plan.md'), PLAN)
    await git('add', 'plan.md')
    await git('commit', '-q', '-m', 'plan')
    const litterDir = join(dir, '.claude', 'litter')
    await p.fs.write(modePath(litterDir), 'default\n')
    const q: TestPorts = { ...p, cwd: async () => dir, run: (argv, init) => p.run(argv, init?.cwd ? init : { ...init, cwd: dir }) }
    const ctx: RecordCtx = { p: q, caller: { agentId: null, agentType: null }, litterDir, options: normalizeOptions({ verify: ['true'] }) }
    const r = (await recordRunStart(ctx, { kind: 'run.start', workflow: 'execute', planPath: 'plan.md', authorized: ['change a.txt'] } as RecordInput)) as RunStartReply
    if (!r.ok) throw new Error(`run.start refused: ${JSON.stringify(r)}`)
    return { ref: { run: r.run, runDir: r.runDir, litterDir }, dir }
  }

  const END = { taskId: null, generation: 0, status: 'launch_failed', reason: 'test', source: 'mod' } as const

  test('schedules the export after summary.md, waits for none of it, and the export holds every record through run.end', async () => {
    const p = nodePorts({ sessionId: 'session-a' })
    const { ref, dir } = await started(p)
    await endRun(p, ref, END)
    expect(existsSync(summaryPath(ref.runDir))).toBe(true)
    expect(await readLock(p, dir)).toBeNull()
    expect(existsSync(ledgerExportDir(ref.runDir))).toBe(false)
    await runAfters(p, { all: true })
    const out = exported(ref.runDir)
    expect(out.records).toEqual((await readLedger(p, ref.runDir, ref.run)).records)
    expect(out.records.at(-1)?.kind).toBe('run.end')
  })

  test("an export forced to fail leaves run.end's status, summary.md and the released lock as they were, and is logged", async () => {
    const p = nodePorts({ sessionId: 'session-a' })
    const { ref, dir } = await started(p)
    const write = p.fs.write
    p.fs.write = async (path, text) => {
      if (path.startsWith(ledgerExportDir(ref.runDir))) throw new Error('disk full')
      return write(path, text)
    }
    await endRun(p, ref, END)
    const summary = readFileSync(summaryPath(ref.runDir), 'utf8')
    await runAfters(p, { all: true })
    expect(p.logs.some(l => l === `ledger export for ${ref.run} failed: disk full`)).toBe(true)
    const records = (await readLedger(p, ref.runDir, ref.run)).records
    expect(records.filter(r => r.kind === 'run.end').map(r => r.body.status)).toEqual(['launch_failed'])
    expect(readFileSync(summaryPath(ref.runDir), 'utf8')).toBe(summary)
    expect(await readLock(p, dir)).toBeNull()
  })
})
