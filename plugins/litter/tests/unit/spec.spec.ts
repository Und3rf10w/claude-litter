// Tier 2: the spec (hooks/swarm/spec.ts; plan 15.3, section 12's validation
// cases): the schema and every 15.3 rule, each refused with its node and
// field, every error at once with the schema's first, and the tree's shape.
// Real git in a scratch repo for the worktree and branch rules.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { symlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { SpecError, SwarmNode, SwarmSpec, ValidateCtx } from '../../hooks/swarm/types'
import { instancesOf, specSchemaErrors, treeShape, validateSpec } from '../../hooks/swarm/spec'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const W = ['Edit', 'Write', 'NotebookEdit']
const RO = { commit: false, push: 'none', forcePush: false, rewriteHistory: false, worktreeOps: false } as const
const CO = { ...RO, commit: true } as const

let p: TestPorts
let dir: string
let cleanup: () => void
let git: (...argv: string[]) => Promise<string>
let briefs: Record<string, string>

beforeEach(async () => {
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ cwd: dir })
  ;({ git } = await scratchRepo(p, dir))
  briefs = {}
})
afterEach(() => cleanup())

const ctx = (over: Partial<ValidateCtx> = {}): ValidateCtx => ({
  repo: dir,
  litterDir: join(dir, '.claude', 'litter'),
  limits: p.limitsValue,
  briefText: async node => briefs[node] ?? null,
  activeRunCheckout: null,
  ...over,
})

const reader = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => ({ id, kind: 'worker', tools: { deny: W }, authority: RO, ...over })
const lead = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => ({ id, kind: 'orchestrator', worktree: 'none', tools: { deny: W }, authority: RO, ...over })
const spec = (nodes: SwarmNode[], over: Partial<SwarmSpec> = {}): SwarmSpec => ({ name: 'alpha', goal: 'Do the thing', nodes, ...over })

const check = (s: unknown, c: Partial<ValidateCtx> = {}) => validateSpec(p, s, ctx(c))
const fields = (es: SpecError[]) => es.map(e => e.field)
const errorAt = (es: SpecError[], field: string) => es.find(e => e.field === field)

describe('a valid spec', () => {
  test('passes with no errors or warnings', async () => {
    const r = await check(spec([lead('part-a', { spawns: { reviewer: 2 } }), reader('reviewer')]))
    expect(r).toEqual({ ok: true, errors: [], warnings: [] })
  })
})

describe('the schema', () => {
  test('unknown keys, bad names, values outside their sets and bad counts are each named', async () => {
    const s = {
      name: 'Alpha!',
      goal: 'g',
      extra: 1,
      nodes: [
        {
          id: 'part-a',
          kind: 'orchestrator',
          colour: 'red',
          effort: 'huge',
          permissionMode: 'yolo',
          maxTurns: 0,
          spawns: { reviewer: 0 },
          authority: { push: 'everything', commit: 'yes', sudo: true },
          bash: { deny: ['rm -rf\n/'] },
          report: ['shipped'],
          worktree: { existing: '' },
        },
        { id: 'Bad_Id', kind: 'worker' },
        { id: 'part-a', kind: 'worker' },
        { id: 'reviewer', kind: 'boss' },
      ],
    }
    const errors = specSchemaErrors(s)
    expect(fields(errors)).toEqual(
      expect.arrayContaining([
        'extra',
        'name',
        'nodes.part-a.colour',
        'nodes.part-a.effort',
        'nodes.part-a.permissionMode',
        'nodes.part-a.maxTurns',
        'nodes.part-a.spawns.reviewer',
        'nodes.part-a.authority.push',
        'nodes.part-a.authority.commit',
        'nodes.part-a.authority.sudo',
        'nodes.part-a.bash.deny[0]',
        'nodes.part-a.report[0]',
        'nodes.part-a.worktree.existing',
        'nodes[1].id',
        'nodes[2].id',
        'nodes.reviewer.kind',
      ]),
    )
    expect(errorAt(errors, 'extra')!.error).toContain("unknown field 'extra'")
    expect(errorAt(errors, 'nodes.part-a.colour')).toEqual(expect.objectContaining({ node: 'part-a' }))
    expect(errorAt(errors, 'nodes[2].id')!.error).toContain('used twice')
  })

  test('the worktree forms, and a brief that must be the node\'s own file', async () => {
    const errors = specSchemaErrors(
      spec([
        lead('a', { worktree: 'shared' as never, brief: 'briefs/other.md' }),
        lead('b', { worktree: { new: { from: 'main' } } as never }),
        lead('c', { worktree: { existing: 'x', new: { from: 'a', branch: 'b' } } as never }),
      ]),
    )
    expect(fields(errors)).toEqual(['nodes.a.brief', 'nodes.a.worktree', 'nodes.b.worktree.new.branch', 'nodes.c.worktree'])
  })

  test("a spec that isn't an object, or has no nodes list, stops at the schema", async () => {
    expect(await check('nope')).toEqual({ ok: false, errors: [expect.objectContaining({ field: 'spec' })], warnings: [] })
    const r = await check({ name: 'alpha', goal: 'g' })
    expect(fields(r.errors)).toEqual(['nodes'])
  })
})

