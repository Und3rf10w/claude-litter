// Tier 2: a swarm spawn's <rules> block (hooks/swarm/spawn.ts with
// hooks/rules/select.ts's selectForSpawn; plan 16.5, 15.10; WP-AE), called
// with a fake engine `next` against real files and real git, and AD's
// loadRules and proposalsOf stood in for through the `deps` tables: a node's
// rules by its paths or its directory, a plan-template node's by its run's
// unlanded gates, a ban in every node's block whatever its paths (WP-AH), the
// swarm's proposals after them, "none apply", the cap, and the selection
// made before the spawn's reservation.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { AgentSpawnInput, AgentSpawnResult } from 'claude-code'
import type { LoadedRule, ProposalRef, RuleDoc, RuleProposeBody, RuleStatus } from '../../hooks/records/rules'
import { pendingPath, runDir as runDirOf, runJsonPath, swarmOwnWorktreeName } from '../../hooks/layout'
import { newLaunchId } from '../../hooks/records/swarm'
import { appendRecord } from '../../hooks/ledgercore'
import { updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import * as admit from '../../hooks/swarm/admit'
import { deps as spawnDeps, PROPOSALS_MAX, swarmSpawn } from '../../hooks/swarm/spawn'
import { deps as selectDeps, RULES_CAP } from '../../hooks/rules/select'
import type { LiveSwarm, SwarmSpec } from '../../hooks/swarm/types'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const NOW = 1_800_000_000_000
const NONCE = 'f00dfeedf00dfeedf00dfeedf00dfeed'
const RO = { deny: ['Edit', 'Write', 'NotebookEdit'] }
const RUN = '20261003-bridged'

let p: TestPorts
let dir: string
let real: string
let litterDir: string
let root: string
let launch: string
let cleanup: () => void

const saved = { spawn: { ...spawnDeps }, select: { ...selectDeps } }

const T = (node: string) => `litter:sw-alpha-${node}`

function spec(over: Partial<SwarmSpec> = {}): SwarmSpec {
  return {
    name: 'alpha',
    goal: 'ship it',
    nodes: [
      { id: 'part-a', kind: 'orchestrator', worktree: 'none', tools: RO, spawns: { fixer: 2, scout: 2 } },
      { id: 'part-b', kind: 'orchestrator', worktree: { existing: '/elsewhere' }, tools: RO, spawns: { scout: 2 } },
      { id: 'fixer', kind: 'worker', worktree: 'own', authority: { commit: true }, paths: ['src/'] },
      { id: 'scout', kind: 'worker', tools: RO, spawnOther: false },
    ],
    ...over,
  }
}

function live(over: Partial<LiveSwarm> = {}): LiveSwarm {
  const s = over.spec ?? spec()
  return {
    name: 'alpha',
    launch,
    revision: 1,
    spec: s,
    nonce: NONCE,
    types: Object.fromEntries(s.nodes.map(n => [n.id, T(n.id)])),
    typesReady: true,
    dirs: { 'part-a': { dir: real, branch: null, created: false }, 'part-b': { dir: join(real, 'b'), branch: null, created: false } },
    sessionCwd: real,
    worktreeRoot: root,
    commonDir: join(real, '.git'),
    roots: { litterDir, litterCopies: [litterDir], ruleDirs: [] },
    tips: {},
    owner: { ref: 'refs/litter-swarm/alpha', oid: 'a'.repeat(40), generation: 3, session: 'test-session' },
    state: 'live',
    readOnly: false,
    lost: false,
    flags: { isolationLost: false },
    startedAt: NOW,
    ...over,
  }
}

let toolN = 0
function spawnE(subagentType: string, parentAgentId?: string): AgentSpawnInput {
  return {
    tool_use_id: `toolu_${++toolN}`,
    prompt: 'do the task',
    description: 'a task',
    subagentType,
    provider: { plugin: 'engine', tier: 'core' },
    parentModel: 'opus',
    background: false,
    fork: false,
    ...(parentAgentId !== undefined ? { parentAgentId } : {}),
  }
}

let agentN = 0
function engine() {
  const calls: AgentSpawnInput[] = []
  const next = async (e: AgentSpawnInput): Promise<AgentSpawnResult> => {
    calls.push(e)
    return { model: e.model ?? 'inherit', agentId: `agent-${++agentN}` }
  }
  return { next: next as never, calls }
}

const run = (e: AgentSpawnInput, next: never): Promise<AgentSpawnResult> => swarmSpawn(p, e as never, next) as Promise<AgentSpawnResult>

/** The <rules> block's body in a delivered prompt. */
const block = (prompt: string): string => /<rules id="([^"]+)">\n([\s\S]*?)\n<\/rules id="\1">/.exec(prompt)?.[2] ?? '(no block)'

