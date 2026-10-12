// Tier 2: the record tool's 2b-2 contracts (WP-V): the dispatcher's pre-route
// of a bound swarm node's verify, verdict and land to swarm/gate.ts (and a
// run agent's, routed as before), the repair kinds' caller rules, the new
// structured fields, and runClosed across a repair generation.

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readdirSync, existsSync } from 'node:fs'
import type { Policy } from '../../hooks/hookfiles'
import type { RecordError, RecordReply, StoredRecord } from '../../hooks/records/core'
import type { NodeBinding } from '../../hooks/swarm/types'
import type { SwarmGateCall } from '../../hooks/swarm/gate'
import * as realGate from '../../hooks/swarm/gate'
import { dispatchRecord, RECORD_TOOL, type DispatchEnv } from '../../hooks/ledger'
import { appendRecord, LedgerTampered, readLedger } from '../../hooks/ledgercore'
import { ledgerDir, runDir, runJsonPath } from '../../hooks/layout'
import { normalizeOptions } from '../../hooks/options'
import { consumeAgents, writePolicy } from '../../hooks/policy'
import { KIND_RULES, KNOWN_KINDS, MOD_ONLY_KINDS } from '../../hooks/records/design'
import { KIND_HANDLERS } from '../../hooks/registry'
import { runClosed } from '../../hooks/verify'
import * as state from '../../hooks/swarm/state'
import { nodePorts, scratch, type TestPorts } from './support/node-ports'
import { startedRunJson } from './support/runjson'

// ---------------------------------------------------------------------------
// The gate's stub, watched: each call is kept, and answered by the real stub
// unless a test sets `answerWith` (restored after this file).

const GATE = '../../hooks/swarm/gate'
const realGateCopy = { ...realGate }
const gateCalls: SwarmGateCall[] = []
let answerWith: ((call: SwarmGateCall) => Promise<RecordReply>) | null = null
mock.module(GATE, () => ({
  ...realGateCopy,
  swarmGateRecord: async (p: unknown, call: SwarmGateCall) => {
    gateCalls.push(call)
    return answerWith ? answerWith(call) : realGateCopy.swarmGateRecord(p as never, call)
  },
}))
afterAll(() => {
  mock.module(GATE, () => realGateCopy)
})

const RUN = '20261002-fan'
const SWARM = 'repair-abc123'

let p: TestPorts
let dir: string
let cleanup: () => void
let env: DispatchEnv

beforeEach(async () => {
  state.resetForTests()
  gateCalls.length = 0
  answerWith = null
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
  env = { litterDir: dir, litterDirError: null, ready: true, options: normalizeOptions(undefined) }
  await p.fs.write(runJsonPath(runDir(dir, RUN)), `${JSON.stringify(RUN_JSON)}\n`)
})

const RUN_JSON = { v: 1, run: RUN, workflow: 'fanout', args: {}, ref: `litter/${RUN}` } as const
/** The run.start that run.json's writer leaves, for a call the run handler reads run.json for. */
const started = () => startedRunJson(p, runDir(dir, RUN), RUN_JSON, `${JSON.stringify(RUN_JSON)}\n`)
afterEach(() => {
  state.resetForTests()
  cleanup()
})