describe('the tree', () => {
  test('a cycle is refused, naming the node and the spawns field that closes it', async () => {
    const r = await check(spec([lead('top', { spawns: { a: 1 } }), reader('a', { spawns: { b: 1 } }), reader('b', { spawns: { a: 1 } })]))
    const cyc = r.errors.find(e => e.error.includes('a cycle'))
    expect(cyc).toEqual(expect.objectContaining({ field: 'nodes.b.spawns.a', node: 'b' }))
    expect(cyc!.error).toContain('a → b → a')
  })

  test('an unknown name in spawns, an orchestrator in spawns, and a worker nothing spawns', async () => {
    const r = await check(spec([lead('top', { spawns: { ghost: 1, other: 1 } }), lead('other'), reader('lonely')]))
    expect(errorAt(r.errors, 'nodes.top.spawns.ghost')).toEqual(expect.objectContaining({ node: 'top' }))
    expect(errorAt(r.errors, 'nodes.top.spawns.other')!.error).toContain('only the lead spawns orchestrators')
    expect(errorAt(r.errors, 'nodes.lonely')!.error).toContain('nothing spawns it')
  })

  test('a swarm with no orchestrator', async () => {
    const r = await check(spec([]))
    expect(fields(r.errors)).toEqual(['nodes'])
  })

  test('a task on a worker, and own or serial on an orchestrator', async () => {
    const r = await check(spec([lead('top', { spawns: { w: 1 }, serial: true }), lead('two', { worktree: 'own' }), reader('w', { task: 'x' })]))
    expect(fields(r.errors)).toEqual(expect.arrayContaining(['nodes.w.task', 'nodes.two.worktree', 'nodes.top.serial']))
  })
})

describe('depth and peak (15.7)', () => {
  const deep = () => spec([lead('o', { spawns: { w1: 1 } }), reader('w1', { spawns: { w2: 1 } }), reader('w2', { spawns: { w3: 1 } }), reader('w3')])

  test('four levels under a limit of 3 is an error on the deepest node', async () => {
    const r = await check(deep())
    expect(errorAt(r.errors, 'nodes.w3')!.error).toContain('depth 4')
    expect(r.ok).toBe(false)
  })

  test('a limit of 5 in this process lets it pass', async () => {
    p.limitsValue.CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH = '5'
    expect((await check(deep())).ok).toBe(true)
  })

  test('the 15.7 example: depth 2, peak 18, a warning for less than 4 to spare, and none at 30', async () => {
    const s = spec([
      ...['a', 'b', 'c'].map(id => lead(id, { spawns: { reviewer: 3, fixer: 2 } })),
      reader('reviewer'),
      reader('fixer'),
    ])
    expect(treeShape(s)).toEqual({ depth: { a: 1, b: 1, c: 1, reviewer: 2, fixer: 2 }, maxDepth: 2, peak: 18, uncapped: 18 })
    const r = await check(s)
    expect(r.ok).toBe(true)
    expect(r.warnings).toEqual([expect.objectContaining({ field: 'limits.maxAgentsAtOnce' })])
    expect(r.warnings[0]!.error).toContain('need 22')
    p.limitsValue.CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS = '30'
    expect((await check(s)).warnings).toEqual([])
  })

  test('maxAgentsAtOnce caps the peak', () => {
    const s = spec([lead('a', { spawns: { r: 10 } }), reader('r')], { limits: { maxAgentsAtOnce: 5 } })
    expect(treeShape(s)).toEqual(expect.objectContaining({ peak: 5, uncapped: 11 }))
  })
})

