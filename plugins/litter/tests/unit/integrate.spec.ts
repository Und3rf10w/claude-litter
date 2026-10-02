// Tier 2: a fanout's integrate record against real git in scratch repos (plan
// section 7, fanout.js steps 3 and 4, "Ownership"; section 9, "Run
// worktrees", "Checked again at use"; section 12's ownership, binding and
// integration-branch cases). The writers' worktrees and branches are made
// here with git, and their worktree.create, task.bind and task.result records
// appended directly, as packages F and E would leave them.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fanoutSummary, markerLines, recordIntegrate } from '../../hooks/integrate'
import { appendRecord, headKey, readLedger } from '../../hooks/ledgercore'
import { normalizeOptions } from '../../hooks/options'
import { outPath } from '../../hooks/layout'
import { writePolicy, readPolicy } from '../../hooks/policy'
import type { Policy } from '../../hooks/hookfiles'
import type { Caller, RecordCtx, RecordError, StoredRecord } from '../../hooks/records/core'
import type { RunJson } from '../../hooks/records/run'
import type { IntegrateConflictBody, IntegrateDoneBody, IntegrateMergeBody, IntegrateReply, WorktreeCreateBody } from '../../hooks/records/fanout'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

const RUN = '20261002-fan'
const REF = `refs/heads/litter/${RUN}`
const IB = `litter/${RUN}-integration`
const WF = 'wf_1a2b3c4d-5e6'
const RELAY: Caller = { agentId: 'relay-1', agentType: 'litter:relay' }
const MOD = { source: 'mod' } as const

// Each test runs dozens of real git commands, slow on a busy machine.
setDefaultTimeout(60_000)

type Task = { id: string; title: string; text: string; writes: boolean; files: string[] }
const TASKS: Task[] = [
  { id: 'a', title: 'Package A', text: 'do A', writes: true, files: ['pkgA/'] },
  { id: 'b', title: 'Package B', text: 'do B', writes: true, files: ['pkgB/'] },
  { id: 'c', title: 'The C doc', text: 'do C', writes: true, files: ['docs/c.md'] },
  { id: 'r', title: 'Research', text: 'find out', writes: false, files: [] },
]

let p: TestPorts
let dir: string
let litterDir: string
let runDir: string
let root: string
let base: string
let integration: string
let git: (...argv: string[]) => Promise<string>
let cleanups: (() => void)[]

beforeEach(async () => {
  p = nodePorts()
  const repo = scratch()
  const out = scratch()
  dir = repo.dir
  cleanups = [repo.cleanup, out.cleanup]
  ;({ git } = await scratchRepo(p, dir))
  write(dir, 'docs/c.md', 'c\n')
  write(dir, 'shared.ts', 'export const v = 1\n')
  await git('add', '-A')
  await git('commit', '-q', '-m', 'base')
  base = (await git('rev-parse', 'HEAD')).trim()
  await git('switch', '-q', '-c', `litter/${RUN}`)
  litterDir = join(out.dir, '.claude', 'litter')
  runDir = join(litterDir, RUN)
  root = join(realpathSync(out.dir), '.claude', 'worktrees')
  await writeRun()
  integration = await addIntegration()
})
afterEach(() => cleanups.forEach(c => c()))

function write(at: string, path: string, text: string): void {
  mkdirSync(join(at, path, '..'), { recursive: true })
  writeFileSync(join(at, path), text)
}

async function writeRun(tasks: Task[] = TASKS, mergeOrder = ['b', 'a', 'c']): Promise<void> {
  const json: RunJson = {
    v: 1,
    run: RUN,
    workflow: 'fanout',
    args: {
      run: RUN,
      tasks: tasks.map(t => ({ ...t, rules: [], ...(t.writes ? { bind: `token-${t.id}` } : {}) })),
      contract: '',
      mergeOrder: mergeOrder.filter(id => tasks.some(t => t.id === id && t.writes)),
    },
    authorized: [],
    mode: 'auto',
    verify: ['true'],
    goalCheck: null,
    setup: null,
    linkDirs: [],
    base,
    ref: REF,
    checkout: dir,
    isolate: false,
    previousBranch: 'main',
    continueOf: null,
    amendOf: null,
    rules: [],
    planPath: null,
    planSha256: null,
    session: 'test-session',
    created: 0,
  }
  await p.fs.write(join(runDir, 'run.json'), JSON.stringify(json))
}

