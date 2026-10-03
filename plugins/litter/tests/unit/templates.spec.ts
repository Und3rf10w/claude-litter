// Tier 2: the templates (hooks/swarm/templates.ts; plan 15.5, section 12's
// template cases): each built-in filled in and validated, params and
// `repeat`, a template of yours saved and read back, a project template that
// listing only reads, and saving the current tree with parameters.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Template } from '../../hooks/swarm/types'
import {
  BUILTIN_TEMPLATES,
  instantiate,
  listTemplates,
  loadTemplate,
  parameterize,
  saveTemplate,
  templateOffers,
} from '../../hooks/swarm/templates'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const W = ['Edit', 'Write', 'NotebookEdit']
const RO = { commit: false, push: 'none', forcePush: false, rewriteHistory: false, worktreeOps: false } as const

let p: TestPorts
let dir: string
let litterDir: string
let cleanup: () => void
let git: (...argv: string[]) => Promise<string>

beforeEach(async () => {
  ;({ dir, cleanup } = scratch())
  p = nodePorts({ cwd: dir })
  ;({ git } = await scratchRepo(p, dir))
  litterDir = join(dir, '.claude', 'litter')
})
afterEach(() => cleanup())

const builtin = (name: string): Template => BUILTIN_TEMPLATES.find(t => t.name === name)!
const ids = (r: { spec: { nodes: { id: string }[] } }) => r.spec.nodes.map(n => n.id)
/** Every file and folder under `root`, sorted. */
const tree = (root: string): string[] => (existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]).sort() : [])

/** A template of yours: one read-only orchestrator per area, each spawning a reader. */
const areas = (scope: 'user' | 'project'): Template => ({
  name: 'areas',
  description: 'One orchestrator per area',
  scope,
  params: [
    { name: 'label', type: 'string' },
    { name: 'areas', type: 'list', description: 'The areas' },
  ],
  repeat: { 'area-{item}': 'areas' },
  spec: {
    name: '{label}',
    goal: 'Look over {areas}',
    nodes: [
      { id: 'area-{item}', kind: 'orchestrator', brief: 'briefs/area-{item}.md', task: 'Look at {item}', worktree: 'none', tools: { deny: W }, authority: RO, spawns: { reader: 1 } },
      { id: 'reader', kind: 'worker', brief: 'briefs/reader.md', tools: { deny: W }, authority: RO },
    ],
  },
  briefs: { 'area-{item}': 'You look at {item}.\n', reader: 'You read what you are sent.\n' },
})

