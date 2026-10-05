// Tier 1: phase 4's wiring as the engine runs the mod (WP-BA). A design
// run.start through the record tool, with parseDesign and designArgs behind
// lifecycle's `deps`, answers with the run, its folder, the checkout and the
// args, with bar.md, run.json and the base ref written. Its parse refusals,
// and the new mod-only kinds' (design.result and design.deliver), answer in
// the tool's error shape.
//
// Not here: `warnings` from parseDesign, which tests/designlaunch.test.ts
// covers (WP-BD).

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const HEAD = 'a'.repeat(40)
const HEAD_TREE = 'b'.repeat(40)
const SNAP_TREE = 'd'.repeat(40)
const SNAP = 'e'.repeat(40)
const LOCK_OID = 'f'.repeat(40)
const LITTER = '/repo/.claude/litter'

/** The six criteria and a ban that BD's minimum (decision 5) takes. */
const BAR = [
  { id: 'C1', text: 'retries once', evidence: 'a test' },
  { id: 'C2', text: 'keeps the timeout', evidence: 'the config' },
  { id: 'C3', text: 'logs each retry', evidence: 'a log line' },
  { id: 'C4', text: 'needs no new dependency', evidence: 'package.json' },
  { id: 'C5', text: 'consistent with rules', evidence: 'the rules' },
  { id: 'C6', text: 'keeps the public API', evidence: 'the exports' },
  { id: 'B1', text: 'no sleep in tests', evidence: 'grep', reason: 'flaky' },
]

type Git = { refs: Map<string, string>; calls: string[][]; unknown: string[][] }

/**
 * $.fs from a map of files, and $.process.run for a plain checkout at /repo
 * whose HEAD is main (record.test.ts's world), plus the git calls a design's
 * run.start makes: the lock's blob and ref, HEAD and the identity, the
 * snapshot's temporary index, the base commit and the fenced transaction.
 * The refs the calls make are kept, so the lock reads back as held. Any other
 * git call fails, and is listed in `unknown`.
 */