// ---------------------------------------------------------------------------
// Rules and proposals, as AD's store hands them over

function doc(id: string, o: { paths?: string[]; workflows?: string[]; roles?: string[]; rule?: string; type?: 'rule' | 'ban' } = {}): RuleDoc {
  return {
    id,
    version: 1,
    status: 'accepted',
    type: o.type ?? 'rule',
    applies: { paths: o.paths ?? [], ...(o.workflows ? { workflows: o.workflows } : {}), ...(o.roles ? { roles: o.roles } : {}), when: `working on ${id}` },
    export: true,
    extra: [],
    body: { rule: o.rule ?? `Follow ${id}.`, why: '', exceptions: [], howToCheck: [] },
  }
}
/** A ban with paths names what it protects (select.ts's label). */
const entry = (d: RuleDoc) => `${d.id}@1 (${d.type === 'ban' && d.applies.paths.length > 0 ? `ban; protects ${d.applies.paths.join(', ')}` : d.type}) working on ${d.id}: ${d.body.rule}`

function rules(...docs: RuleDoc[]): void {
  const list: LoadedRule[] = docs.map(d => ({ doc: d, scope: 'project', path: `/r/${d.id}.md`, sha256: 'f'.repeat(64), standing: 'accepted', delivered: d }))
  selectDeps.loadRules = async () => ({ rules: list, problems: [] })
}

type Proposal = { ref: ProposalRef; body: RuleProposeBody; status: RuleStatus }
function proposals(list: Proposal[]): { filters: unknown[] } {
  const seen = { filters: [] as unknown[] }
  spawnDeps.proposalsOf = async (_p, _dir, filter) => {
    seen.filters.push(filter)
    return list
  }
  return seen
}
const proposal = (seq: number, rule: string, status: RuleStatus = 'proposed'): Proposal => ({
  ref: { store: 'repo', seq },
  body: { rule, source: 'critic', swarm: 'alpha' },
  status,
})

beforeEach(async () => {
  state.resetForTests()
  admit.resetForTests()
  agentN = 0
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
  const { git } = await scratchRepo(p, dir)
  await p.fs.write(join(dir, '.gitignore'), '.claude/\n')
  await git('add', '.gitignore')
  await git('commit', '-q', '-m', 'ignore')
  real = realpathSync(dir)
  mkdirSync(join(real, 'b'))
  litterDir = join(dir, '.claude', 'litter')
  root = join(real, '.claude', 'worktrees')
  launch = await newLaunchId(p, litterDir, 'alpha')
  p.clock.now = NOW
  updateSession({ litterDir })
  state.putLiveSwarm(live())
  rules()
  proposals([])
})

afterEach(() => {
  Object.assign(spawnDeps, saved.spawn)
  Object.assign(selectDeps, saved.select)
  admit.resetForTests()
  state.resetForTests()
  updateSession({ litterDir: null })
  cleanup()
})

// ---------------------------------------------------------------------------