describe('writers and their directories', () => {
  const writer = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => ({ id, kind: 'orchestrator', worktree: 'none', authority: RO, ...over })

  test('two writing nodes in one worktree without paths are refused', async () => {
    const r = await check(spec([writer('a'), writer('b')]))
    expect(errorAt(r.errors, 'nodes.b.paths')).toEqual(expect.objectContaining({ node: 'b' }))
  })

  test('disjoint paths pass; paths that meet, and a committer, are refused', async () => {
    expect((await check(spec([writer('a', { paths: ['src/server/'] }), writer('b', { paths: ['src/client/', 'README.md'] })]))).ok).toBe(true)
    const meet = await check(spec([writer('a', { paths: ['src/'] }), writer('b', { paths: ['src/x.ts'] })]))
    expect(errorAt(meet.errors, 'nodes.b.paths')!.error).toContain("'src/'")
    const commits = await check(spec([writer('a', { paths: ['src/'], authority: CO }), writer('b', { paths: ['docs/'] })]))
    expect(errorAt(commits.errors, 'nodes.b.worktree')!.error).toContain('a may commit')
  })

  test('a parent and a writing child that inherits its directory share it', async () => {
    const r = await check(spec([writer('o', { authority: CO, spawns: { fixer: 1 } }), { id: 'fixer', kind: 'worker', authority: CO }]))
    expect(errorAt(r.errors, 'nodes.fixer.worktree')!.error).toContain('o may commit')
  })

  test('fixer: 2 with inherit is refused; with own or serial it passes', async () => {
    const o = lead('o', { spawns: { fixer: 2 } })
    const fixer = (over: Partial<SwarmNode>): SwarmNode => ({ id: 'fixer', kind: 'worker', authority: RO, ...over })
    const refused = await check(spec([o, fixer({})]))
    expect(errorAt(refused.errors, 'nodes.fixer.worktree')).toEqual(expect.objectContaining({ node: 'fixer' }))
    expect(errorAt(refused.errors, 'nodes.fixer.worktree')!.error).toContain('up to 2 instances of fixer')
    expect((await check(spec([o, fixer({ worktree: 'own' })]))).ok).toBe(true)
    expect((await check(spec([o, fixer({ serial: true })]))).ok).toBe(true)
  })

  test('two committing instances in one directory are told they share its index and branch', async () => {
    const r = await check(spec([lead('o', { authority: {}, spawns: { fixer: 2 } }), { id: 'fixer', kind: 'worker', worktree: 'none', authority: CO }]))
    expect(fields(r.errors)).toEqual(['nodes.fixer.worktree'])
    expect(errorAt(r.errors, 'nodes.fixer.worktree')!.error).toContain('sharing its index and branch')
  })

  test('two read-only parents each spawning one writer in their shared directory make two at once', async () => {
    const r = await check(spec([lead('o', { spawns: { planner: 2 } }), reader('planner', { spawns: { fixer: 1 } }), { id: 'fixer', kind: 'worker', authority: RO }]))
    expect(errorAt(r.errors, 'nodes.fixer.worktree')!.error).toContain('up to 2 instances')
  })

  test('instancesOf expands each writing template per parent with its directory', () => {
    const s = spec([
      lead('o', { spawns: { fixer: 2, own: 3 } }),
      { id: 'fixer', kind: 'worker', authority: RO },
      { id: 'own', kind: 'worker', worktree: 'own', authority: RO, spawns: { helper: 2 } },
      { id: 'helper', kind: 'worker', authority: RO },
    ])
    expect(instancesOf(s)).toEqual([
      { node: 'fixer', parent: 'o', count: 2, dir: { kind: 'session' }, commits: false, serial: false },
      { node: 'own', parent: 'o', count: 3, dir: { kind: 'own' }, commits: false, serial: false },
      { node: 'helper', parent: 'own', count: 2, dir: { kind: 'worktree', path: 'sw-alpha-own-<n>', node: 'own' }, commits: false, serial: false },
    ])
  })
})

describe('authority', () => {
  test('a worker with more authority than a parent is refused field by field; unset is more than any set value', async () => {
    const r = await check(
      spec([
        lead('o', { spawns: { w: 1 }, authority: { commit: false, push: 'none' } }),
        reader('w', { authority: { commit: true, forcePush: true } }),
        lead('p', { spawns: { v: 1 }, authority: { commit: false } }),
        reader('v', { authority: {} }),
      ]),
    )
    expect(fields(r.errors)).toEqual(['nodes.w.authority.commit', 'nodes.w.authority.push', 'nodes.v.authority.commit'])
    expect(errorAt(r.errors, 'nodes.w.authority.push')!.error).toContain("unset (not checked by litter), more than its parent o's 'none'")
  })

  test("a parent that leaves a field unset doesn't bound the worker's", async () => {
    const r = await check(spec([lead('o', { spawns: { w: 1 }, authority: {} }), reader('w', { authority: { commit: true, push: 'any' } })]))
    expect(r.errors.filter(e => e.field.includes('authority'))).toEqual([])
  })
})

