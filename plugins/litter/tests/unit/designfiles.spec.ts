// Tier 2: hooks/design/files.ts, the verdict and probe files (plan section
// 10, "On disk"; COMMON decisions 17 and 18): each rendered from its ledger
// record, record text escaped in table cells, the latest record for a
// version or unknown winning whatever order the writes finish in, and a
// version or id that can't name a file writing nothing.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import type { StoredRecord } from '../../hooks/records/core'
import { appendRecord } from '../../hooks/ledgercore'
import { designVerdictPath, probePath, runDir } from '../../hooks/layout'
import { renderDesignVerdict, renderProbe, writeDesignVerdictFile, writeProbeFile } from '../../hooks/design/files'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const RUN = '20261004-files'
const CRITIC = { source: 'agent', agentId: 'cr', agentType: 'litter:design-critic' } as const
const PROBER = { source: 'agent', agentId: 'pr', agentType: 'litter:prober' } as const

let p: TestPorts
let dir: string
let cleanup: () => void

beforeEach(() => {
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
})
afterEach(() => cleanup())

const rd = () => runDir(dir, RUN)
const append = (kind: string, by: StoredRecord['by'], body: Record<string, unknown>) => appendRecord(p, rd(), { run: RUN, kind, by, body })

const verdictBody = (overall: string, extra: Record<string, unknown> = {}) => ({
  version: 'v2',
  criteria: [
    { id: 'C1', verdict: 'PASS', evidence: 'src/run.ts:88-104', kept_from: 'v1' },
    { id: 'C2', verdict: 'CONDITIONAL', gap_or_reason: 'no behaviour stated | for targets\nwithout IPC', evidence: 'coverage row 4\r\nmarks it', gap_kind: 'wording' },
    { id: 'B1', verdict: 'FAIL', gap_or_reason: 'hard stop', evidence: 'the fallback section is empty', gap_kind: 'design', reversed: true },
  ],
  overall,
  sha256: 'a'.repeat(64),
  tree: 'b'.repeat(40),
  source_changed: false,
  ...extra,
})

describe('verdicts/vN.md', () => {
  test('the version and its sha256, source_changed, the overall result and the criteria, record text escaped in its cells', async () => {
    const rec = await append('verdict', CRITIC, verdictBody('HOLDING'))
    await writeDesignVerdictFile(p, rd(), rec)
    expect(readFileSync(designVerdictPath(rd(), 'v2'), 'utf8')).toBe(
      [
        '# Verdict on v2',
        '',
        `- Run: ${RUN}`,
        `- Version: v2, sha256 ${'a'.repeat(64)}`,
        `- Source changed: no: the checkout's tree (${'b'.repeat(40)}) is base's`,
        '- Overall: HOLDING on C2, B1',
        '- Agent: cr (litter:design-critic)',
        '- Ledger seq: 1',
        '',
        '## Criteria',
        '',
        '| Criterion | Verdict | Gap or reason | Evidence | Gap kind | Kept from |',
        '|---|---|---|---|---|---|',
        '| C1 | PASS |  | src/run.ts:88-104 |  | v1 |',
        '| C2 | CONDITIONAL | no behaviour stated \\| for targets<br>without IPC | coverage row 4<br>marks it | wording |  |',
        '| B1 | FAIL | hard stop | the fallback section is empty | design |  |',
        '',
      ].join('\n'),
    )
  })

  test('source_changed true, and a verdict recorded before phase 4 with neither snapshot nor sha256', () => {
    const changed = renderDesignVerdict({ v: 1, seq: 4, kind: 'verdict', run: RUN, at: 0, by: CRITIC, prev: null, body: verdictBody('HOLDING', { source_changed: true }) })
    expect(changed).toContain(`- Source changed: yes: the checkout's tree (${'b'.repeat(40)}) isn't base's`)
    const old = renderDesignVerdict({
      v: 1,
      seq: 4,
      kind: 'verdict',
      run: RUN,
      at: 0,
      by: CRITIC,
      prev: null,
      body: { version: 'v1', criteria: [{ id: 'C1', verdict: 'PASS', evidence: 'e' }], overall: 'APPROVED', sha256: null },
    })
    expect(old).toContain('- Version: v1, sha256 not recorded')
    expect(old).toContain('- Source changed: not recorded')
    expect(old).toContain('- Overall: APPROVED\n')
  })

  test('the latest record for a version wins, whatever order the writes finish in', async () => {
    const first = await append('verdict', CRITIC, verdictBody('HOLDING'))
    const other = await append('verdict', CRITIC, { ...verdictBody('HOLDING'), version: 'v3' })
    const second = await append('verdict', CRITIC, verdictBody('APPROVED', { criteria: [{ id: 'C1', verdict: 'PASS', evidence: 'later' }] }))
    await writeDesignVerdictFile(p, rd(), second)
    await writeDesignVerdictFile(p, rd(), first)
    await writeDesignVerdictFile(p, rd(), other)
    const v2 = readFileSync(designVerdictPath(rd(), 'v2'), 'utf8')
    expect(v2).toContain('- Overall: APPROVED')
    expect(v2).toContain('- Ledger seq: 3')
    expect(readFileSync(designVerdictPath(rd(), 'v3'), 'utf8')).toContain('- Ledger seq: 2')
  })

  test("a version that isn't v<n> writes nothing and is logged", async () => {
    for (const version of ['../v1', 'v0', 'V1', 'v1.md', 3, undefined]) {
      const rec = await append('verdict', CRITIC, { ...verdictBody('HOLDING'), version })
      await writeDesignVerdictFile(p, rd(), rec)
    }
    expect(existsSync(`${rd()}/verdicts`)).toBe(false)
    expect(p.logs.filter(l => l.includes("isn't v<n>; no verdict file"))).toHaveLength(6)
  })
})