describe("a node's rules", () => {
  test("a node's block holds the rules for its paths and every rule without paths, and no other", async () => {
    const s = spec()
    s.nodes[0] = { ...s.nodes[0]!, paths: ['src/'] }
    state.putLiveSwarm(live({ spec: s }))
    const src = doc('P-src', { paths: ['/src/**'] })
    const lib = doc('P-lib', { paths: ['/lib/**'] })
    const all = doc('P-all')
    rules(src, lib, all)
    const { next, calls } = engine()
    expect((await run(spawnE(T('part-a')), next)).agentId).toBeDefined()
    expect(block(calls[0]!.prompt)).toBe([entry(all), entry(src)].join('\n'))
  })

  test('a node without paths gets every rule at its directory\'s top, and in a subdirectory those that could match under it', async () => {
    const src = doc('P-src', { paths: ['/src/**'] })
    const b = doc('P-b', { paths: ['/b/*.ts'] })
    const md = doc('P-md', { paths: ['*.md'] })
    const all = doc('P-all')
    rules(src, b, md, all)
    const { next, calls } = engine()
    // part-a works at the repository's top; part-b in its b/ folder.
    await run(spawnE(T('part-a')), next)
    state.putLiveSwarm(live({ dirs: { 'part-a': { dir: real, branch: null, created: false }, 'part-b': { dir: join(real, 'b'), branch: null, created: false } } }))
    await run(spawnE(T('part-b')), next)
    expect(block(calls[0]!.prompt)).toBe([entry(all), entry(b), entry(md), entry(src)].join('\n'))
    expect(block(calls[1]!.prompt)).toBe([entry(all), entry(b), entry(md)].join('\n'))
  })

  test("a ban reaches a node without paths with the rules without paths, ahead of path rules however specific, at the top and in a subdirectory", async () => {
    const ban = doc('P-z-ban', { type: 'ban', paths: ['/vendor/**'] })
    const style = doc('P-vendor-style', { paths: ['/vendor/**'] })
    const deep = doc('P-a-deep', { paths: ['/a/b/c.ts'] })
    const all = doc('P-all')
    rules(ban, style, deep, all)
    const { next, calls } = engine()
    // part-a at the repository's top: every rule. part-b in b/: those that could match under it, and the shared ones.
    await run(spawnE(T('part-a')), next)
    state.putLiveSwarm(live())
    await run(spawnE(T('part-b')), next)
    expect(block(calls[0]!.prompt)).toBe([entry(all), entry(ban), entry(deep), entry(style)].join('\n'))
    expect(block(calls[1]!.prompt)).toBe([entry(all), entry(ban)].join('\n'))
    expect(entry(ban)).toBe('P-z-ban@1 (ban; protects /vendor/**) working on P-z-ban: Follow P-z-ban.')
  })

  test("a ban reaches a node whose paths are elsewhere; a rule with the ban's paths doesn't", async () => {
    const ban = doc('P-vendor', { type: 'ban', paths: ['/vendor/**'] })
    const style = doc('P-vendor-style', { paths: ['/vendor/**'] })
    const src = doc('P-src', { paths: ['/src/**'] })
    rules(ban, style, src)
    const { next, calls } = engine()
    // fixer's paths are src/, in its own worktree.
    const a = (await run(spawnE(T('part-a')), next)).agentId!
    expect((await run(spawnE(T('fixer'), a), next)).agentId).toBeDefined()
    expect(block(calls[1]!.prompt)).toBe([entry(ban), entry(src)].join('\n'))
  })

  test("workflows narrow a swarm's rules to swarm ones, and a node with no role gets no rule with roles set", async () => {
    const swarmOnly = doc('P-swarm', { workflows: ['swarm'] })
    const executeOnly = doc('P-execute', { workflows: ['execute'] })
    const executor = doc('P-executor', { roles: ['executor'] })
    rules(swarmOnly, executeOnly, executor)
    const { next, calls } = engine()
    await run(spawnE(T('part-a')), next)
    expect(block(calls[0]!.prompt)).toBe(entry(swarmOnly))
  })

  test("an own worktree's node is selected for before the worktree exists, its paths read from the repository's top", async () => {
    const dirs: string[] = []
    const src = doc('P-src', { paths: ['/src/**'] })
    rules(src, doc('P-lib', { paths: ['/lib/**'] }))
    const select = spawnDeps.selectForSpawn
    spawnDeps.selectForSpawn = async (pp, ld, input) => {
      dirs.push(input.dir)
      return select(pp, ld, input)
    }
    const { next, calls } = engine()
    const a = (await run(spawnE(T('part-a')), next)).agentId!
    const f = await run(spawnE(T('fixer'), a), next)
    expect(f.agentId).toBeDefined()
    expect(dirs[1]).toBe(join(root, swarmOwnWorktreeName('alpha', 'fixer', 0)))
    expect(existsSync(dirs[1]!)).toBe(false)
    expect(block(calls[1]!.prompt)).toBe(entry(src))
  })

  test("a non-swarm agent a node starts gets no block, and nothing is selected for it", async () => {
    const { next, calls } = engine()
    const a = (await run(spawnE(T('part-a')), next)).agentId!
    let selected = 0
    spawnDeps.selectForSpawn = async () => {
      selected++
      return []
    }
    expect((await run(spawnE('general-purpose', a), next)).agentId).toBeDefined()
    expect(selected).toBe(0)
    expect(calls[1]!.prompt).toBe('do the task')
  })
})