const ctx = (caller: Caller): RecordCtx => ({ p, caller, litterDir, options: normalizeOptions({}) })
const agent = (id: string) => ({ source: 'agent' as const, agentId: id, agentType: 'litter:executor' })
const gitIn = async (at: string, ...argv: string[]): Promise<string> => {
  const r = await p.run(['git', ...argv], { cwd: at })
  if (r.code !== 0) throw new Error(`git ${argv.join(' ')}: ${r.stderr.trim()}`)
  return r.stdout
}

/** A worktree as worktree.sh or addModWorktree leave it: on its new branch at base, with its worktree.create. */
async function addWorktree(name: string, branch: string, from = base): Promise<string> {
  const path = join(root, name)
  await git('worktree', 'add', '-q', '-b', branch, path, from)
  const body: WorktreeCreateBody = { run: RUN, name, path, branch, base, disposable: false, ignored: [] }
  await appendRecord(p, runDir, { run: RUN, kind: 'worktree.create', by: MOD, body })
  return path
}

const addIntegration = () => addWorktree(`litter-${RUN}-integration`, IB)

type Writer = { name: string; path: string; branch: string; agentId: string }

/**
 * A writer: its worktree, its files (null deletes), its commit, its binding and
 * its result, each optional, as the run would leave them.
 */
async function writer(
  task: string,
  n: number,
  files: Record<string, string | null>,
  opts: { commit?: boolean; bind?: boolean; status?: 'done' | 'blocked' | null; from?: string; summary?: string } = {},
): Promise<Writer> {
  const name = `${WF}-${n}`
  const branch = `litter/${RUN}-w${n}`
  const path = await addWorktree(name, branch, opts.from)
  for (const [f, text] of Object.entries(files)) {
    if (text === null) rmSync(join(path, f))
    else write(path, f, text)
  }
  if (opts.commit !== false && Object.keys(files).length > 0) {
    await gitIn(path, 'add', '-A')
    await gitIn(path, 'commit', '-q', '-m', `${RUN} ${task}`)
  }
  const agentId = `writer-${n}`
  if (opts.bind !== false) await bind(task, { name, path, branch, agentId })
  const status = opts.status === undefined ? 'done' : opts.status
  if (status !== null) await result(task, agentId, status, opts.summary)
  return { name, path, branch, agentId }
}

const bind = (task: string, w: Writer) =>
  appendRecord(p, runDir, { run: RUN, kind: 'task.bind', by: agent(w.agentId), body: { task, worktree: { name: w.name, path: w.path, branch: w.branch } } })

const result = (task: string | null, agentId: string, status: 'done' | 'blocked', summary = `${status} ${task}`) =>
  appendRecord(p, runDir, {
    run: RUN,
    kind: 'task.result',
    by: agent(agentId),
    body: { task, role: 'executor', tool_use_id: `tu-${agentId}-${status}`, result: { status, files: [], checks: [], summary, notes: '' } },
  })

async function integrate(caller: Caller = RELAY): Promise<IntegrateReply> {
  const r = await recordIntegrate(ctx(caller), { kind: 'integrate', run: RUN })
  if (!r.ok) throw new Error(`integrate refused the call: ${(r as RecordError).error}`)
  return r as unknown as IntegrateReply
}

