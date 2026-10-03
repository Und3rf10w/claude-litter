// Tier 2: the health check (hooks/swarm/doctor.ts; plan 15.7): depth and
// peak against this process's limits, each value's process and settings
// sources apart, the policy and not-yet-reached cases, the snippet holding
// only what falls short, the session in a linked worktree, the other rows,
// and no file written.

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HealthReport, HealthRow, LiveSwarm, SwarmNode, SwarmSpec } from '../../hooks/swarm/types'
import { checkHealth } from '../../hooks/swarm/doctor'
import { setOptions, updateSession } from '../../hooks/session'
import * as state from '../../hooks/swarm/state'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

setDefaultTimeout(120_000)

const W = ['Edit', 'Write', 'NotebookEdit']
const RO = { commit: false, push: 'none', forcePush: false, rewriteHistory: false, worktreeOps: false } as const
const DEPTH = 'CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH'
const CONC = 'CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS'

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
  mkdirSync(join(litterDir, 'hooks'), { recursive: true })
  writeFileSync(join(litterDir, 'hooks', 'mode'), 'auto\n')
  state.resetForTests()
  updateSession({ litterDir, litterDirError: null, toolsRefused: null, swarmToolsRefused: null, ready: true })
})
afterEach(() => {
  updateSession({ litterDir: null, litterDirError: null, toolsRefused: null, swarmToolsRefused: null, ready: false })
  setOptions(undefined)
  state.resetForTests()
  cleanup()
})

const reader = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => ({ id, kind: 'worker', tools: { deny: W }, authority: RO, ...over })
const lead = (id: string, over: Partial<SwarmNode> = {}): SwarmNode => reader(id, { kind: 'orchestrator', worktree: 'none', ...over })
const spec = (nodes: SwarmNode[], over: Partial<SwarmSpec> = {}): SwarmSpec => ({ name: 'alpha', goal: 'Do the thing', nodes, ...over })
/** The 15.7 example: three orchestrators, each with three reviewers and two fixers. */
const example = () => spec([...['a', 'b', 'c'].map(id => lead(id, { spawns: { reviewer: 3, fixer: 2 } })), reader('reviewer'), reader('fixer')])
/** Four levels: an orchestrator, then three workers each spawning the next. */
const deep = () => spec([lead('o', { spawns: { w1: 1 } }), reader('w1', { spawns: { w2: 1 } }), reader('w2', { spawns: { w3: 1 } }), reader('w3')])

const health = (s: SwarmSpec | null, over: { litterDir?: string | null; testSummaryModel?: boolean } = {}, ports: TestPorts = p) =>
  checkHealth(ports, { spec: s, litterDir: over.litterDir === undefined ? litterDir : over.litterDir, ...(over.testSummaryModel ? { testSummaryModel: true } : {}) })
const rowOf = (r: HealthReport, id: string): HealthRow => {
  const x = r.rows.find(row => row.id === id)
  if (!x) throw new Error(`no ${id} row in ${r.rows.map(row => row.id).join(', ')}`)
  return x
}
/** Every file and folder under `root`, sorted. */
const tree = (root: string): string[] => (existsSync(root) ? (readdirSync(root, { recursive: true }) as string[]).sort() : [])

describe('depth and peak', () => {
  test('the 15.7 example: depth 2 passes, peak 18 needs 22 of 20, a warning, and the snippet raises concurrency only', async () => {
    const r = await health(example())
    expect(r.rows.map(x => x.id)).toEqual(['depth', 'concurrency', 'tool-concurrency', 'per-session', 'tools', 'jq', 'mode', 'worktrees', 'session-worktree', 'git'])
    expect(rowOf(r, 'depth')).toEqual(expect.objectContaining({ severity: 'ok', values: { need: 2, sources: {} } }))
    const conc = rowOf(r, 'concurrency')
    expect(conc.severity).toBe('warning')
    expect(conc.detail).toContain('up to 18 agents at once, plus 4')
    expect(conc.detail).toContain('need 22; this session allows 20')
    expect(conc.detail).toContain('unset, so the default (20) applies')
    expect(conc.values).toEqual({ need: 22, sources: {} })
    expect(r.snippet).toEqual({ env: { [CONC]: '40' } })
    expect(r.warnings).toBe(r.rows.filter(x => x.severity === 'warning').length)
    expect(r.errors).toBe(r.rows.filter(x => x.severity === 'error').length)
    p.limitsValue[CONC] = '30'
    const roomy = await health(example())
    expect(rowOf(roomy, 'concurrency').severity).toBe('ok')
    expect(roomy.snippet).toBeNull()
  })

  test('four levels under a limit of 3 is an error, and the snippet asks for one more than the depth', async () => {
    const r = await health(deep())
    const row = rowOf(r, 'depth')
    expect(row.severity).toBe('error')
    expect(row.detail).toContain('depth 4, but this session allows 3')
    expect(r.snippet).toEqual({ env: { [DEPTH]: '5' } })
    p.limitsValue[DEPTH] = '5'
    expect(rowOf(await health(deep()), 'depth').severity).toBe('ok')
  })

  test('a peak over the limit is a warning, with the cap note when the tree is past 20 and maxAgentsAtOnce is unset', async () => {
    p.limitsValue[CONC] = '10'
    const r = await health(spec([lead('o', { spawns: { r: 8 } }), reader('r')]))
    expect(rowOf(r, 'concurrency')).toEqual(expect.objectContaining({ severity: 'warning', values: { need: 13, process: '10', sources: {} } }))
    expect(r.snippet).toEqual({ env: { [CONC]: '20' } })
    p.limitsValue[CONC] = '40'
    const wide = await health(spec([lead('o', { spawns: { r: 30 } }), reader('r')]))
    expect(rowOf(wide, 'concurrency').detail).toContain('set limits.maxAgentsAtOnce too')
    const capped = await health(spec([lead('o', { spawns: { r: 30 } }), reader('r')], { limits: { maxAgentsAtOnce: 10 } }))
    expect(rowOf(capped, 'concurrency').detail).not.toContain('maxAgentsAtOnce')
  })

  test("a value that isn't a whole number is ignored, as the engine does", async () => {
    p.limitsValue[DEPTH] = '4.5'
    const row = rowOf(await health(deep()), 'depth')
    expect(row.severity).toBe('error')
    expect(row.detail).toContain("'4.5' isn't a whole number")
    expect(row.values).toEqual({ need: 4, process: '4.5', sources: {} })
  })

  test('without a spec, each limit is shown for what it is', async () => {
    const r = await health(null)
    expect(['depth', 'concurrency', 'tool-concurrency', 'per-session'].map(id => rowOf(r, id).severity)).toEqual(['info', 'info', 'info', 'info'])
    expect(rowOf(r, 'per-session').detail).toContain("doesn't enforce it")
    expect(r.rows.some(x => x.id === 'worktrees')).toBe(false)
    expect(r.snippet).toBeNull()
  })
})

