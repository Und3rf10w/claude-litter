// Tier 1: a design run's end as the engine runs the mod (WP-BE). Its
// completion notification, through prompt.submit, records run.end, then
// design.deliver and plan.md (the approved version's bytes), then the final
// summary.md, all before next(e) is called (plan section 9: the launcher's
// turn starts after the summary is final). A holding return delivers
// nothing, and its summary says why. Tier 1 reads no real files: the run is
// seeded in a map, as execute.test.ts's are.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const LITTER = '/repo/.claude/litter'
const SESSION = 'tier1-session'
const RUN = '20261004-design-ef56ab'
const RUN_DIR = `${LITTER}/${RUN}`
const TASK = 'task-d1'

const BAR = [
  { id: 'C1', text: 'retries once', evidence: 'a test' },
  { id: 'C2', text: 'keeps the timeout', evidence: 'the config' },
  { id: 'C3', text: 'logs each retry', evidence: 'a log line' },
  { id: 'C4', text: 'needs no new dependency', evidence: 'package.json' },
  { id: 'C5', text: 'documents the retry', evidence: 'the README' },
  { id: 'B1', text: 'no sleep in tests', evidence: 'grep', reason: 'flaky' },
]
const PLAN = '# Retry the refresh — once\n\n## Approach\n\nRetry it.\n\n## Gates\n\n### G1: Retry once\nFiles: src/refresh.ts\nChecks: bun test\nDone when: it retries\n\nImplements: Approach\n'

