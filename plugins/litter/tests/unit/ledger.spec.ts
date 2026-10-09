// Tier 2: the record tool's dispatcher (plan section 9, "Ledger"): the kind
// check, who may record what, the run, the bounds, the error shape, and the
// catch. The kinds' own bodies are in design.spec.ts.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Policy } from '../../hooks/hookfiles'
import type { RecordError, RecordReply } from '../../hooks/records/core'
import { dispatchRecord, RECORD_TOOL, recordFailed, registerRecordTool, type DispatchEnv } from '../../hooks/ledger'
import { appendRecord, readLedger } from '../../hooks/ledgercore'
import { ledgerDir, runDir, runJsonPath, spoolPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { agentInfo, consumeAgents, writePolicy } from '../../hooks/policy'
import { KNOWN_KINDS, MOD_ONLY_KINDS } from '../../hooks/records/design'
import { RECORD_MAX_BYTES } from '../../hooks/records/core'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'

const RUN = '20261002-sample'

let p: TestPorts
let dir: string
let cleanup: () => void
let env: DispatchEnv

beforeEach(async () => {
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
  env = { litterDir: dir, litterDirError: null, ready: true, options: normalizeOptions(undefined) }
  await makeRun(RUN)
})
afterEach(() => cleanup())

function policyFor(run: string | null, session = 'test-session'): Policy {
  return {
    v: 1,
    session,
    litterDir: dir,
    run: run
      ? {
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
        }
      : null,
    roles: {},
    swarm: null,
  }
}

async function makeRun(run: string, args: Record<string, unknown> = {}) {
  await p.fs.write(runJsonPath(runDir(dir, run)), `${JSON.stringify({ v: 1, run, workflow: 'design', args, ref: `litter/${run}` })}\n`)
}

/** An agent of `type` started while `run` was active, as its spooled start would map it. */
async function startAgent(id: string, type: string, run: string | null = RUN, cwd = '/work/a') {
  await writePolicy(p, dir, policyFor(run))
  await consumeAgents(
    { p, litterDir: dir, sessionId: 'test-session' },
    { v: 1, ev: 'start', ts: 1_700_000_000, session_id: 'test-session', agent_id: id, agent_type: type, cwd, transcript_path: '/t' },
  )
}

const call = (fields: Record<string, unknown>, agentId?: string) =>
  dispatchRecord(p, agentId, { tool: 'mcp__litter__record', tool_use_id: 'tu1', ...fields }, env)

const asError = (r: RecordReply) => {
  expect(r.ok).toBe(false)
  return r as RecordError
}

const ledgerFiles = (run = RUN) => (existsSync(ledgerDir(runDir(dir, run))) ? readdirSync(ledgerDir(runDir(dir, run))) : [])

describe('the spec', () => {
  test('names the tool record, takes a kind, and describes kind and run', async () => {
    expect(RECORD_TOOL.name).toBe('record')
    const schema = RECORD_TOOL.inputSchema as { properties: Record<string, { description?: string }>; required: string[] }
    expect(schema.required).toEqual(['kind'])
    expect(schema.properties.kind?.description).toBeTruthy()
    expect(schema.properties.run?.description).toBeTruthy()
  })

  test("declares every field that isn't a string, with its type", () => {
    const schema = RECORD_TOOL.inputSchema as { properties: Record<string, { type?: string }>; additionalProperties?: boolean }
    expect(schema.properties.authorized?.type).toBe('array')
    expect(schema.properties.tasks?.type).toBe('array')
    expect(schema.properties.amendOf?.type).toBe('object')
    expect(schema.properties.adversary?.type).toBe('boolean')
    // run.find's opt-in (design D9): a model's "true" is decoded before the handler's check.
    expect(schema.properties.options?.type).toBe('boolean')
    expect(schema.properties.maxAttempts?.type).toBe('integer')
    expect(schema.additionalProperties).toBe(true)
  })

  test('a structured field sent as the JSON of its type is decoded; any other string is left for the handler', async () => {
    await startAgent('a1', 'litter:falsifier')
    const r = await call(
      { kind: 'finding', report: '["kept"]', anchors: '["a", "b"]', amendOf: '{"run": "x"}', adversary: 'true', attempt: '2', tasks: '{"not": "a list"}', maxRounds: 'three' },
      'a1',
    )
    expect(r.ok).toBe(true)
    const body = (await readLedger(p, runDir(dir, RUN), RUN)).records.at(-1)!.body
    expect(body).toEqual(
      expect.objectContaining({ report: '["kept"]', anchors: ['a', 'b'], amendOf: { run: 'x' }, adversary: true, attempt: 2, tasks: '{"not": "a list"}', maxRounds: 'three' }),
    )
  })

  test('registerRecordTool resolves null, or the refusal', async () => {
    expect(await registerRecordTool(p)).toBeNull()
    p.registerTool = async () => {
      throw new Error('allowedMcpServers (managed): plugins outside policy may not add tools')
    }
    expect(await registerRecordTool(p)).toContain('allowedMcpServers')
  })
})

describe('kind', () => {
  test('missing or not a string: field kind, with the kinds this caller may record', async () => {
    for (const kind of [undefined, '', 7]) {
      const e = asError(await call({ kind }))
      expect(e.field).toBe('kind')
      expect(e.allowed).toContain('run.start')
      expect(e.allowed).not.toContain('finding')
    }
    await startAgent('a1', 'litter:falsifier')
    const e = asError(await call({}, 'a1'))
    expect(e.allowed).toContain('finding')
    expect(e.allowed).not.toContain('run.start')
  })

  test('unknown: field kind, allowed values, nothing written', async () => {
    const e = asError(await call({ kind: 'findings' }))
    expect(e.field).toBe('kind')
    expect(e.error).toContain('findings')
    expect(e.allowed!.length).toBeGreaterThan(0)
    expect(ledgerFiles()).toEqual([])
  })

  test('matches case-insensitively and stores the canonical spelling', async () => {
    await startAgent('a1', 'litter:falsifier')
    const r = await call({ kind: '  FiNdInG ', report: '## Result\nnone' }, 'a1')
    expect(r).toEqual(expect.objectContaining({ ok: true, kind: 'finding', run: RUN, seq: 1 }))
    expect(ledgerFiles()).toEqual(['000001-finding.json'])
    expect(asError(await call({ kind: 'RUN.FIND', run: 'nope' })).field).toBe('run')
  })

  test('every mod-only kind is refused, from the main thread and from an agent', async () => {
    await startAgent('a1', 'litter:relay')
    for (const kind of MOD_ONLY_KINDS) {
      for (const agentId of [undefined, 'a1']) {
        const e = asError(await call({ kind: kind.toUpperCase(), run: RUN }, agentId))
        expect(e.field).toBe('kind')
        expect(e.error).toContain('litter itself')
      }
    }
    expect(ledgerFiles()).toEqual([])
  })

  test("the rule steps that are the user's are refused whoever calls", async () => {
    await startAgent('a1', 'litter:gate-critic')
    for (const kind of ['rule.accept', 'Rule.Dismiss', 'rule.retire']) {
      for (const agentId of [undefined, 'a1']) {
        const e = asError(await call({ kind, run: RUN }, agentId))
        expect(e.field).toBe('kind')
        expect(e.allowed).toEqual(['rule.propose', 'rule.open'])
      }
    }
  })

  test("an agent's kind from the main thread, and a launcher's from an agent, name kind", async () => {
    const e1 = asError(await call({ kind: 'finding', report: 'x' }))
    expect(e1.field).toBe('kind')
    expect(e1.error).toContain('agents')
    await startAgent('a1', 'litter:executor')
    const e2 = asError(await call({ kind: 'run.start', workflow: 'execute' }, 'a1'))
    expect(e2.field).toBe('kind')
    expect(e2.error).toContain('main thread')
    expect(e2.allowed).toContain('task.bind')
  })

  test('KNOWN_KINDS has no duplicates, case-insensitively', () => {
    expect(new Set(KNOWN_KINDS.map(k => k.toLowerCase())).size).toBe(KNOWN_KINDS.length)
  })
})

describe('the caller', () => {
  test("an agent the map doesn't know is refused", async () => {
    const e = asError(await call({ kind: 'finding', report: 'x' }, 'ghost'))
    expect(e.error).toContain("isn't one")
    expect(ledgerFiles()).toEqual([])
  })

  test('an agent that is no litter role, or has no run, is refused', async () => {
    await startAgent('gp', 'general-purpose')
    expect(asError(await call({ kind: 'finding', report: 'x' }, 'gp')).error).toContain('general-purpose')
    await startAgent('late', 'litter:falsifier', null)
    expect(asError(await call({ kind: 'finding', report: 'x' }, 'late')).ok).toBe(false)
  })

  test('an unmapped agent whose start is still in the spool is drained once, then identified', async () => {
    await writePolicy(p, dir, policyFor(RUN))
    const line = { v: 1, ev: 'start', ts: 1_700_000_000, session_id: 'test-session', agent_id: 'a9', agent_type: 'litter:coverage', cwd: '/w', transcript_path: '/t' }
    await p.fs.write(spoolPath(dir, 'test-session'), `${JSON.stringify(line)}\n`)
    const r = await call({ kind: 'coverage', report: 'matrix' }, 'a9')
    expect(r.ok).toBe(true)
    const { records } = await readLedger(p, runDir(dir, RUN), RUN)
    expect(records[0]!.by).toEqual({ source: 'agent', agentId: 'a9', agentType: 'litter:coverage' })
    expect(existsSync(spoolPath(dir, 'test-session'))).toBe(false)
  })

  test('every record call drains the spool first, whoever calls', async () => {
    await startAgent('a1', 'litter:falsifier')
    const stop = { v: 1, ev: 'stop', ts: 1_700_000_005, session_id: 'test-session', agent_id: 'a1', agent_type: 'litter:falsifier', transcript_path: '/t', stop_hook_active: false, background_tasks: 0 }
    await p.fs.write(spoolPath(dir, 'test-session'), `${JSON.stringify(stop)}\n`)
    await call({ kind: 'run.find' })
    expect((await agentInfo(p, 'a1'))?.stopped).toBe(1_700_000_005_000)
  })

  test('the main thread records as the launcher', async () => {
    const r = await call({ kind: 'design.feedback', run: RUN, feedback: 'more tests' })
    expect(r.ok).toBe(true)
    const { records } = await readLedger(p, runDir(dir, RUN), RUN)
    expect(records[0]!.by).toEqual({ source: 'launcher' })
  })

  test("tool.call's own keys never reach the record", async () => {
    await call({ kind: 'design.feedback', run: RUN, feedback: 'f', consent: 'The user pressed', agentId: 'x' })
    const { records } = await readLedger(p, runDir(dir, RUN), RUN)
    expect(Object.keys(records[0]!.body).sort()).toEqual(['feedback'])
  })
})

describe('the run', () => {
  test("an agent's run comes from the map; naming another is refused with its own", async () => {
    await startAgent('a1', 'litter:falsifier')
    const e = asError(await call({ kind: 'finding', run: '20261002-other', report: 'x' }, 'a1'))
    expect(e.field).toBe('run')
    expect(e.allowed).toEqual([RUN])
    expect((await call({ kind: 'finding', run: RUN, report: 'x' }, 'a1')).ok).toBe(true)
  })

  test("a launcher's run must be a run id that exists", async () => {
    for (const run of [undefined, 'not a run', 42, '20261002-missing']) {
      const e = asError(await call({ kind: 'design.feedback', run, feedback: 'f' }))
      expect(e.field).toBe('run')
    }
  })

  test('without a litterDir: still starting, or the reason it has none', async () => {
    env = { ...env, litterDir: null, ready: false }
    expect(asError(await call({ kind: 'run.find' })).error).toContain('still starting')
    env = { ...env, ready: true, litterDirError: "litter: /x isn't inside a git repository" }
    expect(asError(await call({ kind: 'run.find' })).error).toContain("isn't inside a git repository")
  })

  test('a tampered ledger is refused before the handler runs', async () => {
    const rd = runDir(dir, RUN)
    await appendRecord(p, rd, { run: RUN, kind: 'design.feedback', by: { source: 'launcher' }, body: { feedback: 'a' } })
    await appendRecord(p, rd, { run: RUN, kind: 'design.feedback', by: { source: 'launcher' }, body: { feedback: 'b' } })
    const first = join(ledgerDir(rd), '000001-design.feedback.json')
    writeFileSync(first, readFileSync(first, 'utf8').replace('"a"', '"z"'))
    const e = asError(await call({ kind: 'design.feedback', run: RUN, feedback: 'c' }))
    expect(e.field).toBe('run')
    expect(e.error).toContain('tampered')
    expect(ledgerFiles().length).toBe(2)
  })
})

describe('bounds', () => {
  test('a record over 1 MiB names its largest field, and nothing is written', async () => {
    await startAgent('a1', 'litter:falsifier')
    const e = asError(await call({ kind: 'finding', report: 'x'.repeat(RECORD_MAX_BYTES + 10), note: 'short' }, 'a1'))
    expect(e.field).toBe('report')
    expect(e.error).toContain('over the')
    expect(ledgerFiles()).toEqual([])
  })

  test("one that passes the input check but not the stored record's is refused the same way", async () => {
    await startAgent('a1', 'litter:falsifier')
    const e = asError(await call({ kind: 'finding', report: 'x'.repeat(RECORD_MAX_BYTES - 100) }, 'a1'))
    expect(e.field).toBe('report')
    expect(ledgerFiles()).toEqual([])
  })
})

describe('an unbound fanout writer', () => {
  /** run.json for a run of `workflow`. */
  const runOf = (run: string, workflow: string) =>
    p.fs.write(runJsonPath(runDir(dir, run)), `${JSON.stringify({ v: 1, run, workflow, args: { tasks: [{ id: 'T1', bind: 'tok-1', files: ['a/'] }] }, ref: `litter/${run}` })}\n`)
  const propose = (agentId: string) => call({ kind: 'rule.propose', rule: 'When a task owns a folder, keep its tests in it.' }, agentId)

  test('records only task.bind until it has bound, whatever the kind', async () => {
    await runOf(RUN, 'fanout')
    await startAgent('w1', 'litter:executor')
    for (const fields of [{ kind: 'rule.propose', rule: 'r' }, { kind: 'verify', gate: 'G1' }, { kind: 'run.find' }]) {
      const e = asError(await call(fields, 'w1'))
      expect(e.error).toBe('litter: bind first: record kind task.bind with the bind value from your <task>')
      expect(e.field).toBe('kind')
      expect(e.allowed).toEqual(['task.bind'])
    }
    // task.bind gets through to its handler, which judges it on its own terms.
    expect(asError(await call({ kind: 'task.bind', token: 'tok-1' }, 'w1')).error).toContain("isn't one of this run's worktrees")
    await appendRecord(p, runDir(dir, RUN), {
      run: RUN,
      kind: 'task.bind',
      by: { source: 'agent', agentId: 'w1', agentType: 'litter:executor' },
      body: { task: 'T1', worktree: { name: 'n', path: '/work/a', branch: 'b' } },
    })
    expect((await propose('w1')).ok).toBe(true)
  })

  test("another role in a fanout, and an execute run's executor, are unaffected", async () => {
    await runOf(RUN, 'fanout')
    await startAgent('rl', 'litter:relay')
    expect((await propose('rl')).ok).toBe(true)
    const EXEC = '20261002-exec'
    await runOf(EXEC, 'execute')
    await startAgent('ex', 'litter:executor', EXEC)
    expect((await propose('ex')).ok).toBe(true)
  })
})

describe('failures', () => {
  test("a handler's own failure rejects, so the hook's catch denies", async () => {
    await startAgent('a1', 'litter:falsifier')
    const write = p.fs.write
    p.fs.write = async (path, text) => {
      if (path.includes('/ledger/')) throw new Error('disk full')
      return write(path, text)
    }
    await expect(call({ kind: 'finding', report: 'x' }, 'a1')).rejects.toThrow('disk full')
  })

  test('recordFailed denies, naming the hook and the failure', async () => {
    const r = await recordFailed(undefined as never, {} as never, { error: { kind: 'throw', message: 'disk\nfull', budget: 1 } } as never)
    expect(r).toEqual({ deny: 'litter guard failed: mcp__litter__record (disk full); refusing' })
    const t = await recordFailed(undefined as never, {} as never, { error: { kind: 'timeout', budget: 1 } } as never)
    expect(t).toEqual({ deny: 'litter guard failed: mcp__litter__record (timeout); refusing' })
  })
})