const records = async () => (await readLedger(p, runDir, RUN)).records
const kinds = async () => (await records()).map(r => r.kind)
const ofKind = async <B>(kind: string) => (await records()).filter(r => r.kind === kind) as StoredRecord<B>[]
const tipOf = async (ref: string) => (await git('rev-parse', ref)).trim()
const outFile = () => JSON.parse(readFileSync(outPath(litterDir, RELAY.agentId!), 'utf8'))
const mergeHead = async () => (await p.run(['git', 'rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: integration })).stdout.trim()

describe('integrate: clean merges', () => {
  test('merges every task in mergeOrder, each --no-ff, with only the mod merges on the first-parent chain', async () => {
    const a = await writer('a', 1, { 'pkgA/a.ts': 'export const a = 1\n' })
    const b = await writer('b', 2, { 'pkgB/b.ts': 'export const b = 2\n', 'pkgB/more.ts': 'm\n' })
    await writer('c', 3, { 'docs/c.md': 'c, improved\n' })
    const r = await integrate()
    expect(r.status).toBe('merged')
    expect(r.where).toBe(integration)
    expect(r.base).toBe(base)
    expect(r.merged).toEqual(['b', 'a', 'c'])
    expect(r.skipped).toEqual([])
    const tip = await tipOf(IB)
    expect(r.tip).toBe(tip)
    expect(r.tree).toBe((await git('rev-parse', `${tip}^{tree}`)).trim())
    expect(r.changed).toEqual([
      { path: 'docs/c.md', task: 'c', integrator_extra: false },
      { path: 'pkgA/a.ts', task: 'a', integrator_extra: false },
      { path: 'pkgB/b.ts', task: 'b', integrator_extra: false },
      { path: 'pkgB/more.ts', task: 'b', integrator_extra: false },
    ])
    // The first-parent chain is the mod's merges only, each with two parents.
    const chain = (await git('log', '--first-parent', '--format=%P%x09%s', `${base}..${tip}`)).trim().split('\n')
    expect(chain.map(l => l.split('\t')[1])).toEqual([`litter: merge c of ${RUN}`, `litter: merge a of ${RUN}`, `litter: merge b of ${RUN}`])
    for (const l of chain) expect(l.split('\t')[0]!.split(' ')).toHaveLength(2)
    expect((await git('rev-parse', `${tip}^2`)).trim()).not.toBe(base)
    const merges = await ofKind<IntegrateMergeBody>('integrate.merge')
    expect(merges.map(m => m.body.task)).toEqual(['b', 'a', 'c'])
    expect(merges[0]!.body).toEqual({ task: 'b', branch: b.branch, commit: merges[0]!.body.commit, paths: ['pkgB/b.ts', 'pkgB/more.ts'] })
    expect(merges[1]!.body.branch).toBe(a.branch)
    expect(merges.every(m => m.by.source === 'mod')).toBe(true)
    // The answer cites integrate.done, and went to the relay's out file first.
    const done = (await ofKind<IntegrateDoneBody>('integrate.done'))[0]!
    expect(r.integrate_id).toBe(`i${done.seq}`)
    expect(done.body).toEqual({ tip, tree: r.tree!, changed: r.changed!, blocked: [] })
    const { ok: _ok, ...fields } = r
    expect(outFile()).toEqual({ v: 1, agent_id: RELAY.agentId, for: { integrate_id: r.integrate_id }, fields })
    // The integration worktree is clean at the tip.
    expect((await gitIn(integration, 'status', '--porcelain')).trim()).toBe('')
  })

  test('a second call after merged answers the same and changes nothing', async () => {
    await writer('a', 1, { 'pkgA/a.ts': 'a\n' })
    await writer('b', 2, { 'pkgB/b.ts': 'b\n' })
    await writer('c', 3, { 'docs/c.md': 'c2\n' })
    const first = await integrate()
    const before = await kinds()
    const tip = await tipOf(IB)
    expect(await integrate()).toEqual(first)
    expect(await kinds()).toEqual(before)
    expect(await tipOf(IB)).toBe(tip)
  })

  test('the integration branch coexists with the run branch, and policy.json names the integration worktree', async () => {
    const policy: Policy = {
      v: 1,
      session: 'test-session',
      litterDir,
      run: {
        run: RUN,
        workflow: 'fanout',
        runDir,
        checkout: dir,
        base,
        runIds: [],
        launching: false,
        stopping: false,
        inflight: null,
        isolationLost: false,
        roots: { checkout: dir, litterDir, litterCopies: [litterDir], ruleDirs: [], worktrees: [], integration: null },
        setup: null,
        linkDirs: [],
        worktreeRoot: root,
      },
      roles: {},
      swarm: null,
    }
    await writePolicy(p, litterDir, policy)
    await writeRun(TASKS.filter(t => !t.writes))
    const r = await integrate()
    expect(r).toMatchObject({ status: 'merged', merged: [], skipped: [], tip: base, changed: [] })
    expect((await readPolicy(p, litterDir))!.run!.roots.integration).toBe(integration)
    expect((await git('for-each-ref', '--format=%(refname)', 'refs/heads/litter/')).trim().split('\n').sort()).toEqual([REF, `refs/heads/${IB}`].sort())
    expect(await tipOf(REF)).toBe(base)
  })
})

describe('integrate: ownership', () => {
  test('a branch that also changes an unowned file, another task\'s file, or moves an owned file out is skipped with unowned', async () => {
    await writer('a', 1, { 'pkgA/a.ts': 'a\n', 'ci.yml': 'on: push\n' })
    await writer('b', 2, { 'pkgB/b.ts': 'b\n', 'pkgA/a2.ts': 'from b\n' })
    // c moves its owned file out of its area: --no-renames reports both sides.
    const c = await writer('c', 3, {}, { commit: false })
    mkdirSync(join(c.path, 'misc'), { recursive: true })
    await gitIn(c.path, 'mv', 'docs/c.md', 'misc/c.md')
    await gitIn(c.path, 'commit', '-q', '-m', 'move c')
    const r = await integrate()
    expect(r.status).toBe('merged')
    expect(r.merged).toEqual([])
    expect(r.skipped.map(s => [s.task, s.unowned])).toEqual([
      ['b', ['pkgA/a2.ts']],
      ['a', ['ci.yml']],
      ['c', ['misc/c.md']],
    ])
    expect(r.skipped[0]!.reason).toMatch(/changes paths task b doesn't own: pkgA\/a2\.ts/)
    expect(await kinds()).toContain('integrate.skip')
    expect(await tipOf(IB)).toBe(base)
    expect(r.changed).toEqual([])
  })

  test('a tip carrying a path no merged task owns is refused at the whole-result check', async () => {
    const a = await writer('a', 1, { 'pkgA/a.ts': 'a\n' })
    await writeRun(TASKS.filter(t => t.id === 'a'))
    // Something slipped past the per-branch check: a's merge, then a stray commit, recorded as a's merge.
    await gitIn(integration, 'merge', '-q', '--no-ff', '-m', 'by hand', a.branch)
    write(integration, 'stray.txt', 'x\n')
    await gitIn(integration, 'add', 'stray.txt')
    await gitIn(integration, 'commit', '-q', '-m', 'stray')
    const commit = await tipOf(IB)
    await appendRecord(p, runDir, { run: RUN, kind: 'integrate.merge', by: MOD, body: { task: 'a', branch: a.branch, commit, paths: ['pkgA/a.ts'] } })
    const r = await integrate()
    expect(r.status).toBe('refused')
    expect(r.reason).toBe('stray.txt is owned by no task')
    expect(r.tip).toBeUndefined()
    const done = (await ofKind<IntegrateDoneBody>('integrate.done'))[0]!.body
    expect(done.blocked).toEqual(['stray.txt is owned by no task'])
    expect(done.changed).toEqual([
      { path: 'pkgA/a.ts', task: 'a', integrator_extra: false },
      { path: 'stray.txt', task: null, integrator_extra: false },
    ])
    // The same answer again.
    expect(await integrate()).toEqual(r)
  })
})

describe('integrate: what is merged, and what is skipped', () => {
  test('a fork point that is not base, a name starting with -, a blocked task, a task with no result', async () => {
    const parent = (await git('rev-parse', `${base}^`)).trim()
    await writer('a', 1, { 'pkgA/a.ts': 'a\n' }, { from: parent })
    // A recorded worktree whose branch would read as an option.
    await appendRecord(p, runDir, {
      run: RUN,
      kind: 'worktree.create',
      by: MOD,
      body: { run: RUN, name: `${WF}-2`, path: join(root, `${WF}-2`), branch: '-oops', base, disposable: false, ignored: [] } satisfies WorktreeCreateBody,
    })
    await bind('b', { name: `${WF}-2`, path: join(root, `${WF}-2`), branch: '-oops', agentId: 'writer-2' })
    await result('b', 'writer-2', 'done')
    const c = await writer('c', 3, { 'docs/c.md': 'half\n' }, { commit: false, status: 'blocked', summary: 'the C spec is missing' })
    const r = await integrate()
    expect(r.status).toBe('merged')
    const reasons = Object.fromEntries(r.skipped.map(s => [s.task, s.reason]))
    expect(reasons.a).toMatch(new RegExp(`forks from ${parent}, not the run's base ${base}`))
    expect(reasons.b).toMatch(/"-oops" isn't a name litter passes to git/)
    expect(reasons.c).toMatch(/^task c returned blocked: the C spec is missing; its worktree also has uncommitted changes, which aren't merged: docs\/c\.md$/)
    expect(c.path).toContain(WF)
    expect(r.merged).toEqual([])
    expect(await tipOf(IB)).toBe(base)
  })

  test('a task with no result is skipped, and so is a done task whose writer isn\'t bound', async () => {
    await writer('a', 1, { 'pkgA/a.ts': 'a\n' }, { status: null })
    await writer('b', 2, { 'pkgB/b.ts': 'b\n' }, { bind: false, status: null })
    await result('b', 'writer-2', 'done')
    await writer('c', 3, { 'docs/c.md': 'c, done\n' })
    const r = await integrate()
    const reasons = Object.fromEntries(r.skipped.map(s => [s.task, s.reason]))
    expect(reasons.a).toBe('task a has no result')
    expect(reasons.b).toBe("task b isn't bound to a worktree")
    expect(r.merged).toEqual(['c'])
    // b's worktree has a commit and no binding: that blocks.
    expect(r.status).toBe('refused')
    expect(r.reason).toMatch(new RegExp(`worktree ${WF}-2 at .* has 1 commit\\(s\\) past base on litter/${RUN}-w2, and no writer was bound to it`))
  })

  test('an unbound worktree with changes blocks; a superseded one with changes does not', async () => {
    // a: first bound in w1, which stopped with an uncommitted change; rebound in w2, which did the work.
    const w1 = await writer('a', 1, { 'pkgA/draft.ts': 'draft\n' }, { commit: false, status: null })
    const w2 = await writer('a', 2, { 'pkgA/a.ts': 'a\n' })
    await writer('b', 3, { 'pkgB/b.ts': 'b\n' })
    await writer('c', 4, { 'docs/c.md': 'c, done\n' })
    const r = await integrate()
    expect(r.status).toBe('merged')
    expect(r.merged).toEqual(['b', 'a', 'c'])
    expect((await ofKind<IntegrateMergeBody>('integrate.merge')).find(m => m.body.task === 'a')!.body.branch).toBe(w2.branch)
    expect(r.changed!.map(c => c.path)).not.toContain('pkgA/draft.ts')
    expect(w1.path).not.toBe(w2.path)
  })

  test('a recorded worktree with uncommitted changes and no binding blocks the land, naming it', async () => {
    await writer('a', 1, { 'pkgA/a.ts': 'a\n' })
    await writer('b', 2, { 'pkgB/b.ts': 'b\n' })
    await writer('c', 3, { 'docs/c.md': 'c, done\n' })
    const stray = await writer('a', 4, { 'pkgA/x.ts': 'x\n' }, { commit: false, bind: false, status: null })
    const r = await integrate()
    expect(r.status).toBe('refused')
    expect(r.merged).toEqual(['b', 'a', 'c'])
    expect(r.reason).toBe(`worktree ${WF}-4 at ${stray.path} has uncommitted changes (pkgA/x.ts), and no writer was bound to it`)
  })

  test("a result from a writer bound elsewhere isn't merged", async () => {
    const w = await writer('a', 1, { 'pkgA/a.ts': 'a\n' }, { status: null })
    await result('a', 'someone-else', 'done')
    await writeRun(TASKS.filter(t => t.id === 'a'))
    const r = await integrate()
    expect(r.skipped).toEqual([{ task: 'a', reason: `task a's latest result isn't from a writer bound to ${w.path}` }])
  })
})

describe('integrate: conflicts', () => {
  // Two tasks that both own shared.ts: run.start refuses that, so a conflict is built by writing run.json directly.
  const OVERLAP: Task[] = [
    { id: 'a', title: 'A', text: 'a', writes: true, files: ['shared.ts', 'pkgA/'] },
    { id: 'b', title: 'B', text: 'b', writes: true, files: ['shared.ts', 'pkgB/'] },
    { id: 'c', title: 'C', text: 'c', writes: true, files: ['docs/c.md'] },
  ]

  async function conflicted(): Promise<{ r: IntegrateReply; b: Writer }> {
    await writeRun(OVERLAP, ['a', 'b', 'c'])
    await writer('a', 1, { 'shared.ts': 'export const v = 2 // a\n', 'pkgA/a.ts': 'a\n' })
    const b = await writer('b', 2, { 'shared.ts': 'export const v = 3 // b\n', 'pkgB/b.ts': 'b\n' })
    await writer('c', 3, { 'docs/c.md': 'c, done\n' })
    const r = await integrate()
    return { r, b }
  }

  test('stops at the conflict with its files, leaves the merge in progress, and answers the same until something changes', async () => {
    const { r, b } = await conflicted()
    expect(r.status).toBe('conflict')
    expect(r.conflict).toEqual({ task: 'b', branch: b.branch, files: ['shared.ts'] })
    expect(r.merged).toEqual(['a'])
    expect(r.where).toBe(integration)
    const rec = (await ofKind<IntegrateConflictBody>('integrate.conflict'))[0]!
    expect(r.integrate_id).toBe(`i${rec.seq}`)
    expect(rec.body).toMatchObject({ task: 'b', branch: b.branch, files: ['shared.ts'], commit: await tipOf(b.branch) })
    expect(await mergeHead()).toBe(await tipOf(b.branch))
    expect(readFileSync(join(integration, 'shared.ts'), 'utf8')).toContain('<<<<<<< ')
    expect(outFile().for).toEqual({ integrate_id: r.integrate_id })
    // A retried relay before the integrator ran: the same conflict, nothing recorded.
    const before = await kinds()
    expect(await integrate()).toEqual(r)
    expect(await kinds()).toEqual(before)
  })

  test("a resolution with an extra path is finished as integrate.merge with integrator_extra, then the rest merged", async () => {
    const { b } = await conflicted()
    const head = await tipOf(IB)
    write(integration, 'shared.ts', 'export const v = 3 // a and b\n')
    write(integration, 'glue/extra.ts', 'export const glue = true\n')
    const r = await integrate()
    expect(r.status).toBe('merged')
    expect(r.merged).toEqual(['a', 'b', 'c'])
    const merges = await ofKind<IntegrateMergeBody>('integrate.merge')
    const mb = merges.find(m => m.body.task === 'b')!.body
    expect(mb.resolved).toEqual({ files: ['shared.ts'], integrator_extra: ['glue/extra.ts'] })
    expect(mb.paths).toEqual(['pkgB/b.ts', 'shared.ts'])
    expect((await git('rev-parse', `${mb.commit}^1`)).trim()).toBe(head)
    expect((await git('rev-parse', `${mb.commit}^2`)).trim()).toBe(await tipOf(b.branch))
    expect((await git('log', '-1', '--format=%s', mb.commit)).trim()).toBe(`litter: merge b of ${RUN}`)
    expect(await mergeHead()).toBe('')
    expect(r.changed).toContainEqual({ path: 'glue/extra.ts', task: null, integrator_extra: true })
    expect(r.changed).toContainEqual({ path: 'shared.ts', task: 'a', integrator_extra: false })
    expect((await git('show', `${r.tip}:shared.ts`))).toBe('export const v = 3 // a and b\n')
    expect((await gitIn(integration, 'status', '--porcelain')).trim()).toBe('')
  })

  test('a resolution that left a marker is refused, the worktree left as it is, and refused again', async () => {
    await conflicted()
    const text = readFileSync(join(integration, 'shared.ts'), 'utf8')
    write(integration, 'shared.ts', text.replace('// a', '// a, half resolved'))
    const r = await integrate()
    expect(r.status).toBe('refused')
    expect(r.reason).toMatch(/conflict markers are left in shared\.ts:1,3,5/)
    expect(r.reason).toContain(`The integration worktree ${integration} is left as it is`)
    expect(await mergeHead()).not.toBe('')
    expect(readFileSync(join(integration, 'shared.ts'), 'utf8')).toContain('half resolved')
    expect((await ofKind<IntegrateMergeBody>('integrate.merge')).map(m => m.body.task)).toEqual(['a'])
    expect(await integrate()).toEqual(r)
  })

  test('a resolution the integrator staged is refused', async () => {
    await conflicted()
    write(integration, 'shared.ts', 'export const v = 4\n')
    await gitIn(integration, 'add', 'shared.ts')
    const r = await integrate()
    expect(r.status).toBe('refused')
    expect(r.reason).toMatch(/files were staged or unstaged/)
  })

  test('a resolution the integrator committed is refused', async () => {
    await conflicted()
    write(integration, 'shared.ts', 'export const v = 4\n')
    await gitIn(integration, 'commit', '-q', '-a', '-m', 'mine')
    const r = await integrate()
    expect(r.status).toBe('refused')
    expect(r.reason).toMatch(/a commit was made/)
    expect(r.reason).toMatch(/no longer in progress/)
  })

  test('a merge the integrator aborted is refused', async () => {
    await conflicted()
    await gitIn(integration, 'merge', '--abort')
    const r = await integrate()
    expect(r.status).toBe('refused')
    expect(r.reason).toMatch(/no longer in progress \(it was aborted or committed\)/)
  })
})

describe('integrate: who may call, and when', () => {
  test('only the run\'s relay', async () => {
    const r = await recordIntegrate(ctx({ agentId: 'ex-1', agentType: 'litter:executor' }), { kind: 'integrate', run: RUN })
    expect(r).toMatchObject({ ok: false, field: 'kind' })
    expect((r as RecordError).error).toContain('litter:executor')
    expect(await recordIntegrate(ctx({ agentId: null, agentType: null }), { kind: 'integrate', run: RUN })).toMatchObject({ ok: false })
    expect(await kinds()).toEqual(['worktree.create'])
  })

  test('not in an execute run, a closed run, or a tampered ledger', async () => {
    const json = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunJson
    await p.fs.write(join(runDir, 'run.json'), JSON.stringify({ ...json, workflow: 'execute' }))
    expect(await recordIntegrate(ctx(RELAY), { kind: 'integrate', run: RUN })).toMatchObject({ ok: false, field: 'run' })
    await p.fs.write(join(runDir, 'run.json'), JSON.stringify(json))
    await appendRecord(p, runDir, { run: RUN, kind: 'run.end', by: MOD, body: { status: 'halted' } })
    const closed = await recordIntegrate(ctx(RELAY), { kind: 'integrate', run: RUN })
    expect((closed as RecordError).error).toMatch(/has ended/)
    p.storeMap.set(headKey(runDir), { seq: 2, sha: 'not-the-hash' })
    expect((await recordIntegrate(ctx(RELAY), { kind: 'integrate', run: RUN }) as RecordError).error).toMatch(/tampered/)
  })

  test("an integration worktree that can't be made is the outcome: refused, recorded, and the same answer again", async () => {
    // Another run, with no integration worktree yet, whose worktreeRoot is a file: nothing can be made under it.
    const run2 = '20261002-fan-two'
    const dir2 = join(litterDir, run2)
    const json = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunJson
    await p.fs.write(join(dir2, 'run.json'), JSON.stringify({ ...json, run: run2, ref: `refs/heads/litter/${run2}` }))
    const policy: Policy = {
      v: 1,
      session: 'test-session',
      litterDir,
      run: {
        run: run2,
        workflow: 'fanout',
        runDir: dir2,
        checkout: dir,
        base,
        runIds: [],
        launching: false,
        stopping: false,
        inflight: null,
        isolationLost: false,
        roots: { checkout: dir, litterDir, litterCopies: [litterDir], ruleDirs: [], worktrees: [], integration: null },
        setup: null,
        linkDirs: [],
        worktreeRoot: join(dir, 'README.md'),
      },
      roles: {},
      swarm: null,
    }
    await writePolicy(p, litterDir, policy)
    const r = (await recordIntegrate(ctx(RELAY), { kind: 'integrate', run: run2 })) as unknown as IntegrateReply
    expect(r).toMatchObject({ ok: true, status: 'refused', merged: [], skipped: [] })
    expect(r.reason).toMatch(/^the integration worktree couldn't be made: /)
    expect(r.where).toBe(join(dir, 'README.md', `litter-${run2}-integration`))
    const recs = (await readLedger(p, dir2, run2)).records
    const done = recs.filter(x => x.kind === 'integrate.done')
    expect(done).toHaveLength(1)
    expect(r.integrate_id).toBe(`i${done[0]!.seq}`)
    expect(await recordIntegrate(ctx(RELAY), { kind: 'integrate', run: run2 })).toEqual(r)
    expect((await readPolicy(p, litterDir))!.run!.roots.integration).toBeNull()
  })

  test('a changed integration worktree stops the integration before it merges anything', async () => {
    await writer('a', 1, { 'pkgA/a.ts': 'a\n' })
    write(integration, 'README.md', 'edited by someone\n')
    const r = await integrate()
    expect(r.status).toBe('refused')
    expect(r.reason).toBe(`the integration worktree ${integration} has changes litter didn't make: README.md`)
    expect(await tipOf(IB)).toBe(base)
  })
})

describe('integrate: helpers', () => {
  test('markerLines finds git markers, and a lone ======= only between them', () => {
    expect(markerLines('a\n=======\nb\n')).toEqual([])
    expect(markerLines('<<<<<<< HEAD\nx\n=======\ny\n>>>>>>> b\n=======\n')).toEqual([1, 3, 5])
    expect(markerLines('<<<<<<<< not one\n')).toEqual([])
  })

  test('fanoutSummary lists tasks, conflicts and what blocked the land; nothing for other workflows', async () => {
    await writer('a', 1, { 'pkgA/a.ts': 'a\n' })
    await writer('b', 2, { 'pkgB/b.ts': 'b\n' }, { status: 'blocked', summary: 'needs | a pipe' })
    await writer('c', 3, { 'docs/c.md': 'c, done\n' })
    await result(null, 'writer-9', 'blocked', 'bind first')
    await integrate()
    const json = JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as RunJson
    const lines = fanoutSummary(json, await records())
    const text = lines.join('\n')
    expect(text).toContain('| a | writer | done | merged | - |')
    expect(text).toContain('| b | writer | blocked: needs \\| a pipe | skipped: task b returned blocked: needs \\| a pipe | - |')
    expect(text).toContain('| r | read-only | passed to the verifier | - | - |')
    expect(text).toContain('An unbound writer returned blocked: bind first')
    expect(text).toContain('## What blocked the land')
    expect(text).toContain("- task b wasn't merged: task b returned blocked: needs | a pipe")
    expect(fanoutSummary({ ...json, workflow: 'execute' }, await records())).toEqual([])
    expect(fanoutSummary(null, [])).toEqual([])
  })
})