describe('where the values come from', () => {
  test("the process value and each file's are reported apart, and a file the session doesn't have yet says so", async () => {
    p.limitsValue[CONC] = '20'
    p.sourceSettings.user = { env: { [CONC]: '40' } }
    p.sourceSettings.project = { env: { [CONC]: 30 } }
    p.sourceSettings.local = { model: 'x' }
    const row = rowOf(await health(example()), 'concurrency')
    expect(row.values).toEqual({ need: 22, process: '20', sources: { user: '40', project: '30' } })
    expect(row.detail).toContain("your project settings set 30, but this session has 20: the edit hasn't reached it yet")
    p.limitsValue[CONC] = '30'
    const caught = rowOf(await health(example()), 'concurrency')
    expect(caught.severity).toBe('ok')
    expect(caught.detail).toContain('from your project settings')
    p.sourceSettings = {}
    p.limitsValue[CONC] = '25'
    expect(rowOf(await health(example()), 'concurrency').detail).toContain("set in this session's environment, not in a settings file")
  })

  test('a value your policy sets says to ask your admin, and the snippet leaves it out', async () => {
    p.limitsValue[DEPTH] = '2'
    p.sourceSettings.policy = { env: { [DEPTH]: '2' } }
    p.sourceSettings.user = { env: { [DEPTH]: '9' } }
    const r = await health(deep())
    const row = rowOf(r, 'depth')
    expect(row.severity).toBe('error')
    expect(row.detail).toContain("your organization's policy sets it to 2, so only your admin can change it: ask them")
    expect(row.values).toEqual({ need: 4, process: '2', sources: { user: '9', policy: '2' } })
    expect(r.snippet).toBeNull()
  })

  test('the snippet holds only what falls short', async () => {
    p.limitsValue[CONC] = '10'
    const both = await health(spec([lead('o', { spawns: { w1: 6 } }), reader('w1', { spawns: { w2: 1 } }), reader('w2', { spawns: { w3: 1 } }), reader('w3')]))
    // 19 at once, plus 4, is 23; times 1.5 is 34.5, so 40.
    expect(both.snippet).toEqual({ env: { [DEPTH]: '5', [CONC]: '40' } })
    p.limitsValue[DEPTH] = '4'
    expect((await health(deep())).snippet).toBeNull()
  })
})

describe("the session's worktree", () => {
  test('in a linked worktree under the main checkout, a node working elsewhere in the repository is an error', async () => {
    const wt = join(dir, '.claude', 'worktrees', 'session')
    await git('worktree', 'add', '-q', '-b', 'session', wt)
    const q = nodePorts({ cwd: wt })
    const split = spec([lead('part-a', { worktree: { new: { from: 'main', branch: 'part-a' } }, tools: undefined, authority: { ...RO, commit: true } })])
    const row = rowOf(await health(split, {}, q), 'session-worktree')
    expect(row.severity).toBe('error')
    expect(row.detail).toContain('part-a (the new worktree sw-alpha-part-a)')
    expect(row.detail).toContain('ExitWorktree')
    expect(rowOf(await health(spec([lead('a')]), {}, q), 'session-worktree').severity).toBe('ok')
    expect(rowOf(await health(null, {}, q), 'session-worktree').severity).toBe('info')
    expect(rowOf(await health(split), 'session-worktree')).toEqual(expect.objectContaining({ severity: 'ok', detail: 'the session works in the main checkout' }))
  })

  test("an existing worktree that isn't one is an error; a new one is what Launch makes", async () => {
    mkdirSync(join(dir, 'plain'))
    const r = await health(spec([lead('a', { worktree: { existing: 'plain' } }), lead('b', { worktree: { existing: 'gone' } })]))
    const row = rowOf(r, 'worktrees')
    expect(row.severity).toBe('error')
    expect(row.detail).toContain("a's plain isn't a worktree of this repository")
    expect(row.detail).toContain("b's gone doesn't exist")
    const made = rowOf(await health(spec([lead('a', { worktree: { new: { from: 'main', branch: 'x' } } })])), 'worktrees')
    expect(made.severity).toBe('ok')
    expect(made.detail).toContain('sw-alpha-a from main on x')
  })
})