describe("a plan-template node (an execute run's bridge)", () => {
  async function bridged(): Promise<void> {
    const rd = runDirOf(litterDir, RUN)
    await p.fs.write(
      runJsonPath(rd),
      JSON.stringify({
        v: 1,
        run: RUN,
        workflow: 'execute',
        checkout: real,
        args: { gates: [{ id: 'G1', files: ['a/x.ts'] }, { id: 'G2', files: ['b/y.ts'] }, { id: 'G3', files: ['c/'] }] },
      }),
    )
    await appendRecord(p, rd, { run: RUN, kind: 'land', by: { source: 'mod' }, body: { gate: 'G1', verify_id: 'v1', commit: 'c'.repeat(40) } })
    const s: SwarmSpec = {
      name: 'alpha',
      goal: 'finish the run',
      nodes: [
        { id: 'runner', kind: 'orchestrator', worktree: { existing: real }, tools: RO, spawns: { executor: 1, critic: 1 } },
        { id: 'executor', kind: 'worker', worktree: 'inherit', serial: true },
        { id: 'critic', kind: 'worker', worktree: 'inherit', tools: RO, verdicts: true },
      ],
    }
    state.putLiveSwarm(live({ spec: s, dirs: { runner: { dir: real, branch: null, created: false } }, run: { runDir: rd, run: RUN, generation: 2 } }))
  }

  test("gets the rules for the run's unlanded gates' Files, execute rules too, and its role's", async () => {
    await bridged()
    const landed = doc('P-a', { paths: ['/a/**'] })
    const open = doc('P-b', { paths: ['/b/*.ts'] })
    const folder = doc('P-c', { paths: ['/c/deep/*.py'] })
    const executeOnly = doc('P-execute', { workflows: ['execute'] })
    const fanoutOnly = doc('P-fanout', { workflows: ['fanout'] })
    const critic = doc('P-critic', { roles: ['gate-critic'] })
    const executor = doc('P-executor', { roles: ['executor'] })
    rules(landed, open, folder, executeOnly, fanoutOnly, critic, executor)
    const { next, calls } = engine()
    const runner = (await run(spawnE(T('runner')), next)).agentId!
    await run(spawnE(T('critic'), runner), next)
    await run(spawnE(T('executor'), runner), next)
    // The runner has no role; the critic counts as gate-critic, the executor as executor. The path rules
    // follow the pathless ones, most specific first: c/deep/*.py (2) before b/*.ts (1).
    expect(block(calls[0]!.prompt)).toBe([entry(executeOnly), entry(folder), entry(open)].join('\n'))
    expect(block(calls[1]!.prompt)).toBe([entry(critic), entry(executeOnly), entry(folder), entry(open)].join('\n'))
    expect(block(calls[2]!.prompt)).toBe([entry(executeOnly), entry(executor), entry(folder), entry(open)].join('\n'))
  })

  test("a file you added to a gate during the run (gate.widen) brings its rules to a node spawned after it; a critic's doesn't", async () => {
    await bridged()
    const rd = runDirOf(litterDir, RUN)
    const widened = doc('P-d', { paths: ['/d/*.sh'] })
    const critics = doc('P-e', { paths: ['/e/*.sh'] })
    rules(widened, critics)
    const body = (by: string, gate: string, file: string) => ({ gate, files: [file], why: 'w', by, at: by === 'you' ? 'run' : 'land' })
    await appendRecord(p, rd, { run: RUN, kind: 'gate.widen', by: { source: 'launcher' }, body: body('you', 'G2', 'd/gen.sh') })
    await appendRecord(p, rd, { run: RUN, kind: 'gate.widen', by: { source: 'mod' }, body: body('critic', 'G3', 'e/x.sh') })
    const { next, calls } = engine()
    await run(spawnE(T('runner')), next)
    expect(block(calls[0]!.prompt)).toBe(entry(widened))
  })

  test("every node gets a ban whatever its paths, a landed gate's or no gate's; a rule with those paths reaches none", async () => {
    await bridged()
    const ban = doc('P-vendor', { type: 'ban', paths: ['/vendor/**'] })
    const style = doc('P-vendor-style', { paths: ['/vendor/**'] })
    const landedBan = doc('P-a-ban', { type: 'ban', paths: ['/a/**'] })
    const open = doc('P-b', { paths: ['/b/*.ts'] })
    rules(ban, style, landedBan, open)
    const { next, calls } = engine()
    const runner = (await run(spawnE(T('runner')), next)).agentId!
    await run(spawnE(T('critic'), runner), next)
    await run(spawnE(T('executor'), runner), next)
    const want = [entry(landedBan), entry(ban), entry(open)].join('\n')
    expect(calls.map(c => block(c.prompt))).toEqual([want, want, want])
  })

  test("a fanout repair swarm's nodes are plain swarm nodes: swarm rules only, and every rule by directory", async () => {
    await bridged()
    const rd = runDirOf(litterDir, RUN)
    await p.fs.write(runJsonPath(rd), JSON.stringify({ v: 1, run: RUN, workflow: 'fanout', checkout: real, args: {} }))
    const landed = doc('P-a', { paths: ['/a/**'] })
    const executeOnly = doc('P-execute', { workflows: ['execute'] })
    const critic = doc('P-critic', { roles: ['gate-critic'] })
    rules(landed, executeOnly, critic)
    const { next, calls } = engine()
    await run(spawnE(T('runner')), next)
    expect(block(calls[0]!.prompt)).toBe(entry(landed))
  })
})