describe('probes/<id>.md', () => {
  test("the unknown's id, the verdict and the report as recorded", async () => {
    const report = '## Commands\n\n```sh\ncurl -sI https://example.test | grep -i retry-after\n```\n\nNo header: refuted.'
    const rec = await append('probe', PROBER, { unknown_id: 'U2', report, verdict: 'refuted' })
    await writeProbeFile(p, rd(), rec)
    expect(readFileSync(probePath(rd(), 'U2'), 'utf8')).toBe(
      ['# Probe of U2', '', `- Run: ${RUN}`, '- Unknown: U2', '- Verdict: refuted', '- Agent: pr (litter:prober)', '- Ledger seq: 1', '', '## Report', '', `${report}\n`].join('\n'),
    )
    expect(renderProbe({ ...rec, body: { unknown_id: 'U2', report: 'ends\n', verdict: 'confirmed' } }).endsWith('\n\nends\n')).toBe(true)
  })

  test('the latest record for an id wins, whatever order the writes finish in', async () => {
    const first = await append('probe', PROBER, { unknown_id: 'U1', report: 'first', verdict: 'untested' })
    const second = await append('probe', PROBER, { unknown_id: 'U1', report: 'second', verdict: 'confirmed' })
    await Promise.all([writeProbeFile(p, rd(), second), writeProbeFile(p, rd(), first)])
    const u1 = readFileSync(probePath(rd(), 'U1'), 'utf8')
    expect(u1).toContain('- Verdict: confirmed')
    expect(u1).toContain('second')
  })

  test("an id that isn't U<n> writes nothing and is logged", async () => {
    for (const unknown_id of ['../U1', 'U0', 'u1', 'U1/x', undefined]) {
      const rec = await append('probe', PROBER, { unknown_id, report: 'r', verdict: 'confirmed' })
      await writeProbeFile(p, rd(), rec)
    }
    expect(existsSync(`${rd()}/probes`)).toBe(false)
    expect(readdirSync(rd()).sort()).toEqual(['ledger'])
    expect(p.logs.filter(l => l.includes("isn't U<n>; no probe file"))).toHaveLength(5)
  })

  test('a record of another kind writes nothing', async () => {
    const rec = await append('finding', PROBER, { unknown_id: 'U1', report: 'r', verdict: 'confirmed', version: 'v1' })
    await writeProbeFile(p, rd(), rec)
    await writeDesignVerdictFile(p, rd(), rec)
    expect(readdirSync(rd()).sort()).toEqual(['ledger'])
  })
})