describe('worktrees and branches', () => {
  test('an existing path that is a worktree, through a symlink and relative, passes; one that is not is refused', async () => {
    await git('worktree', 'add', '-q', '-b', 'part-a', join(dir, 'wt-a'))
    const { dir: other, cleanup: done } = scratch('litter-link-')
    try {
      symlinkSync(join(dir, 'wt-a'), join(other, 'link'))
      expect((await check(spec([lead('a', { worktree: { existing: join(other, 'link') } })]))).ok).toBe(true)
      expect((await check(spec([lead('a', { worktree: { existing: 'wt-a' } })]))).ok).toBe(true)
      const r = await check(spec([lead('a', { worktree: { existing: other } })]))
      expect(errorAt(r.errors, 'nodes.a.worktree.existing')!.error).toContain("isn't a worktree of this repository")
      const gone = await check(spec([lead('a', { worktree: { existing: 'nope' } })]))
      expect(errorAt(gone.errors, 'nodes.a.worktree.existing')!.error).toContain("doesn't exist")
    } finally {
      done()
    }
  })

  test("an existing worktree that is the active run's checkout is refused", async () => {
    await git('worktree', 'add', '-q', '-b', 'part-a', join(dir, 'wt-a'))
    const r = await check(spec([lead('a', { worktree: { existing: 'wt-a' } })]), { activeRunCheckout: join(dir, 'wt-a') })
    expect(errorAt(r.errors, 'nodes.a.worktree.existing')!.error).toContain("active litter run's checkout")
  })

  test('two nodes naming one existing worktree, spelt two ways, share it', async () => {
    await git('worktree', 'add', '-q', '-b', 'part-a', join(dir, 'wt-a'))
    const r = await check(
      spec([
        { id: 'a', kind: 'orchestrator', worktree: { existing: 'wt-a' }, authority: RO },
        { id: 'b', kind: 'orchestrator', worktree: { existing: join(dir, 'wt-a') }, authority: RO },
      ]),
    )
    expect(errorAt(r.errors, 'nodes.b.paths')!.error).toContain('as a does')
  })

  test("a new branch git won't take, under sw/, twice, from a commit that doesn't resolve, or one that already exists elsewhere", async () => {
    await git('branch', 'taken')
    await git('commit', '-q', '--allow-empty', '-m', 'two')
    const r = await check(
      spec([
        lead('a', { worktree: { new: { from: 'main', branch: 'bad..name' } } }),
        lead('b', { worktree: { new: { from: 'main', branch: 'sw/alpha/x-1' } } }),
        lead('c', { worktree: { new: { from: 'main', branch: 'feature' } } }),
        lead('d', { worktree: { new: { from: 'main', branch: 'feature' } } }),
        lead('e', { worktree: { new: { from: 'no-such-ref', branch: 'e' } } }),
        lead('f', { worktree: { new: { from: 'main', branch: 'taken' } } }),
        lead('g', { worktree: { new: { from: 'main', branch: 'main' } } }),
      ]),
    )
    expect(fields(r.errors)).toEqual([
      'nodes.a.worktree.new.branch',
      'nodes.e.worktree.new.from',
      'nodes.f.worktree.new.branch',
      'nodes.g.worktree.new.branch',
      'nodes.b.worktree.new.branch',
      'nodes.d.worktree.new.branch',
    ])
    expect(errorAt(r.errors, 'nodes.f.worktree.new.branch')!.error).toContain('already exists')
    expect(errorAt(r.errors, 'nodes.g.worktree.new.branch')!.error).toContain('is checked out at')
  })

  test("a node id that reads as an own worker's instance is refused", async () => {
    const r = await check(spec([lead('o', { spawns: { fixer: 1 } }), reader('fixer', { worktree: 'own' }), lead('fixer-2')]))
    expect(errorAt(r.errors, 'nodes.fixer-2.id')!.error).toContain('instance 2 of the own worker fixer')
  })

  test('paths must be relative, with no empty, . or .. part', async () => {
    const r = await check(spec([lead('a', { paths: ['/etc/passwd', 'src/../x', 'ok/', 'a//b'] })]))
    expect(fields(r.errors)).toEqual(['nodes.a.paths[0]', 'nodes.a.paths[1]', 'nodes.a.paths[3]'])
  })
})

describe('briefs', () => {
  test('a brief that is missing, or over 16 KiB, is refused', async () => {
    briefs.big = 'x'.repeat(16 * 1024 + 1)
    briefs.ok = 'fine'
    const r = await check(spec([lead('missing', { brief: 'briefs/missing.md' }), lead('big', { brief: 'briefs/big.md' }), lead('ok', { brief: 'briefs/ok.md' })]))
    expect(fields(r.errors)).toEqual(['nodes.missing.brief', 'nodes.big.brief'])
    expect(errorAt(r.errors, 'nodes.big.brief')!.error).toContain('at most 16 KiB')
  })
})

test('every error comes back at once, the schema first', async () => {
  const r = await check({
    ...spec([lead('top', { spawns: { a: 1 } }), reader('a', { spawns: { a: 1 } }), lead('x', { brief: 'briefs/x.md' })]),
    stray: true,
  })
  expect(r.errors[0]).toEqual(expect.objectContaining({ field: 'stray' }))
  expect(fields(r.errors)).toEqual(['stray', 'nodes.a.spawns.a', 'nodes.x.brief'])
})