describe('the built-ins', () => {
  test('there are four, and their briefs and descriptions hold no backticks, no ${ and no model', () => {
    expect(BUILTIN_TEMPLATES.map(t => [t.name, t.scope])).toEqual([
      ['branch-per-orchestrator', 'builtin'],
      ['research-fan-out', 'builtin'],
      ['review-panel', 'builtin'],
      ['pipeline', 'builtin'],
    ])
    for (const t of BUILTIN_TEMPLATES) {
      const text = [t.description, ...Object.values(t.briefs), JSON.stringify(t.spec)].join('\n')
      expect(text).not.toContain('`')
      expect(text).not.toContain('${')
      expect(text).not.toMatch(/opus|sonnet|haiku|claude-/i)
      expect(t.spec.nodes.every(n => n.model === undefined)).toBe(true)
      for (const n of t.spec.nodes) if (n.brief !== undefined) expect(Object.hasOwn(t.briefs, n.id)).toBe(true)
    }
  })

  test('branch-per-orchestrator: one orchestrator per branch, a branch name cut to a slug in its id', async () => {
    await git('branch', 'feature/login')
    await git('branch', 'fix-2')
    const r = await instantiate(p, litterDir, builtin('branch-per-orchestrator'), { name: 'Two Branches', goal: 'Ship them', branches: ['feature/login', 'fix-2'] })
    expect(r.check.errors).toEqual([])
    expect(r.check.ok).toBe(true)
    expect(r.spec.name).toBe('two-branches')
    expect(ids(r)).toEqual(['feature-login', 'fix-2', 'reviewer', 'fixer', 'fix-reviewer'])
    expect(r.spec.nodes[0]).toEqual(
      expect.objectContaining({
        brief: 'briefs/feature-login.md',
        task: 'Work on branch feature/login toward the goal, as your brief describes.',
        worktree: { new: { from: 'feature/login', branch: 'feature/login' } },
        spawns: { reviewer: 2, fixer: 2, 'fix-reviewer': 1 },
      }),
    )
    expect(Object.keys(r.briefs).sort()).toEqual(['feature-login', 'fix-2', 'fix-reviewer', 'fixer', 'reviewer'])
    expect(r.briefs['fix-2']).toContain('You own branch fix-2.')
  })

  test('research-fan-out and pipeline validate; review-panel takes its default lenses', async () => {
    const research = await instantiate(p, litterDir, builtin('research-fan-out'), { name: 'dig', goal: 'Why is it slow' })
    expect([research.check.errors, ids(research)]).toEqual([[], ['research', 'researcher', 'synthesizer']])
    const pipe = await instantiate(p, litterDir, builtin('pipeline'), { name: 'pipe', goal: 'Add the flag', branch: 'work/flag' })
    expect(pipe.check.errors).toEqual([])
    expect(pipe.spec.nodes[0]!.worktree).toEqual({ new: { from: 'HEAD', branch: 'work/flag' } })
    expect(pipe.briefs.pipeline).toContain('on branch work/flag')
    const panel = await instantiate(p, litterDir, builtin('review-panel'), { name: 'panel', goal: 'Review the change' })
    expect([panel.check.errors, ids(panel)]).toEqual([[], ['review-correctness', 'review-security', 'review-tests']])
    expect(panel.spec.nodes[1]!.task).toBe('Review what the goal names through one lens: security.')
  })

  test('a list given as one string is split at commas and new lines', async () => {
    const r = await instantiate(p, litterDir, builtin('review-panel'), { name: 'panel', goal: 'g', lenses: 'Perf, API\n docs ,' })
    expect(ids(r)).toEqual(['review-perf', 'review-api', 'review-docs'])
    expect(r.check.ok).toBe(true)
  })

  test('a param with no value is an error at params.<name>, before the spec\'s own', async () => {
    const r = await instantiate(p, litterDir, builtin('pipeline'), { goal: '  ' })
    expect(r.check.ok).toBe(false)
    expect(r.check.errors.slice(0, 3).map(e => e.field)).toEqual(['params.name', 'params.goal', 'params.branch'])
    expect(r.check.errors[2]!.error).toContain('The new branch the work goes on')
    const none = await instantiate(p, litterDir, builtin('review-panel'), { name: 'x', goal: 'g', lenses: [] })
    expect(none.check.errors.map(e => e.field)).toContain('params.lenses')
  })
})

describe('yours and the project\'s', () => {
  test('a template of yours is saved without its scope, listed, and repeats over three items', async () => {
    p.configDirValue = join(dir, 'config')
    const path = await saveTemplate(p, litterDir, areas('user'))
    expect(path).toBe(join(dir, 'config', 'litter', 'swarm-templates', 'areas.json'))
    const file = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    expect(file.scope).toBeUndefined()
    expect(file.name).toBe('areas')
    const listed = await listTemplates(p, litterDir)
    expect(listed.map(t => [t.scope, t.name, t.path])).toEqual([
      ...BUILTIN_TEMPLATES.map(t => ['builtin', t.name, null]),
      ['user', 'areas', path],
    ])
    const t = (await loadTemplate(p, litterDir, 'user', 'areas'))!
    expect(t).toEqual(areas('user'))
    const r = await instantiate(p, litterDir, t, { label: 'Three Areas', areas: ['api', 'ui', 'db'] })
    expect(r.check.errors).toEqual([])
    expect(r.spec.name).toBe('three-areas')
    expect(r.spec.goal).toBe('Look over api, ui, db')
    expect(ids(r)).toEqual(['area-api', 'area-ui', 'area-db', 'reader'])
    expect(r.spec.nodes.filter(n => n.kind === 'orchestrator').map(n => [n.task, n.brief])).toEqual([
      ['Look at api', 'briefs/area-api.md'],
      ['Look at ui', 'briefs/area-ui.md'],
      ['Look at db', 'briefs/area-db.md'],
    ])
    expect(r.briefs['area-db']).toBe('You look at db.\n')
    expect(await loadTemplate(p, litterDir, 'project', 'areas')).toBeNull()
  })

  test('saving refuses a built-in\'s scope, a template that isn\'t one, and yours with no config dir', async () => {
    await expect(saveTemplate(p, litterDir, { ...areas('user'), scope: 'builtin' })).rejects.toThrow("'user'")
    await expect(saveTemplate(p, litterDir, { ...areas('project'), name: 'Bad Name' })).rejects.toThrow("can't be saved")
    await expect(saveTemplate(p, litterDir, { ...areas('project'), repeat: { ghost: 'areas' } })).rejects.toThrow('ghost')
    await expect(saveTemplate(p, litterDir, areas('user'))).rejects.toThrow('no config dir')
    expect(await listTemplates(p, litterDir)).toHaveLength(4)
  })

  test('a project template is only read: listing it writes nothing, and a bad file or a link is left out and logged', async () => {
    const folder = join(litterDir, 'swarm-templates')
    mkdirSync(folder, { recursive: true })
    const { scope: _s, ...file } = areas('project')
    writeFileSync(join(folder, 'areas.json'), JSON.stringify(file))
    writeFileSync(join(folder, 'broken.json'), '{ not json')
    writeFileSync(join(folder, 'misnamed.json'), JSON.stringify({ ...file, name: 'other' }))
    writeFileSync(join(dir, 'outside.json'), JSON.stringify({ ...file, name: 'linked' }))
    symlinkSync(join(dir, 'outside.json'), join(folder, 'linked.json'))
    const before = tree(dir)
    const listed = await listTemplates(p, litterDir)
    expect(listed.filter(t => t.scope !== 'builtin')).toEqual([{ name: 'areas', description: 'One orchestrator per area', scope: 'project', params: file.params, path: join(folder, 'areas.json') }])
    expect(tree(dir)).toEqual(before)
    expect(p.storeMap.size).toBe(0)
    expect(p.logs.filter(l => l.includes('broken.json') || l.includes('misnamed.json'))).toHaveLength(2)
    expect(p.logs.some(l => l.includes('linked.json'))).toBe(false)
  })
})