describe("the swarm's proposals", () => {
  test('come after the rules, labelled, deduplicated by folded text, the 10 most recent, oldest first', async () => {
    const all = doc('P-all')
    rules(all)
    const list = [
      proposal(1, 'old one'),
      proposal(2, 'Keep the API stable'),
      ...Array.from({ length: 9 }, (_, i) => proposal(3 + i, `rule ${i}`)),
      proposal(12, 'dismissed one', 'dismissed'),
      proposal(13, '  keep   the api STABLE '),
      proposal(14, 'newest'),
    ]
    const seen = proposals(list)
    const { next, calls } = engine()
    await run(spawnE(T('part-a')), next)
    expect(seen.filters).toEqual([{ swarm: 'alpha', status: ['proposed'] }])
    const lines = block(calls[0]!.prompt).split('\n')
    expect(lines[0]).toBe(entry(all))
    expect(lines.slice(1)).toEqual([
      ...Array.from({ length: 8 }, (_, i) => `Proposed in this run, not accepted: rule ${i + 1}`),
      'Proposed in this run, not accepted: keep the api STABLE',
      'Proposed in this run, not accepted: newest',
    ])
    expect(lines.length - 1).toBe(PROPOSALS_MAX)
  })

  test("stay inside the block's 8 KiB, after the rules", async () => {
    rules(doc('P-big', { rule: 'x'.repeat(RULES_CAP - 200) }))
    proposals([proposal(1, 'a short one'), proposal(2, 'y'.repeat(300))])
    const { next, calls } = engine()
    await run(spawnE(T('part-a')), next)
    const body = block(calls[0]!.prompt)
    expect(body.split('\n').at(-1)).toBe('Proposed in this run, not accepted: a short one')
    expect(new TextEncoder().encode(body).length).toBeLessThanOrEqual(RULES_CAP)
  })

  test("that can't be read are logged, and the spawn goes on with the rules", async () => {
    rules(doc('P-all'))
    spawnDeps.proposalsOf = async () => {
      throw new Error('the rules ledger is tampered at seq 3')
    }
    const { next, calls } = engine()
    expect((await run(spawnE(T('part-a')), next)).agentId).toBeDefined()
    expect(block(calls[0]!.prompt)).toBe(entry(doc('P-all')))
    expect(p.logs).toContain("swarm alpha: its critics' proposals couldn't be read, so this spawn's rules block has none: the rules ledger is tampered at seq 3")
  })
})