describe('the other rows', () => {
  test("litter's tools refused is an error naming the setting; a session still starting is a warning", async () => {
    updateSession({ swarmToolsRefused: 'mcp__litter__swarm_read: not allowed' })
    const row = rowOf(await health(null), 'tools')
    expect(row.severity).toBe('error')
    expect(row.detail).toContain('allowedMcpServers')
    expect(row.detail).toContain('mcp__litter__swarm_read: not allowed')
    updateSession({ swarmToolsRefused: null, ready: false })
    expect(rowOf(await health(null), 'tools').severity).toBe('warning')
    updateSession({ ready: true })
    expect(rowOf(await health(null), 'tools').severity).toBe('ok')
  })

  test('jq is as `command -v jq` says', async () => {
    const r = await p.run(['sh', '-c', 'command -v jq'])
    const there = r.code === 0 && r.stdout.trim() !== ''
    expect(rowOf(await health(null), 'jq').severity).toBe(there ? 'ok' : 'error')
  })

  test('the mode: none recorded and dontAsk are errors, bypassPermissions and acceptEdits warnings', async () => {
    const modeFile = join(litterDir, 'hooks', 'mode')
    expect(rowOf(await health(null), 'mode')).toEqual(expect.objectContaining({ severity: 'ok', detail: 'auto' }))
    for (const [mode, severity] of [
      ['bypassPermissions', 'warning'],
      ['acceptEdits', 'warning'],
      ['dontAsk', 'error'],
      ['default', 'ok'],
      ['', 'error'],
    ] as const) {
      writeFileSync(modeFile, `${mode}\n`)
      expect([mode, rowOf(await health(null), 'mode').severity]).toEqual([mode, severity])
    }
    expect(rowOf(await health(null, { litterDir: join(dir, 'nowhere', '.claude', 'litter') }), 'mode').detail).toContain('no hooks/mode')
  })

  test('no litter directory is an error, with why, and its rows are left out', async () => {
    updateSession({ litterDir: null, litterDirError: 'the session is not in a git repository' })
    const r = await health(example(), { litterDir: null })
    expect(rowOf(r, 'litter-dir')).toEqual(expect.objectContaining({ severity: 'error', detail: expect.stringContaining('not in a git repository') }))
    expect(r.rows.map(x => x.id)).not.toContain('mode')
    expect(r.rows.map(x => x.id)).not.toContain('session-worktree')
  })

  test('each live swarm gets an ownership row; one whose owner reads as nobody, or not at all, is a warning', async () => {
    expect((await health(null)).rows.some(x => x.id.startsWith('owner:'))).toBe(false)
    state.putLiveSwarm({ name: 'alpha', readOnly: false, lost: false } as unknown as LiveSwarm)
    expect(rowOf(await health(null), 'owner:alpha').severity).toBe('warning')
  })

  test('the summary model is tried only on [Test], with one short completion', async () => {
    expect((await health(null)).rows.some(x => x.id === 'summary-model')).toBe(false)
    expect(rowOf(await health(null, { testSummaryModel: true }), 'summary-model').severity).toBe('info')
    setOptions({ summaryModel: 'test-summary-model' })
    const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
    p.completeAnswer = () => ({ isAnswered: true, text: 'ok', usage }) as never
    expect(rowOf(await health(null, { testSummaryModel: true }), 'summary-model')).toEqual(expect.objectContaining({ severity: 'ok', detail: 'test-summary-model answered' }))
    expect(p.completions).toEqual([expect.objectContaining({ model: 'test-summary-model', maxTokens: 16, timeoutMs: 8000 })])
    p.completeAnswer = () => ({ isAnswered: false, reason: 'empty-reply', usage }) as never
    expect(rowOf(await health(null, { testSummaryModel: true }), 'summary-model').detail).toContain('an empty reply')
    p.completeAnswer = undefined
    expect(rowOf(await health(null, { testSummaryModel: true }), 'summary-model').severity).toBe('warning')
  })
})

test('the health check writes no file and keeps nothing', async () => {
  p.limitsValue[CONC] = '10'
  const before = tree(dir)
  await health(example(), { testSummaryModel: true })
  await health(deep())
  expect(tree(dir)).toEqual(before)
  expect(p.storeMap.size).toBe(0)
})