describe('saving the current tree as a template', () => {
  test('offers the values tied to this job, and the picked ones become params with today\'s value as default', async () => {
    const pipe = await instantiate(p, litterDir, builtin('pipeline'), { name: 'pipe', goal: 'Add the flag', branch: 'work/flag' })
    const offers = templateOffers(pipe.spec)
    expect(offers.map(o => [o.field, o.param])).toEqual([
      ['name', 'name'],
      ['goal', 'goal'],
      ['nodes.pipeline.task', 'pipeline_task'],
      ['nodes.pipeline.worktree.new.from', 'pipeline_from'],
      ['nodes.pipeline.worktree.new.branch', 'pipeline_branch'],
    ])
    const picked = offers.filter(o => o.field === 'goal' || o.field.endsWith('.branch'))
    const t = parameterize({ name: 'my-pipe', description: 'Mine', scope: 'project' }, pipe.spec, pipe.briefs, picked)
    expect(t.params).toEqual([
      { name: 'goal', type: 'string', default: 'Add the flag' },
      { name: 'pipeline_branch', type: 'string', default: 'work/flag' },
    ])
    expect(t.spec.goal).toBe('{goal}')
    expect(t.spec.nodes[0]!.worktree).toEqual({ new: { from: 'HEAD', branch: '{pipeline_branch}' } })
    expect(pipe.spec.goal).toBe('Add the flag')
    await saveTemplate(p, litterDir, t)
    const again = await instantiate(p, litterDir, (await loadTemplate(p, litterDir, 'project', 'my-pipe'))!, { pipeline_branch: 'work/other' })
    expect(again.check.errors).toEqual([])
    expect(again.spec.goal).toBe('Add the flag')
    expect(again.spec.nodes[0]!.worktree).toEqual({ new: { from: 'HEAD', branch: 'work/other' } })
  })

  test('long node ids still give param names a template takes, one per value, when two ids share their start', async () => {
    // 32 characters each, the most a node id has.
    const a = 'frontend-checkout-flow-refactor1'
    const b = 'frontend-checkout-flow-refactor2'
    const spec = {
      name: 'long',
      goal: 'g',
      nodes: [a, b].map(id => ({ id, kind: 'orchestrator' as const, task: `do ${id}`, worktree: { new: { from: 'HEAD', branch: `work/${id}` } } })),
    }
    const offers = templateOffers(spec)
    const params = offers.map(o => o.param)
    expect(new Set(params).size).toBe(params.length)
    expect(params.every(x => /^[a-z][a-z0-9_]{0,31}$/.test(x))).toBe(true)
    const t = parameterize({ name: 'long-ids', description: 'Long ids', scope: 'project' }, spec, {}, offers.slice(2))
    await saveTemplate(p, litterDir, t)
    const back = (await loadTemplate(p, litterDir, 'project', 'long-ids'))!
    expect(back.params.map(x => x.name)).toEqual(params.slice(2))
  })
})
