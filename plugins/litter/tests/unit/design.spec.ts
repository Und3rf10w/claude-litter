// Tier 2: the kinds the record tool validates itself (records/design.ts), each
// through the dispatcher as a role or a launcher calls it: the fields, the
// versions, the bar, the bindings, the files written.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readFileSync } from 'node:fs'
import type { Policy } from '../../hooks/hookfiles'
import type { RecordError, RecordOk, RecordReply } from '../../hooks/records/core'
import { dispatchRecord, type DispatchEnv } from '../../hooks/ledger'
import { readLedger } from '../../hooks/ledgercore'
import { agentPolicyPath, outPath, proposalPath, runDir, runJsonPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { consumeAgents, writePolicy } from '../../hooks/policy'
import { sha256 } from '../../hooks/fsx'
import { bareBacktickPaths, KIND_RULES, KNOWN_KINDS, MOD_ONLY_KINDS, recordGeneric } from '../../hooks/records/design'
import { wikiPath } from '../../hooks/layout'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const RUN = '20261002-design'

let p: TestPorts
let dir: string
let cleanup: () => void
let env: DispatchEnv

beforeEach(async () => {
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
  env = { litterDir: dir, litterDirError: null, ready: true, options: normalizeOptions(undefined) }
  await makeRun({})
  await writePolicy(p, dir, policyFor(RUN))
})
afterEach(() => cleanup())

function policyFor(run: string): Policy {
  return {
    v: 1,
    session: 'test-session',
    litterDir: dir,
    run: {
      run,
      workflow: 'design',
      runDir: runDir(dir, run),
      checkout: dir,
      base: '0'.repeat(40),
      runIds: [],
      launching: false,
      stopping: false,
      inflight: null,
      isolationLost: false,
      roots: { checkout: dir, litterDir: dir, litterCopies: [dir], ruleDirs: [], worktrees: [] },
      setup: null,
      linkDirs: [],
    },
    roles: {},
    swarm: null,
  }
}

async function makeRun(args: Record<string, unknown>) {
  await p.fs.write(runJsonPath(runDir(dir, RUN)), `${JSON.stringify({ v: 1, run: RUN, workflow: 'design', args, ref: `litter/${RUN}` })}\n`)
}

async function startAgent(id: string, role: string, cwd = `/work/${id}`) {
  await consumeAgents(
    { p, litterDir: dir, sessionId: 'test-session' },
    { v: 1, ev: 'start', ts: 1_700_000_000, session_id: 'test-session', agent_id: id, agent_type: `litter:${role}`, cwd, transcript_path: '/t' },
  )
}

const call = (fields: Record<string, unknown>, agentId?: string) => dispatchRecord(p, agentId, fields, env)

const asError = (r: RecordReply) => {
  expect(r.ok).toBe(false)
  return r as RecordError
}

const asOk = (r: RecordReply) => {
  expect(r.ok).toBe(true)
  return r as RecordOk
}

const records = async () => (await readLedger(p, runDir(dir, RUN), RUN)).records

describe('KIND_RULES', () => {
  test("covers every kind, and the mod-only kinds are the mod's", () => {
    expect(Object.keys(KIND_RULES).sort()).toEqual([...KNOWN_KINDS].sort())
    for (const k of MOD_ONLY_KINDS) expect(KIND_RULES[k].by).toBe('mod')
    for (const k of KNOWN_KINDS) if (KIND_RULES[k].by === 'mod') expect(MOD_ONLY_KINDS).toContain(k)
  })

  test('recordGeneric refuses a mod-only kind that reaches it', async () => {
    const r = await recordGeneric({ p, caller: { agentId: null, agentType: null }, litterDir: dir, options: env.options }, { kind: 'land.intent', run: RUN })
    expect(asError(r).field).toBe('kind')
  })
})

describe("the investigators' reports", () => {
  for (const [kind, role] of [['finding', 'falsifier'], ['coverage', 'coverage'], ['mechanism', 'mechanism'], ['probe', 'prober'], ['reframe', 'reframer']] as const) {
    test(`${kind}: report is required, then stored with its author`, async () => {
      await startAgent('a1', role)
      expect(asError(await call({ kind }, 'a1')).field).toBe('report')
      expect(asError(await call({ kind, report: '   ' }, 'a1')).field).toBe('report')
      const r = await call({ kind, report: '## Result\nnothing', confidence: 'high' }, 'a1')
      expect(r).toEqual(expect.objectContaining({ ok: true, kind, run: RUN, seq: 1 }))
      const [rec] = await records()
      expect(rec!.body).toEqual({ report: '## Result\nnothing', confidence: 'high' })
      expect(rec!.by).toEqual({ source: 'agent', agentId: 'a1', agentType: `litter:${role}` })
    })
  }
})

describe('proposal', () => {
  test('text is required, and gates are refused until design runs render them', async () => {
    await startAgent('au', 'author')
    expect(asError(await call({ kind: 'proposal' }, 'au')).field).toBe('text')
    expect(asError(await call({ kind: 'proposal', text: 'x', gates: [{ id: 'G1' }] }, 'au')).field).toBe('gates')
    expect(asError(await call({ kind: 'proposal', text: 'x', delta: 5 }, 'au')).field).toBe('delta')
  })

  test('versions are assigned in order; the text goes to proposals/vN.md and the out file', async () => {
    await startAgent('au', 'author')
    const r1 = await call({ kind: 'proposal', text: 'first', delta: [] }, 'au')
    const r2 = await call({ kind: 'proposal', text: 'second', delta: ['changed it'] }, 'au')
    expect(r1).toEqual(expect.objectContaining({ ok: true, version: 'v1', sha256: await sha256('first') }))
    expect(r2).toEqual(expect.objectContaining({ ok: true, version: 'v2', sha256: await sha256('second') }))
    expect(readFileSync(proposalPath(runDir(dir, RUN), 'v1'), 'utf8')).toBe('first')
    expect(readFileSync(proposalPath(runDir(dir, RUN), 'v2'), 'utf8')).toBe('second')
    const out = JSON.parse(readFileSync(outPath(dir, 'au'), 'utf8'))
    expect(out).toEqual({ v: 1, agent_id: 'au', for: { version: 'v2' }, fields: { version: 'v2', proposal: 'second' } })
    const body = (await records())[1]!.body
    expect(body).toEqual(expect.objectContaining({ version: 'v2', sha256: await sha256('second'), text: 'second' }))
  })

  test('concurrent proposals never share a version', async () => {
    await startAgent('au', 'author')
    const rs = await Promise.all(['a', 'b', 'c'].map(text => call({ kind: 'proposal', text }, 'au')))
    expect(rs.map(r => asOk(r).version).sort()).toEqual(['v1', 'v2', 'v3'])
  })

  test('bare backticked paths get a warning, and the proposal is still recorded', async () => {
    await startAgent('au', 'author')
    const text = 'See `hooks/ledger.ts:12` and `README.md`.\n\n```\n`in/fence.ts`\n```\nLinked: [`a/b.ts`](a/b.ts), and `--flag`.'
    const warnings = asOk(await call({ kind: 'proposal', text }, 'au')).warnings as string[]
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('hooks/ledger.ts:12')
    expect(warnings[0]).toContain('README.md')
    expect(warnings[0]).not.toContain('in/fence.ts')
    expect(warnings[0]).not.toContain('a/b.ts')
    expect(warnings[0]).toContain('[label](path)')
  })

  test('bareBacktickPaths', () => {
    expect(bareBacktickPaths('`src/a.ts` `x` `foo.py` `npm test`\n    `indented/code.ts`')).toEqual(['src/a.ts', 'foo.py'])
    expect(bareBacktickPaths('~~~\n`a/b`\n~~~\n`c/d`')).toEqual(['c/d'])
  })
})

describe('verdict', () => {
  const criteria = (ids: string[], verdict = 'PASS') => ids.map(id => ({ id, verdict }))

  test('needs a proposal, and must name the latest version', async () => {
    await startAgent('cr', 'design-critic')
    await startAgent('au', 'author')
    expect(asError(await call({ kind: 'verdict', version: 'v1', criteria: criteria(['C1']), overall: 'APPROVED' }, 'cr')).field).toBe('version')
    await call({ kind: 'proposal', text: 'one' }, 'au')
    await call({ kind: 'proposal', text: 'two' }, 'au')
    const e = asError(await call({ kind: 'verdict', version: 'v1', criteria: criteria(['C1']), overall: 'APPROVED' }, 'cr'))
    expect(e.field).toBe('version')
    expect(e.allowed).toEqual(['v2'])
  })

  test('criteria and overall are checked, and the bar is covered exactly once', async () => {
    await makeRun({ bar: [{ id: 'C1' }, { id: 'C2' }, { id: 'B1' }] })
    await startAgent('cr', 'design-critic')
    await startAgent('au', 'author')
    await call({ kind: 'proposal', text: 'one' }, 'au')
    const base = { kind: 'verdict', version: 'v1', overall: 'HOLDING' }
    expect(asError(await call({ ...base }, 'cr')).allowed).toEqual(['C1', 'C2', 'B1'])
    expect(asError(await call({ ...base, criteria: [{ id: 'C1', verdict: 'MAYBE' }] }, 'cr')).allowed).toEqual(['PASS', 'CONDITIONAL', 'FAIL'])
    expect(asError(await call({ ...base, criteria: [{ verdict: 'PASS' }] }, 'cr')).field).toBe('criteria[0].id')
    expect(asError(await call({ ...base, overall: 'GOOD', criteria: criteria(['C1', 'C2', 'B1']) }, 'cr')).allowed).toEqual(['APPROVED', 'HOLDING'])
    const missing = asError(await call({ ...base, criteria: criteria(['C1', 'C1', 'X9']) }, 'cr'))
    expect(missing.field).toBe('criteria')
    expect(missing.error).toContain('missing C2, B1')
    expect(missing.error).toContain('repeated C1')
    expect(missing.error).toContain('not in the bar X9')
    const approved = asError(await call({ ...base, overall: 'APPROVED', criteria: [...criteria(['C1', 'C2']), { id: 'B1', verdict: 'FAIL' }] }, 'cr'))
    expect(approved.field).toBe('overall')
  })

  test("stored with the judged version's sha256", async () => {
    await startAgent('cr', 'design-critic')
    await startAgent('au', 'author')
    await call({ kind: 'proposal', text: 'one' }, 'au')
    const r = await call({ kind: 'verdict', version: 'v1', criteria: criteria(['C1']), overall: 'APPROVED' }, 'cr')
    expect(r.ok).toBe(true)
    const v = (await records()).find(x => x.kind === 'verdict')!
    expect(v.body.sha256).toBe(await sha256('one'))
  })
})

describe('rule.propose', () => {
  test('from the launcher, stored with the run and its source', async () => {
    expect(asError(await call({ kind: 'rule.propose', run: RUN })).field).toBe('rule')
    expect(asError(await call({ kind: 'rule.propose', run: RUN, rule: 'x'.repeat(9000) })).field).toBe('rule')
    expect(asError(await call({ kind: 'rule.propose', run: RUN, rule: 'r', edits: 'nope' })).field).toBe('edits')
    const r = await call({ kind: 'rule.propose', run: RUN, rule: 'When touching hooks, run tier 3.' })
    expect(r.ok).toBe(true)
    expect((await records())[0]!.body).toEqual({ rule: 'When touching hooks, run tier 3.', source: 'user' })
  })

  test('without a run it waits for the rules ledger', async () => {
    expect(asError(await call({ kind: 'rule.propose', rule: 'r' })).field).toBe('run')
  })

  test("from a run's agent, the run is its own", async () => {
    await startAgent('gc', 'gate-critic')
    const r = await call({ kind: 'rule.propose', rule: 'r' }, 'gc')
    expect(r).toEqual(expect.objectContaining({ ok: true, run: RUN }))
    expect((await records())[0]!.body.source).toBe('agent')
  })
})

describe('task.bind', () => {
  // The binding's cases, against recorded worktrees, are in bind.spec.ts.
  test("needs a cwd that's one of the run's recorded worktrees", async () => {
    await makeRun({ tasks: [{ id: 'T1', bind: 'tok-1', files: ['a.ts'] }] })
    await startAgent('w1', 'executor', '/wt/one')
    expect(asError(await call({ kind: 'task.bind', token: 'tok-1' }, 'w1')).error).toContain("isn't one of this run's worktrees")
    expect(existsSync(agentPolicyPath(dir, 'w1'))).toBe(false)
    expect(JSON.parse(readFileSync(outPath(dir, 'w1'), 'utf8')).fields.bind_refusal).toContain('/wt/one')
  })
})

describe("the launchers' kinds", () => {
  test('plan.write checks each gate', async () => {
    expect(asError(await call({ kind: 'plan.write', run: RUN })).field).toBe('gates')
    expect(asError(await call({ kind: 'plan.write', run: RUN, gates: [{ id: 'gate1', title: 't' }] })).field).toBe('gates[0].id')
    expect(asError(await call({ kind: 'plan.write', run: RUN, gates: [{ id: 'G1', title: 't' }, { id: 'G1', title: 'u' }] })).field).toBe('gates[1].id')
    expect(asError(await call({ kind: 'plan.write', run: RUN, gates: [{ id: 'G1' }] })).field).toBe('gates[0].title')
    // A gate needs its Files, Checks and Done when, and plan.write a plan run: plan.spec.ts writes one.
    expect(asError(await call({ kind: 'plan.write', run: RUN, gates: [{ id: 'G1', title: 'Parse' }, { id: 'G2', title: 'Wire' }] })).field).toBe('gates[0].files')
  })

  test('gate.amend needs the gate, the new text and why', async () => {
    expect(asError(await call({ kind: 'gate.amend', run: RUN, gate: 'two' })).field).toBe('gate')
    expect(asError(await call({ kind: 'gate.amend', run: RUN, gate: 'G2', reason: 'r' })).field).toBe('after')
    expect(asError(await call({ kind: 'gate.amend', run: RUN, gate: 'G2', after: 'a' })).field).toBe('reason')
    expect(asError(await call({ kind: 'gate.amend', run: RUN, gate: 'G2', after: 'a', reason: 'r', before: 3 })).field).toBe('before')
    // 'after' must be the gate's section, of an execute run's plan: plan.spec.ts amends one.
    expect(asError(await call({ kind: 'gate.amend', run: RUN, gate: 'G2', after: 'a', reason: 'r' })).field).toBe('after')
  })

  test('design.feedback needs the feedback', async () => {
    expect(asError(await call({ kind: 'design.feedback', run: RUN })).field).toBe('feedback')
    expect((await call({ kind: 'design.feedback', run: RUN, feedback: 'tighter' })).ok).toBe(true)
  })

  test('wiki.write writes WIKI.md whole, with no run', async () => {
    expect(asError(await call({ kind: 'wiki.write' })).field).toBe('content')
    const r = await call({ kind: 'wiki.write', content: '# Wiki\n' })
    expect(r).toEqual({ ok: true, kind: 'wiki.write', path: wikiPath(dir) })
    expect(readFileSync(wikiPath(dir), 'utf8')).toBe('# Wiki\n')
    expect(await records()).toEqual([])
  })
})