describe('the block and the reservation', () => {
  test('with no rule and no proposal, the block says none apply', async () => {
    const { next, calls } = engine()
    await run(spawnE(T('part-a')), next)
    expect(block(calls[0]!.prompt)).toBe('none apply')
  })

  test('the selection happens before the reservation, with nothing reserved while it runs', async () => {
    const during: { reserved: number; bound: number }[] = []
    spawnDeps.selectForSpawn = async () => {
      during.push({ reserved: state.reservations('alpha').length, bound: state.bindings('alpha').length })
      await new Promise(r => setTimeout(r, 5))
      return ['P-x@1 (rule) anywhere: do x']
    }
    const { next, calls } = engine()
    const a = (await run(spawnE(T('part-a')), next)).agentId!
    expect(during).toEqual([{ reserved: 0, bound: 0 }])
    expect(state.binding(a)?.node).toBe('part-a')
    expect(block(calls[0]!.prompt)).toBe('P-x@1 (rule) anywhere: do x')
  })

  test('a selection that throws denies the spawn, reserving, marking and starting nothing', async () => {
    spawnDeps.selectForSpawn = async () => {
      throw new Error('two scopes hold P-x')
    }
    const { next, calls } = engine()
    const e = spawnE(T('part-a'))
    const r = await run(e, next)
    expect(r.deny).toBe("litter: swarm alpha's accepted rules couldn't be selected, so it starts nothing: two scopes hold P-x. /litter-rules shows them and their problems")
    expect(calls).toEqual([])
    expect(state.reservations()).toEqual([])
    expect(existsSync(pendingPath(litterDir, e.tool_use_id))).toBe(false)
  })

  test('a spawn the check refuses is refused as before, whatever the selection', async () => {
    let selected = 0
    spawnDeps.selectForSpawn = async () => {
      selected++
      return []
    }
    const { next, calls } = engine()
    // A worker spawned by the lead: the check refuses it, and nothing is selected for it.
    expect((await run(spawnE(T('scout')), next)).deny).toContain('scout is a worker of swarm alpha: its parent node spawns it')
    expect(selected).toBe(0)
    expect(calls).toEqual([])
  })
})
