// Tier 2: checkedRunJson (hooks/runjson.ts), the one read of run.json for
// whatever acts on it: an untampered ledger this store drives, a run.start,
// and the run.json whose sha256 that run.start recorded. Each refusal on its
// own, then runJsonForRecord's answer for a record handler.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { RunJson } from '../../hooks/records/run'
import { appendRecord, elsewhere, headKey } from '../../hooks/ledgercore'
import { runDir as runDirOf, runJsonPath } from '../../hooks/layout'
import { checkedRunJson, runJsonChanged, runJsonForRecord } from '../../hooks/runjson'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'
import { startedRunJson } from './support/runjson'

const RUN = '20261011-checked'
const JSON_: Partial<RunJson> = { v: 1, run: RUN, workflow: 'execute', base: 'b'.repeat(40), ref: `refs/heads/litter/${RUN}`, checkout: '/repo', verify: ['true'] }

let p: TestPorts
let runDir: string
let cleanup: () => void
const ref = () => ({ run: RUN, runDir })

beforeEach(() => {
  p = nodePorts()
  const s = scratch()
  cleanup = s.cleanup
  runDir = runDirOf(join(s.dir, '.claude', 'litter'), RUN)
})
afterEach(() => cleanup())

describe('checkedRunJson', () => {
  test('run.json as run.start wrote it is read, with its run.start', async () => {
    const text = await startedRunJson(p, runDir, JSON_)
    const c = await checkedRunJson(p, ref())
    if (!c.ok) throw new Error(c.reason)
    expect(c.json).toEqual(JSON.parse(text))
    expect(c.start.checkout).toBe('/repo')
  })

  test('a run.json changed after run.start: refused with the one text, unprefixed', async () => {
    await startedRunJson(p, runDir, JSON_)
    writeFileSync(runJsonPath(runDir), JSON.stringify({ ...JSON_, checkout: '/elsewhere' }))
    expect(await checkedRunJson(p, ref())).toMatchObject({ ok: false, why: 'changed', reason: runJsonChanged(RUN) })
    expect(runJsonChanged(RUN)).not.toStartWith('litter: ')
    // Whitespace counts: the sha256 is of the text.
    await startedRunJson(p, runDir, JSON_, undefined, { fresh: true })
    writeFileSync(runJsonPath(runDir), `${JSON.stringify(JSON_)}\n`)
    expect(await checkedRunJson(p, ref())).toMatchObject({ ok: false, why: 'changed' })
  })

  test('a run.start whose run.json was never written', async () => {
    await startedRunJson(p, runDir, JSON_)
    rmSync(runJsonPath(runDir))
    expect(await checkedRunJson(p, ref())).toMatchObject({ ok: false, why: 'missing', reason: `run ${RUN} has no run.json` })
  })

  test('a run.json with no run.start', async () => {
    await p.fs.write(runJsonPath(runDir), JSON.stringify(JSON_))
    expect(await checkedRunJson(p, ref())).toMatchObject({ ok: false, why: 'unstarted', reason: `run ${RUN} has no run.start record` })
  })

  test('a tampered ledger, even with run.json unchanged', async () => {
    await startedRunJson(p, runDir, JSON_)
    p.storeMap.set(headKey(runDir), { seq: 1, sha: 'not-the-hash' })
    expect(await checkedRunJson(p, ref())).toMatchObject({ ok: false, why: 'tampered' })
  })

  test("a ledger this store doesn't drive (its head gone)", async () => {
    await startedRunJson(p, runDir, JSON_)
    p.storeMap.delete(headKey(runDir))
    expect(await checkedRunJson(p, ref())).toMatchObject({ ok: false, why: 'elsewhere', reason: `${elsewhere(RUN)}; litter won't act on it here` })
  })

  test("the caller's read of the ledger is the one checked", async () => {
    await startedRunJson(p, runDir, JSON_)
    const first = await checkedRunJson(p, ref())
    await appendRecord(p, runDir, { run: RUN, kind: 'run.launch', by: { source: 'mod' }, body: {} })
    const again = await checkedRunJson(p, ref(), first.ledger)
    expect(again.ok).toBe(true)
    expect(again.ledger).toBe(first.ledger)
  })
})

describe('runJsonForRecord', () => {
  test('the json; nothing for a run with none yet; the refusal, prefixed, for a changed one', async () => {
    expect(await runJsonForRecord(p, ref())).toBeUndefined()
    await startedRunJson(p, runDir, JSON_)
    expect(await runJsonForRecord(p, ref())).toEqual(JSON_ as RunJson)
    rmSync(runJsonPath(runDir))
    expect(await runJsonForRecord(p, ref())).toBeUndefined()
    writeFileSync(runJsonPath(runDir), JSON.stringify({ ...JSON_, verify: ['sh', '-c', 'id'] }))
    expect(await runJsonForRecord(p, ref())).toBe(`litter: ${runJsonChanged(RUN)}`)
  })
})