function policyFor(run: string | null): Policy {
  return {
    v: 1,
    session: 'test-session',
    litterDir: dir,
    run: run
      ? {
          run,
          workflow: 'fanout',
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

/** An agent's spooled start, mapped while `run` was active (null: no run, as a swarm node's is). */
async function startAgent(id: string, type: string, run: string | null) {
  await writePolicy(p, dir, policyFor(run))
  await consumeAgents(
    { p, litterDir: dir, sessionId: 'test-session' },
    { v: 1, ev: 'start', ts: 1_700_000_000, session_id: 'test-session', agent_id: id, agent_type: type, cwd: '/work/a', transcript_path: '/t' },
  )
}

function bindNode(agentId: string, node = 'critic', over: Partial<NodeBinding> = {}): NodeBinding {
  const b: NodeBinding = {
    agentId,
    swarm: SWARM,
    launch: '20261002-120000',
    node,
    n: 1,
    kind: 'worker',
    of: null,
    parent: 'orch-1',
    type: `litter:sw-${SWARM}-${node}`,
    cwd: '/work/integration',
    branch: null,
    token: 'tok',
    revision: 1,
    generation: 1,
    boundAt: 1,
    adopted: false,
    ...over,
  }
  state.putBinding(b)
  return b
}

const call = (fields: Record<string, unknown>, agentId?: string) =>
  dispatchRecord(p, agentId, { tool: 'mcp__litter__record', tool_use_id: 'tu1', ...fields }, env)

const asError = (r: RecordReply) => {
  expect(r.ok).toBe(false)
  return r as RecordError
}

const ledgerFiles = () => (existsSync(ledgerDir(runDir(dir, RUN))) ? readdirSync(ledgerDir(runDir(dir, RUN))) : [])

/** The real gate's answer (WP-Y) to a node whose swarm isn't live, as these bindings' isn't. */
const STUB = (kind: string) => `litter: swarm ${SWARM} isn't live, so it records no ${kind}`

describe("a bound swarm node's verify, verdict and land", () => {
  test("go to swarm/gate.ts, which refuses each for a swarm that isn't live, naming kind; nothing is written", async () => {
    await startAgent('node-1', `litter:sw-${SWARM}-critic`, null)
    bindNode('node-1')
    for (const kind of ['verify', 'verdict', 'land', 'VERDICT']) {
      const e = asError(await call({ kind, verify_id: 'v1' }, 'node-1'))
      expect(e).toEqual({ ok: false, field: 'kind', error: STUB(kind.toLowerCase()) })
    }
    expect(gateCalls.map(c => c.kind)).toEqual(['verify', 'verdict', 'land', 'verdict'])
    expect(ledgerFiles()).toEqual([])
  })

  test('the gate gets the kind, the input decoded without the tool fields, the caller, its binding, the litter directory and the options', async () => {
    await startAgent('node-1', `litter:sw-${SWARM}-critic`, null)
    const b = bindNode('node-1')
    answerWith = async () => ({ ok: true, verify_id: 'v7' })
    const r = await call({ kind: 'verdict', verify_id: 'v7', tasks: '[{"id":"T1","pass":true,"evidence":"e","gaps":[]}]', proposed_rules: '["r1"]', run: 'ignored' }, 'node-1')
    expect(r).toEqual({ ok: true, verify_id: 'v7' })
    expect(gateCalls).toHaveLength(1)
    const c = gateCalls[0]!
    expect(c.kind).toBe('verdict')
    expect(c.input).toEqual({
      kind: 'verdict',
      verify_id: 'v7',
      tasks: [{ id: 'T1', pass: true, evidence: 'e', gaps: [] }],
      proposed_rules: ['r1'],
      run: 'ignored',
    })
    expect(c.caller).toEqual({ agentId: 'node-1', agentType: `litter:sw-${SWARM}-critic` })
    expect(c.binding).toEqual(b)
    expect(c.litterDir).toBe(dir)
    expect(c.options).toBe(env.options)
  })

  test('a node the agent map never saw is routed by its binding alone', async () => {
    bindNode('node-2', 'fixer')
    expect(asError(await call({ kind: 'verify' }, 'node-2')).error).toBe(STUB('verify'))
    expect(gateCalls[0]?.caller).toEqual({ agentId: 'node-2', agentType: null })
  })

  test("waits for the state's gate (recovery putting the bindings back), then routes", async () => {
    state.closeGate()
    p.clock.now = 1_000
    let sleeps = 0
    p.onSleep = () => {
      if (++sleeps === 3) {
        bindNode('node-3')
        state.openGate()
      }
    }
    expect(asError(await call({ kind: 'land', verify_id: 'v1' }, 'node-3')).error).toBe(STUB('land'))
    expect(sleeps).toBe(3)
  })

  test("a gate reply that isn't one throws, and a ledger refusal is in the error shape", async () => {
    bindNode('node-1')
    answerWith = async () => undefined as never
    await expect(call({ kind: 'verify' }, 'node-1')).rejects.toThrow('the verify handler gave no reply')
    answerWith = async () => {
      throw new LedgerTampered(4, 'record 000004-verify.json doesn\'t chain to the record before it')
    }
    expect(asError(await call({ kind: 'verify' }, 'node-1')).field).toBe('run')
  })

  test('over the record bound, refused before the gate, naming the largest field', async () => {
    bindNode('node-1')
    const e = asError(await call({ kind: 'verdict', combined: 'x'.repeat(1024 * 1024 + 10) }, 'node-1'))
    expect(e.field).toBe('combined')
    expect(gateCalls).toEqual([])
  })

  test("a node's other kinds are judged as before: it's no run agent", async () => {
    bindNode('node-1')
    expect(asError(await call({ kind: 'finding', report: 'x' }, 'node-1')).error).toContain("isn't one")
    expect(gateCalls).toEqual([])
  })
})

describe("a run agent's", () => {
  test('verify goes to the run handler as before, never the gate', async () => {
    await started()
    await startAgent('v1', 'litter:verifier', RUN)
    const e = asError(await call({ kind: 'verify', gate: 'integration' }, 'v1'))
    expect(e.error).toContain("run.json has no valid base commit")
    expect(gateCalls).toEqual([])
  })

  test('verify goes to the run handler even when a binding names it too', async () => {
    await started()
    await startAgent('v1', 'litter:verifier', RUN)
    bindNode('v1')
    expect(asError(await call({ kind: 'verify', gate: 'integration' }, 'v1')).error).toContain('no valid base commit')
    expect(gateCalls).toEqual([])
  })

  test('an unbound agent of no run is refused as before', async () => {
    await startAgent('gp', 'general-purpose', null)
    expect(asError(await call({ kind: 'verify' }, 'gp')).error).toContain("isn't one")
    expect(gateCalls).toEqual([])
  })

  test("the main thread's verify is refused as an agent's kind, never routed", async () => {
    bindNode('node-1')
    const e = asError(await call({ kind: 'verify', run: RUN }))
    expect(e.field).toBe('kind')
    expect(e.error).toContain("run's agents")
    expect(gateCalls).toEqual([])
  })
})

describe("the repair kinds' caller rules", () => {
  test('run.repair and repair.declined are the mod\'s: refused from the main thread and from an agent, nothing written', async () => {
    await startAgent('a1', 'litter:relay', RUN)
    bindNode('node-1')
    for (const kind of ['run.repair', 'Repair.Declined']) {
      for (const agentId of [undefined, 'a1', 'node-1']) {
        const e = asError(await call({ kind, run: RUN, reason: 'x' }, agentId))
        expect(e.field).toBe('kind')
        expect(e.error).toBe(`litter: '${kind.toLowerCase()}' is recorded by litter itself, never through this tool`)
      }
    }
    expect(MOD_ONLY_KINDS).toEqual(expect.arrayContaining(['run.repair', 'repair.declined']))
    expect(ledgerFiles()).toEqual([])
  })

  test("repair.start is the launcher's, with a run that exists; it reaches the bridge's handler", async () => {
    await startAgent('a1', 'litter:relay', RUN)
    const agent = asError(await call({ kind: 'repair.start' }, 'a1'))
    expect(agent.field).toBe('kind')
    expect(agent.error).toContain('main thread')
    expect(asError(await call({ kind: 'repair.start' })).field).toBe('run')
    expect(asError(await call({ kind: 'repair.start', run: '20261002-nope' })).error).toContain("there's no run 20261002-nope")
    // X's handler (2b-2): this run has no run.start, so its run.json can't be checked, and nothing is recorded.
    expect(asError(await call({ kind: 'repair.start', run: RUN }))).toEqual({
      ok: false,
      field: 'run',
      error: `litter: run ${RUN} has no run.start record`,
    })
    expect(ledgerFiles()).toEqual([])
  })

  test("repair.budget is the launcher's, naming a swarm, with no run resolved; it reaches the bridge's handler", async () => {
    await startAgent('a1', 'litter:relay', RUN)
    bindNode('node-1')
    for (const agentId of ['a1', 'node-1']) expect(asError(await call({ kind: 'repair.budget', swarm: SWARM }, agentId)).error).toContain('main thread')
    // X's handler (2b-2), with the string decoded to an integer: no live swarm has the name, so nothing is asked.
    expect(asError(await call({ kind: 'repair.budget', swarm: SWARM, rounds: '2' }))).toEqual({
      ok: false,
      field: 'swarm',
      error: `litter: swarm ${SWARM} isn't live`,
    })
    expect(p.asked).toEqual([])
  })

  test('the table: each kind with its rule and handler, and who may record it', async () => {
    for (const k of ['run.repair', 'repair.declined', 'repair.start', 'repair.budget'] as const) {
      expect(KNOWN_KINDS).toContain(k)
      expect(KIND_HANDLERS[k]).toBeFunction()
    }
    expect(KIND_RULES['run.repair']).toEqual({ by: 'mod', run: 'required' })
    expect(KIND_RULES['repair.declined']).toEqual({ by: 'mod', run: 'required' })
    expect(KIND_RULES['repair.start']).toEqual({ by: 'launcher', run: 'required' })
    expect(KIND_RULES['repair.budget']).toEqual({ by: 'launcher', run: 'none' })
    // A launcher's refusal lists the two it may record; an agent's doesn't.
    await startAgent('a1', 'litter:relay', RUN)
    const fromAgent = asError(await call({ kind: 'nope' }, 'a1'))
    expect(fromAgent.allowed).not.toContain('repair.start')
    expect(fromAgent.allowed).not.toContain('repair.budget')
    const fromLauncher = asError(await call({ kind: 'nope' }))
    expect(fromLauncher.allowed).toEqual(expect.arrayContaining(['repair.start', 'repair.budget']))
    expect(fromLauncher.allowed).not.toContain('run.repair')
  })
})

describe('the structured fields 2b-2 adds', () => {
  test('declared in the schema with their types', () => {
    const props = (RECORD_TOOL.inputSchema as { properties: Record<string, { type?: string; items?: { type?: string } }> }).properties
    for (const f of ['repairRounds', 'repairAgents', 'rounds', 'agents']) expect(props[f]?.type).toBe('integer')
    expect(props.proposed_rules).toEqual({ type: 'array', items: { type: 'string' } })
  })

  test('decoded from their JSON before the handler', async () => {
    bindNode('node-1')
    answerWith = async () => ({ ok: true })
    await call({ kind: 'verdict', proposed_rules: '["a", "b"]', rounds: '2', agents: '3' }, 'node-1')
    expect(gateCalls[0]?.input).toEqual(expect.objectContaining({ proposed_rules: ['a', 'b'], rounds: 2, agents: 3 }))
  })
})

describe('runClosed across a repair generation', () => {
  const recs = (...kinds: string[]): StoredRecord[] => kinds.map((kind, i) => ({ v: 1, seq: i + 1, kind, run: RUN, at: i, by: { source: 'mod' }, prev: null, body: {} }))

  test('a run.repair after run.end reopens the run; its own run.end closes it again', () => {
    expect(runClosed(recs('run.start', 'run.launch', 'verify', 'run.end'))).toBe('has ended')
    expect(runClosed(recs('run.start', 'run.launch', 'run.end', 'run.repair'))).toBeNull()
    expect(runClosed(recs('run.start', 'run.launch', 'run.end', 'run.repair', 'verify', 'verdict'))).toBeNull()
    expect(runClosed(recs('run.start', 'run.launch', 'run.end', 'run.repair', 'verify', 'run.end'))).toBe('has ended')
    expect(runClosed(recs('run.start', 'run.launch', 'run.end', 'run.repair', 'run.end', 'run.repair', 'land'))).toBeNull()
  })

  test('a stop after the reopen still closes it; repair.declined opens nothing', () => {
    expect(runClosed(recs('run.launch', 'run.end', 'run.repair', 'run.stopping'))).toBe('is stopping')
    expect(runClosed(recs('run.launch', 'run.end', 'repair.declined'))).toBe('has ended')
    expect(runClosed(recs('run.launch', 'run.end', 'repair.declined', 'summary'))).toBe('has ended')
  })

  test('read from a real ledger: a run.repair after a run.end leaves the run open', async () => {
    const d = runDir(dir, RUN)
    for (const kind of ['run.launch', 'run.end', 'run.repair']) await appendRecord(p, d, { run: RUN, kind, by: { source: 'mod' }, body: {} })
    expect(runClosed((await readLedger(p, d, RUN)).records)).toBeNull()
  })
})