function world(on: On): { files: Map<string, string>; git: Git } {
  const files = new Map<string, string>()
  const blobs = new Map<string, string>()
  const git: Git = { refs: new Map([['refs/heads/main', HEAD]]), calls: [], unknown: [] }
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
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return run(0)
    }
    if (argv[0] === 'rm') {
      const path = argv[argv.length - 1]!
      for (const k of [...files.keys()]) if (k === path || k.startsWith(`${path}/`)) files.delete(k)
      return run(0)
    }
    if (argv[0] === 'jq') return run(0, 'jq-1.7.1\n')
    if (argv[0] !== 'git') return run(1)
    const sub = argv[1] === '-C' ? argv.slice(3) : argv.slice(1)
    git.calls.push([...sub])
    const has = (...xs: string[]) => xs.every(x => sub.includes(x))
    const stdin = e.init?.stdin ?? ''
    if (sub[0] === 'rev-parse') {
      if (has('--show-toplevel') && !has('--git-dir')) return run(0, '/repo\n')
      if (has('--git-dir', '--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
      if (has('--path-format=absolute', '--git-common-dir')) return run(0, '/repo/.git\n')
      if (has('--git-path')) return run(0, `.git/${sub[sub.length - 1]}\n`)
      const name = sub[sub.length - 1]!
      if (name === 'HEAD^{commit}' || name === 'HEAD') return run(0, `${HEAD}\n`)
      if (name === 'HEAD^{tree}') return run(0, `${HEAD_TREE}\n`)
      const oid = git.refs.get(name)
      return oid ? run(0, `${oid}\n`) : run(1)
    }
    if (sub[0] === 'hash-object') {
      blobs.set(LOCK_OID, stdin)
      return run(0, `${LOCK_OID}\n`)
    }
    if (sub[0] === 'cat-file' && sub[1] === 'blob') {
      const b = blobs.get(sub[2]!)
      return b === undefined ? run(128) : run(0, b)
    }
    if (sub[0] === 'update-ref' && has('--stdin')) {
      const lines = stdin.split('\n').map(l => l.split(' '))
      for (const [verb, ref, oid] of lines) if (verb === 'verify' && git.refs.get(ref!) !== oid) return run(1)
      for (const [verb, ref, oid] of lines) {
        if (verb === 'create' || verb === 'update') git.refs.set(ref!, oid!)
        if (verb === 'delete') git.refs.delete(ref!)
      }
      return run(0)
    }
    if (sub[0] === 'update-ref' && has('-d')) {
      const [ref, oid] = sub.slice(-2) as [string, string]
      if (git.refs.get(ref) !== oid) return run(1)
      git.refs.delete(ref)
      return run(0)
    }
    if (sub[0] === 'update-ref') {
      const [ref, oid] = sub.slice(-3, -1) as [string, string]
      if (git.refs.has(ref)) return run(1)
      git.refs.set(ref, oid)
      return run(0)
    }
    if (sub[0] === 'symbolic-ref' && has('-q', 'HEAD')) return run(0, 'refs/heads/main\n')
    if (sub[0] === 'var') return run(0, 'A U Thor <a@example.com> 1800000000 +0000\n')
    if (sub[0] === 'version') return run(0, 'git version 2.50.0\n')
    if (sub[0] === 'config' && has('core.sparseCheckout')) return run(1)
    if (sub[0] === 'read-tree' || sub[0] === 'add' || sub[0] === 'reset') return run(0)
    if (sub[0] === 'check-ignore') return run(1)
    if (sub[0] === 'write-tree') return run(0, `${SNAP_TREE}\n`)
    if (sub[0] === 'status') return run(0, '')
    if (sub[0] === 'ls-tree' || sub[0] === 'ls-files') return run(0, '')
    if (sub[0] === 'commit-tree' && sub[1] === SNAP_TREE) return run(0, `${SNAP}\n`)
    git.unknown.push([...sub])
    return run(1)
  })
  on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
  on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
  on('agent.list', async () => ({ value: [] }))
  on('command.register', async (_$, e) => ({ value: { command: e.name } }))
  on('session.id', async () => ({ value: 'tier1-session' }))
  on('session.cwd', async () => ({ value: '/repo' }))
  on('ui.log', async () => ({ value: undefined }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  mock.env(on, {})
  // The session's permission mode, as mode.sh records it.
  files.set(`${LITTER}/hooks/mode`, 'default\n')
  return { files, git }
}

type Reply = { ok: boolean; error?: string; field?: string; allowed?: string[]; run?: string; runDir?: string; checkout?: string; args?: Record<string, unknown>; warnings?: string[] }
const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as Reply

/** A design run's agent, as consumeAgents stores it (policy.ts). */
const AUTHOR = (run: string) => ({
  'litter.agent.au': { agentId: 'au', agentType: 'litter:author', role: 'author', run, cwd: '/w', started: 1, stopped: null },
})

describe('a design run.start through the record tool', () => {
  test('answers as before with the stubs: the run, its folder, the checkout and the args; bar.md, run.json and the base ref', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const { files, git } = world(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const r = parse(
      await $.tool.call({
        tool: 'mcp__litter__record',
        tool_use_id: 't1',
        kind: 'run.start',
        workflow: 'design',
        authorized: ['change the retry'],
        goal: 'design the retry',
        deliverable: 'plan',
        // As a model sends a list the schema declares: the tool decodes it.
        bar: JSON.stringify(BAR),
      }),
    )
    expect(git.unknown).toEqual([])
    expect(r).toEqual({ ok: true, run: expect.stringMatching(/^[0-9]{8}-design-[0-9a-f]{6}$/), runDir: `${LITTER}/${r.run}`, checkout: '/repo', args: expect.any(Object) })
    const { template: _template, prior: _prior, ...args } = r.args!
    expect(args).toEqual({
      run: r.run,
      nonce: expect.stringMatching(/^[0-9a-f]{12}$/),
      authorized: 'change the retry',
      rules: [],
      goal: 'design the retry',
      deliverable: 'plan',
      bar: BAR,
      anchors: [],
      lenses: ['falsifier', 'coverage', 'mechanism'].map(role => ({ role, name: role, focus: '', anchors: [] })),
      empiricalUnknowns: [],
      maxRounds: 4,
      base: SNAP,
    })
    // The base is the snapshot's commit, fenced by the lock; HEAD stays on main.
    expect(git.refs.get(`refs/litter/${r.run}/base`)).toBe(SNAP)
    expect(git.refs.get('refs/litter-active')).toBe(LOCK_OID)
    expect(git.refs.get('refs/heads/main')).toBe(HEAD)
    expect(git.calls.some(c => c[0] === 'commit-tree' && c.join(' ') === `commit-tree ${SNAP_TREE} -p ${HEAD} -F -`)).toBe(true)
    expect(files.get(`${r.runDir}/bar.md`)).toBe(
      [
        '# Bar',
        '',
        '- **C1** retries once\n  Evidence: a test',
        '- **C2** keeps the timeout\n  Evidence: the config',
        '- **C3** logs each retry\n  Evidence: a log line',
        '- **C4** needs no new dependency\n  Evidence: package.json',
        '- **C5** consistent with rules\n  Evidence: the rules',
        '- **C6** keeps the public API\n  Evidence: the exports',
        '- **B1** no sleep in tests\n  Evidence: grep\n  Reason: flaky',
        '',
      ].join('\n'),
    )
    const json = JSON.parse(files.get(`${r.runDir}/run.json`) ?? 'null')
    expect(json).toEqual(
      expect.objectContaining({ run: r.run, workflow: 'design', args: r.args, base: SNAP, ref: `refs/litter/${r.run}/base`, checkout: '/repo', verify: null, setup: null, linkDirs: [], rules: [] }),
    )
    const start = JSON.parse(files.get(`${r.runDir}/ledger/000001-run.start.json`) ?? 'null')
    expect(start).toEqual(expect.objectContaining({ kind: 'run.start', run: r.run, by: { source: 'launcher' } }))
    const policy = JSON.parse(files.get(`${LITTER}/hooks/policy.json`) ?? 'null')
    expect(policy.run).toEqual(expect.objectContaining({ run: r.run, workflow: 'design', setup: null, linkDirs: [] }))
  })

  test("its parse's refusals answer in the tool's error shape, before any git call but the session's", async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const { git } = world(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const before = git.calls.length
    const call = (n: number, fields: Record<string, unknown>) =>
      $.tool.call({ tool: 'mcp__litter__record', tool_use_id: `t-parse-${n}`, kind: 'run.start', authorized: ['x'], ...fields }).then(parse)
    expect(await call(1, { workflow: 'design', deliverable: 'plan', bar: BAR })).toEqual({
      ok: false,
      error: "a design run needs 'goal': the user's words, verbatim",
      field: 'goal',
    })
    expect(await call(2, { workflow: 'design', goal: 'g', deliverable: 'plan', bar: [{ id: 'C1', text: 't' }] })).toEqual({
      ok: false,
      error: "'bar[0].evidence' is required: what evidence C1 needs",
      field: 'bar[0].evidence',
    })
    expect(await call(3, { workflow: 'plan', goal: 'g', deliverable: 'plan' })).toEqual({ ok: false, error: "'deliverable' is for design runs, not plan", field: 'deliverable' })
    expect(git.calls.slice(before)).toEqual([])
  })
})

describe('design.result and design.deliver through the tool', () => {
  test("are refused from the main thread and from an agent, in the tool's error shape", async ($, on) => {
    const RUN = '20261004-design-ab12cd'
    mock.store(on, AUTHOR(RUN))
    mock.clock(on, { now: 1_800_000_000_000 })
    const { files } = world(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const before = [...files.keys()]
    let n = 0
    for (const kind of ['design.result', 'design.deliver']) {
      for (const agentId of [undefined, 'au']) {
        const r = parse(
          await $.tool.call({
            tool: 'mcp__litter__record',
            tool_use_id: `t-mod-${n++}`,
            ...(agentId ? { agentId } : {}),
            kind,
            run: RUN,
            role: 'author',
            result: {},
          }),
        )
        expect(r).toEqual({ ok: false, error: `litter: '${kind}' is recorded by litter itself, never through this tool`, field: 'kind', allowed: expect.any(Array) })
        expect(r.allowed).not.toContain('design.result')
        expect(r.allowed).not.toContain('design.deliver')
        expect(r.allowed).toContain(agentId ? 'proposal' : 'run.start')
      }
    }
    expect([...files.keys()]).toEqual(before)
  })
})
