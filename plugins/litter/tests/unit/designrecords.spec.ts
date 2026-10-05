// Tier 2: hooks/design/records.ts through the record tool's dispatcher, as a
// design's roles call it, in a scratch repo whose litter directory is
// <repo>/.claude/litter: the proposal's rendered bytes, sha256 and out file;
// the verdict's gap kinds, its snapshot against base (decision 17), its out
// file (decision 7) and verdicts/vN.md; the probe's fields (decision 18) and
// probes/<id>.md.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Policy } from '../../hooks/hookfiles'
import type { RecordError, RecordOk, RecordReply } from '../../hooks/records/core'
import type { AuthorGate } from '../../hooks/records/design'
import { dispatchRecord, type DispatchEnv } from '../../hooks/ledger'
import { readLedger } from '../../hooks/ledgercore'
import { designVerdictPath, hooksDir, outPath, probePath, proposalPath, runDir, runJsonPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { consumeAgents, writePolicy } from '../../hooks/policy'
import { GAP_KINDS, PROBE_VERDICTS } from '../../hooks/records/design'
import { renderProposal } from '../../hooks/design/proposal'
import { snapshot } from '../../hooks/snapshot'
import { sha256 } from '../../hooks/fsx'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Real git in a scratch repo; a loaded machine takes seconds.
setDefaultTimeout(120_000)

const RUN = '20261004-records'
const BAR = ['C1', 'C2', 'B1'].map(id => ({ id, text: `item ${id}`, evidence: 'a test' }))

let p: TestPorts
let root: string
let repo: string
let litterDir: string
let cleanup: () => void
let git: (...argv: string[]) => Promise<string>
let env: DispatchEnv

beforeEach(async () => {
  p = nodePorts()
  ;({ dir: root, cleanup } = scratch())
  repo = join(root, 'repo')
  mkdirSync(repo)
  ;({ git } = await scratchRepo(p, repo))
  litterDir = join(repo, '.claude', 'litter')
  env = { litterDir, litterDirError: null, ready: true, options: normalizeOptions(undefined) }
})
afterEach(() => cleanup())

const dir = () => runDir(litterDir, RUN)

/** The base run.start freezes for a design: the checkout's snapshot, wrapped in a commit on HEAD. */
async function baseCommit(): Promise<string> {
  const snap = await snapshot(p, repo)
  return (await git('commit-tree', snap.tree, '-p', 'HEAD', '-m', 'litter: base snapshot')).trim()
}

/** A design run as run.start leaves it: run.json with its args, checkout and base, and policy.json naming it. */
async function makeRun(args: Record<string, unknown> = {}, fields: Record<string, unknown> = {}): Promise<string> {
  const base = await baseCommit()
  const json = { v: 1, run: RUN, workflow: 'design', args: { deliverable: 'plan', bar: BAR, ...args }, base, ref: `refs/litter/${RUN}/base`, checkout: repo, ...fields }
  await p.fs.write(runJsonPath(dir()), `${JSON.stringify(json)}\n`)
  const policy: Policy = {
    v: 1,
    session: 'test-session',
    litterDir,
    run: {
      run: RUN,
      workflow: 'design',
      runDir: dir(),
      checkout: repo,
      base,
      runIds: [],
      launching: false,
      stopping: false,
      inflight: null,
      isolationLost: false,
      roots: { checkout: repo, litterDir, litterCopies: [litterDir], ruleDirs: [], worktrees: [] },
      setup: null,
      linkDirs: [],
    },
    roles: {},
    swarm: null,
  }
  await writePolicy(p, litterDir, policy)
  for (const [id, role] of [['au', 'author'], ['cr', 'design-critic'], ['pr', 'prober']]) {
    await consumeAgents(
      { p, litterDir, sessionId: 'test-session' },
      { v: 1, ev: 'start', ts: 1_700_000_000, session_id: 'test-session', agent_id: id!, agent_type: `litter:${role}`, cwd: repo, transcript_path: '/t' },
    )
  }
  return base
}

const call = (fields: Record<string, unknown>, agentId: string) => dispatchRecord(p, agentId, { tool: 'mcp__litter__record', tool_use_id: 'tu1', ...fields }, env)

const asError = (r: RecordReply): RecordError => {
  expect(r.ok).toBe(false)
  return r as RecordError
}

const asOk = (r: RecordReply): RecordOk => {
  if (!r.ok) throw new Error(`${r.field}: ${r.error}`)
  return r
}

const records = async () => (await readLedger(p, dir(), RUN)).records
const outOf = (agentId: string) => JSON.parse(readFileSync(outPath(litterDir, agentId), 'utf8'))

const PROSE = '# Retry once\n\n## The retry\n\nRetry the refresh once, in `src/in_prose.py`.\n'
const GATES: AuthorGate[] = [
  {
    id: 'G1',
    title: 'Retry the refresh',
    plan_section: 'The retry',
    scope: 'Wrap the call in `src/inside_gate.py`.',
    files: ['src/refresh.py'],
    checks: ['pytest tests/test_refresh.py'],
    done_when: 'test_refresh_retries_once passes',
    rollback: 'revert the commit',
  },
]

const pass = (ids: string[]) => ids.map(id => ({ id, verdict: 'PASS', evidence: `src/${id}.py:1` }))

// ---------------------------------------------------------------------------

describe('proposal', () => {
  test("a plan's proposals/vN.md holds the rendered bytes, the record's sha256 is theirs, and the out file's proposal equals the file", async () => {
    await makeRun()
    const r = asOk(await call({ kind: 'proposal', text: PROSE, gates: GATES, delta: ['first'] }, 'au'))
    const file = readFileSync(proposalPath(dir(), 'v1'), 'utf8')
    const want = renderProposal(PROSE, GATES, 'plan')
    expect(want.ok && file).toBe(want.ok ? want.text : 'unrendered')
    expect(file).toContain('\n## Gates\n\n### G1: Retry the refresh\n')
    expect(r).toEqual(expect.objectContaining({ ok: true, version: 'v1', sha256: await sha256(file) }))
    expect(outOf('au')).toEqual({ v: 1, agent_id: 'au', for: { version: 'v1' }, fields: { version: 'v1', proposal: file } })
    const [rec] = await records()
    // The prose as recorded, the author's gates, and the file's sha256.
    expect(rec!.body).toEqual({ text: PROSE, gates: GATES, delta: ['first'], version: 'v1', sha256: await sha256(file) })
  })

  test('the bare-path warning reads the prose only', async () => {
    await makeRun()
    const warnings = asOk(await call({ kind: 'proposal', text: PROSE, gates: GATES }, 'au')).warnings as string[]
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('src/in_prose.py')
    expect(warnings[0]).not.toContain('src/inside_gate.py')
  })

  test("the gates sent as a string of their JSON are decoded, as the tool's schema declares them", async () => {
    await makeRun()
    expect(asOk(await call({ kind: 'proposal', text: PROSE, gates: JSON.stringify(GATES) }, 'au')).version).toBe('v1')
  })

  test("a plan without gates, or with one that doesn't render, records nothing", async () => {
    await makeRun()
    expect(asError(await call({ kind: 'proposal', text: PROSE }, 'au')).field).toBe('gates')
    expect(asError(await call({ kind: 'proposal', text: PROSE, gates: 'none' }, 'au')).field).toBe('gates')
    const e = asError(await call({ kind: 'proposal', text: PROSE, gates: [{ ...GATES[0]!, plan_section: 'Elsewhere' }] }, 'au'))
    expect(e.field).toBe('gates[0].plan_section')
    expect(await records()).toEqual([])
    expect(existsSync(proposalPath(dir(), 'v1'))).toBe(false)
    expect(existsSync(outPath(litterDir, 'au'))).toBe(false)
  })

  test('research refuses gates, and stores its text unchanged', async () => {
    await makeRun({ deliverable: 'research' })
    expect(asError(await call({ kind: 'proposal', text: PROSE, gates: GATES }, 'au')).field).toBe('gates')
    const text = `${PROSE}\n\n`
    expect(asOk(await call({ kind: 'proposal', text, gates: [] }, 'au')).sha256).toBe(await sha256(text))
    expect(readFileSync(proposalPath(dir(), 'v1'), 'utf8')).toBe(text)
  })

  test('a run.json that names no deliverable is refused', async () => {
    await makeRun({ deliverable: undefined })
    const e = asError(await call({ kind: 'proposal', text: PROSE }, 'au'))
    expect(e.field).toBe('run')
    expect(e.error).toContain('names no deliverable')
    expect(await records()).toEqual([])
  })
})

// ---------------------------------------------------------------------------

describe('verdict', () => {
  /** The next version recorded, and the critic's verdict call on it. */
  async function judged() {
    const { version } = asOk(await call({ kind: 'proposal', text: PROSE, gates: GATES }, 'au'))
    return call({ kind: 'verdict', version, criteria: pass(['C1', 'C2', 'B1']), overall: 'APPROVED' }, 'cr')
  }
  const stored = async () => (await records()).filter(r => r.kind === 'verdict')

  test('with the tree as the base left it, source_changed is false, and the tree is recorded', async () => {
    const base = await makeRun()
    asOk(await judged())
    const [v] = await stored()
    expect(v!.body.source_changed).toBe(false)
    expect(v!.body.tree).toBe((await git('rev-parse', `${base}^{tree}`)).trim())
    expect(v!.body.sha256).toBe(await sha256(readFileSync(proposalPath(dir(), 'v1'), 'utf8')))
  })

  test('an edit to a tracked file after the base makes it true', async () => {
    const base = await makeRun()
    writeFileSync(join(repo, 'README.md'), 'edited\n')
    asOk(await judged())
    const [v] = await stored()
    expect(v!.body.source_changed).toBe(true)
    expect(v!.body.tree).not.toBe((await git('rev-parse', `${base}^{tree}`)).trim())
  })

  test('a new untracked file after the base makes it true', async () => {
    await makeRun()
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    asOk(await judged())
    expect((await stored())[0]!.body.source_changed).toBe(true)
  })

  test("uncommitted work at launch is part of base, so it alone doesn't", async () => {
    writeFileSync(join(repo, 'README.md'), 'uncommitted\n')
    writeFileSync(join(repo, 'wip.txt'), 'untracked at launch\n')
    await makeRun()
    asOk(await judged())
    expect((await stored())[0]!.body.source_changed).toBe(false)
  })

  test("a change under .claude/litter or .claude/worktrees, or an ignored file, doesn't", async () => {
    writeFileSync(join(repo, '.gitignore'), '*.log\n')
    await git('add', '.gitignore')
    await git('commit', '-q', '-m', 'ignore logs')
    await makeRun()
    writeFileSync(join(repo, 'debug.log'), 'ignored\n')
    mkdirSync(join(repo, '.claude', 'worktrees', 'w1'), { recursive: true })
    writeFileSync(join(repo, '.claude', 'worktrees', 'w1', 'a.txt'), 'a worktree\n')
    writeFileSync(join(litterDir, 'scratch.txt'), "the mod's\n")
    asOk(await judged())
    expect((await stored())[0]!.body.source_changed).toBe(false)
  })

  test("a failed snapshot or base refuses with git's error, and records nothing", async () => {
    await makeRun({}, { checkout: join(root, 'gone') })
    const e = asError(await judged())
    expect(e.error).toContain("the checkout's snapshot failed")
    expect(e.error).toContain('gone')
    expect(e.error).toContain('nothing was recorded')
    expect(await stored()).toEqual([])
    expect(existsSync(outPath(litterDir, 'cr'))).toBe(false)

    await makeRun({}, { base: 'f'.repeat(40) })
    const b = asError(await judged())
    expect(b.error).toContain(`git rev-parse ${'f'.repeat(40)}^{tree} failed`)
    expect(await stored()).toEqual([])

    await makeRun({}, { checkout: undefined })
    expect(asError(await judged()).error).toContain('names no checkout and base')
    expect(await stored()).toEqual([])
  })

  test("a non-PASS criterion needs its gap_kind, and each criterion its evidence and the schema's types", async () => {
    await makeRun()
    await call({ kind: 'proposal', text: PROSE, gates: GATES }, 'au')
    const verdict = (criteria: unknown[]) => call({ kind: 'verdict', version: 'v1', criteria, overall: 'HOLDING' }, 'cr')
    const [c1, c2, b1] = pass(['C1', 'C2', 'B1'])
    const noKind = asError(await verdict([c1, { ...c2, verdict: 'FAIL' }, b1]))
    expect(noKind.field).toBe('criteria[1].gap_kind')
    expect(noKind.allowed).toEqual(GAP_KINDS)
    expect(noKind.error).toContain("isn't PASS")
    expect(asError(await verdict([c1, c2, { ...b1, verdict: 'CONDITIONAL', gap_kind: 'later' }])).field).toBe('criteria[2].gap_kind')
    expect(asError(await verdict([c1, c2, { ...b1, gap_kind: 'later' }])).field).toBe('criteria[2].gap_kind')
    expect(asError(await verdict([{ id: 'C1', verdict: 'PASS' }, c2, b1])).field).toBe('criteria[0].evidence')
    expect(asError(await verdict([c1, { ...c2, reversed: 'yes' }, b1])).field).toBe('criteria[1].reversed')
    expect(asError(await verdict([c1, { ...c2, kept_from: 1 }, b1])).field).toBe('criteria[1].kept_from')
    expect(await stored()).toEqual([])
    asOk(await verdict([c1, { ...c2, verdict: 'CONDITIONAL', gap_kind: 'wording', gap_or_reason: 'no timeout stated' }, b1]))
  })

  test('the out file carries the recorded version, source_changed, criteria and overall', async () => {
    await makeRun()
    writeFileSync(join(repo, 'new.txt'), 'new\n')
    await call({ kind: 'proposal', text: PROSE, gates: GATES }, 'au')
    const criteria = [
      { id: 'C1', verdict: 'PASS', evidence: 'src/a.py:1', kept_from: 'v1', note: 'not in the schema' },
      { id: 'C2', verdict: 'FAIL', evidence: 'none found', gap_or_reason: 'no fallback', gap_kind: 'design', reversed: true },
      { id: 'B1', verdict: 'PASS', evidence: 'grep' },
    ]
    const r = asOk(await call({ kind: 'verdict', version: 'v1', criteria, overall: 'HOLDING' }, 'cr'))
    expect(r.warnings).toBeUndefined()
    const { note: _note, ...c1 } = criteria[0]!
    expect(outOf('cr')).toEqual({ v: 1, agent_id: 'cr', for: { version: 'v1' }, fields: { version: 'v1', source_changed: true, criteria: [c1, criteria[1], criteria[2]], overall: 'HOLDING' } })
    // The record keeps what the critic sent.
    expect((await stored())[0]!.body.criteria).toEqual(criteria)
  })

  test('verdicts/vN.md is written from the record', async () => {
    await makeRun()
    await call({ kind: 'proposal', text: PROSE, gates: GATES }, 'au')
    const sha = await sha256(readFileSync(proposalPath(dir(), 'v1'), 'utf8'))
    asOk(await call({ kind: 'verdict', version: 'v1', criteria: [...pass(['C1', 'C2']), { id: 'B1', verdict: 'FAIL', evidence: 'x | y', gap_kind: 'user' }], overall: 'HOLDING' }, 'cr'))
    const file = readFileSync(designVerdictPath(dir(), 'v1'), 'utf8')
    expect(file).toContain('# Verdict on v1')
    expect(file).toContain(`- Version: v1, sha256 ${sha}`)
    expect(file).toContain("- Source changed: no: the checkout's tree")
    expect(file).toContain('- Overall: HOLDING on B1')
    expect(file).toContain('| B1 | FAIL |  | x \\| y | user |  |')
  })

  test("a verdict file or out file that can't be written leaves the verdict recorded, logged and, for the out file, warned", async () => {
    await makeRun()
    await call({ kind: 'proposal', text: PROSE, gates: GATES }, 'au')
    // A file where each folder should be.
    writeFileSync(join(dir(), 'verdicts'), 'in the way\n')
    const outDir = join(hooksDir(litterDir), 'out')
    await p.run(['rm', '-rf', '--', outDir])
    writeFileSync(outDir, 'in the way\n')
    const r = asOk(await call({ kind: 'verdict', version: 'v1', criteria: pass(['C1', 'C2', 'B1']), overall: 'APPROVED' }, 'cr'))
    expect(r.warnings).toEqual(['litter: the verdict on v1 is recorded, but its observed fields couldn\'t be written; return your result anyway'])
    expect((await stored()).length).toBe(1)
    expect(p.logs.some(l => l.includes('verdict 20261004-records v1: verdicts/v1.md not written'))).toBe(true)
    expect(p.logs.some(l => l.includes('verdict 20261004-records v1: out file not written'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------

describe('probe', () => {
  test('each refusal names its field, and records nothing', async () => {
    await makeRun()
    const probe = { kind: 'probe', unknown_id: 'U1', report: '## Result\nconfirmed', verdict: 'confirmed' }
    expect(asError(await call({ ...probe, report: ' ' }, 'pr')).field).toBe('report')
    for (const unknown_id of [undefined, 'u1', 'U0', 'U01', '../U1', 'U1/', 1]) {
      const e = asError(await call({ ...probe, unknown_id }, 'pr'))
      expect(e.field).toBe('unknown_id')
      expect(e.error).toContain('like U1')
    }
    for (const verdict of [undefined, 'Confirmed', 'maybe']) {
      const e = asError(await call({ ...probe, verdict }, 'pr'))
      expect(e.field).toBe('verdict')
      expect(e.allowed).toEqual(PROBE_VERDICTS)
    }
    expect(await records()).toEqual([])
  })

  test('stored as given; probes/U1.md comes from the latest record for U1', async () => {
    await makeRun()
    const first = asOk(await call({ kind: 'probe', unknown_id: 'U1', report: 'first run: untested, no network', verdict: 'untested' }, 'pr'))
    expect(first).toEqual({ ok: true, kind: 'probe', run: RUN, seq: 1 })
    asOk(await call({ kind: 'probe', unknown_id: 'U2', report: 'U2 holds', verdict: 'confirmed' }, 'pr'))
    asOk(await call({ kind: 'probe', unknown_id: 'U1', report: '## Commands\ncurl -I\n\n## Verdict\nrefuted', verdict: 'refuted', commands: ['curl -I'] }, 'pr'))
    expect((await records()).map(r => r.body)).toEqual([
      { unknown_id: 'U1', report: 'first run: untested, no network', verdict: 'untested' },
      { unknown_id: 'U2', report: 'U2 holds', verdict: 'confirmed' },
      { unknown_id: 'U1', report: '## Commands\ncurl -I\n\n## Verdict\nrefuted', verdict: 'refuted', commands: ['curl -I'] },
    ])
    const u1 = readFileSync(probePath(dir(), 'U1'), 'utf8')
    expect(u1).toContain('- Verdict: refuted')
    expect(u1).toContain('- Ledger seq: 3')
    expect(u1).toContain('## Commands\ncurl -I\n\n## Verdict\nrefuted\n')
    expect(u1).not.toContain('first run')
    expect(readFileSync(probePath(dir(), 'U2'), 'utf8')).toContain('U2 holds')
  })
})