/** $.fs from a map of files, and $.process.run for the calls the end makes: fsx.ts's mv and rm, and litterdir.ts's git (execute.test.ts's world). */
function world(on: On): Map<string, string> {
  const files = new Map<string, string>()
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))
  const run = (exitCode: number, stdout = '') => ({ value: { exitCode, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
  on('fs.exists', async (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
  on('fs.read', async (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', async (_$, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.list', async (_$, e) => {
    if (!isDir(e.path)) throw new Error(`ENOENT: ${e.path}`)
    const names = new Set([...files.keys()].filter(k => k.startsWith(`${e.path}/`)).map(k => k.slice(e.path.length + 1).split('/')[0]!))
    return {
      value: [...names].map(name => ({ name, kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false })),
    }
  })
  on('fs.stat', async (_$, e) => {
    const known = files.has(e.path) || isDir(e.path) || e.path === '/repo' || e.path === '/repo/.git'
    if (!known) throw new Error(`ENOENT: ${e.path}`)
    return { value: { kind: files.has(e.path) ? 'file' : 'dir', size: 0, mtimeMs: 0, isLink: false, ...(e.resolve ? { realPath: e.path } : {}) } }
  })
  on('process.run', async (_$, e) => {
    const argv = e.argv
    if (argv[0] === 'mv') {
      const [from, to] = argv.slice(-2) as [string, string]
      const text = files.get(from) ?? ''
      files.delete(from)
      files.set(to, text)
      return run(0)
    }
    if (argv[0] === 'rm') {
      const path = argv[argv.length - 1]!
      for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k)
      return run(0)
    }
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return run(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
    }
    return run(1)
  })
  on('ui.log', async () => ({ value: undefined }))
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('agent.list', async () => ({ value: [] }))
  on('session.id', async () => ({ value: SESSION }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  return files
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('')
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))

type Seed = { kind: string; by?: Record<string, unknown>; body: Record<string, unknown> }

/**
 * run.json and its run.start (with run.json's sha256), the launch, then
 * `records`, each chained to the one before. Answers the head this session's
 * appends left in `$.store`, for mock.store: with no head there the ledger is
 * another store's, and the mod leaves it alone.
 */
async function seedRun(files: Map<string, string>, records: Seed[]): Promise<Record<string, unknown>> {
  const json = { v: 1, run: RUN, workflow: 'design', args: { run: RUN, deliverable: 'plan', bar: BAR, empiricalUnknowns: [] }, ref: `refs/litter/${RUN}/base`, base: '0'.repeat(40), checkout: '/repo', isolate: false, linkDirs: [], rules: [] }
  const jsonText = `${JSON.stringify(json, null, 2)}\n`
  files.set(`${RUN_DIR}/run.json`, jsonText)
  const all: Seed[] = [
    { kind: 'run.start', by: { source: 'launcher' }, body: { workflow: 'design', base: json.base, ref: json.ref, checkout: '/repo', runJsonSha256: await sha256(jsonText), oid: '1'.repeat(40), session: SESSION } },
    { kind: 'run.launch', body: { taskId: TASK, runId: 'wf_d1abcd', scriptPath: null, generation: 1, session: SESSION, oid: '1'.repeat(40) } },
    ...records,
  ]
  let prev: string | null = null
  for (const [i, r] of all.entries()) {
    const seq = i + 1
    const text = `${JSON.stringify({ v: 1, seq, kind: r.kind, run: RUN, at: seq * 1_000, by: r.by ?? { source: 'mod' }, prev, body: r.body })}\n`
    files.set(`${RUN_DIR}/ledger/${String(seq).padStart(6, '0')}-${r.kind}.json`, text)
    prev = await sha256(text)
  }
  return { [`litter.head.${RUN_DIR}`]: { v: 2, seq: all.length, sha: prev } }
}

/** The author's v1 as the mod stored it, and the critic's verdict on it. */
async function proposalAndVerdict(files: Map<string, string>, overall: 'APPROVED' | 'HOLDING'): Promise<{ sha: string; records: Seed[] }> {
  const sha = await sha256(PLAN)
  files.set(`${RUN_DIR}/proposals/v1.md`, PLAN)
  const criteria = BAR.map(b => (overall === 'HOLDING' && b.id === 'C3' ? { id: b.id, verdict: 'FAIL', evidence: 'no log line', gap_kind: 'design' } : { id: b.id, verdict: 'PASS', evidence: `${b.id} holds` }))
  return {
    sha,
    records: [
      { kind: 'proposal', by: { source: 'agent', agentId: 'au', agentType: 'litter:author' }, body: { text: PLAN, version: 'v1', sha256: sha } },
      { kind: 'verdict', by: { source: 'agent', agentId: 'dc', agentType: 'litter:design-critic' }, body: { version: 'v1', criteria, overall, sha256: sha } },
    ],
  }
}

const notice = (result: Record<string, unknown>) =>
  `<task-notification>\n<task-id>${TASK}</task-id>\n<status>completed</status>\n` +
  '<summary>Dynamic workflow "litter:design-run" completed</summary>\n' +
  `<result>${JSON.stringify(result)}</result>\n</task-notification>`

type Ledgered = { seq: number; kind: string; body: Record<string, unknown> }
type Seen = { records: Ledgered[]; plan: string | undefined; summary: string | undefined }

/** What's on disk when the mod calls next(e): the ledger past the seed, plan.md and summary.md. */
function watchNext(on: On, files: Map<string, string>, after: number): Seen[] {
  const seen: Seen[] = []
  on('prompt.submit', async (_$, e) => {
    const records = [...files.keys()]
      .filter(k => k.startsWith(`${RUN_DIR}/ledger/`))
      .sort()
      .map(k => JSON.parse(files.get(k)!) as Ledgered)
      .filter(r => r.seq > after)
    seen.push({ records, plan: files.get(`${RUN_DIR}/plan.md`), summary: files.get(`${RUN_DIR}/summary.md`) })
    return { text: e.text }
  })
  return seen
}

describe("a design run's completion notification", () => {
  test('records run.end, then design.deliver and plan.md, then the final summary.md, all before next(e)', async ($, on) => {
    const files = world(on)
    const { sha, records } = await proposalAndVerdict(files, 'APPROVED')
    mock.store(on, { [`litter.task.${TASK}`]: { run: RUN, runDir: RUN_DIR, litterDir: LITTER }, ...(await seedRun(files, records)) })
    mock.clock(on, { now: 1_800_000_000_000 })
    const seen = watchNext(on, files, 4)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    await $.prompt.submit({ text: notice({ stopped: null, outcome: 'approved', by: 'approved', version: 'v1' }), origin: { kind: 'task-notification' }, wait: false })

    expect(seen).toHaveLength(1)
    const [at] = seen
    expect(at!.records.map(r => [r.seq, r.kind])).toEqual([
      [5, 'run.end'],
      [6, 'design.deliver'],
    ])
    expect(at!.records[0]!.body).toEqual(
      expect.objectContaining({ generation: 1, status: 'done', reason: null, payload: { outcome: 'approved', by: 'approved', version: 'v1' }, source: 'notification' }),
    )
    expect(at!.records[1]!.body).toEqual({ version: 'v1', sha256: sha, path: `${RUN_DIR}/plan.md` })
    // plan.md is the approved bytes, unchanged.
    expect(at!.plan).toBe(PLAN)
    // The summary came after the delivery: it reports it.
    expect(at!.summary).toContain('\n## Stop\n\nApproved: the critic approved (approved), at v1\n')
    expect(at!.summary).toContain(`\n## Delivery\n\nDelivered: v1 as ${RUN_DIR}/plan.md, sha256 ${sha}, the approved bytes unchanged\n`)
    expect(at!.summary).toContain('\n## Verdict card\n\nVersion: v1\n')
    expect(at!.summary).toContain('\nOverall: APPROVED\n')
  })

  test('a holding return delivers nothing: design.deliver says why, no plan.md, and the summary says it', async ($, on) => {
    const files = world(on)
    const { records } = await proposalAndVerdict(files, 'HOLDING')
    mock.store(on, { [`litter.task.${TASK}`]: { run: RUN, runDir: RUN_DIR, litterDir: LITTER }, ...(await seedRun(files, records)) })
    mock.clock(on, { now: 1_800_000_000_000 })
    const seen = watchNext(on, files, 4)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    await $.prompt.submit({ text: notice({ stopped: null, outcome: 'holding', by: 'max-rounds', version: 'v1' }), origin: { kind: 'task-notification' }, wait: false })

    const [at] = seen
    expect(at!.records.map(r => r.kind)).toEqual(['run.end', 'design.deliver'])
    expect(at!.records[1]!.body).toEqual({ version: 'v1', refused: 'holding (max-rounds)' })
    expect(at!.plan).toBeUndefined()
    expect(at!.summary).toContain('\n## Stop\n\nHolding: max rounds reached (max-rounds), at v1\n')
    expect(at!.summary).toContain('\n## Delivery\n\nNot delivered: holding (max-rounds)\n')
    expect(at!.summary).toContain('| C3 | FAIL |  | no log line | design |')
  })
})
