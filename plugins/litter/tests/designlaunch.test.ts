// Tier 1: a design's launch as the engine runs the mod (WP-BD). run.start
// through the record tool answers a bar past 12 items with its warning, the
// unknowns as objects, and the template and prior fields; a bar below the
// minimum, or a third unknown, is refused in the tool's error shape before
// any git call. rule.find { applicable } for a design answers its selection
// with the items the rules add to the bar, and writes nothing.
//
// The rules joining the bar through run.start, the prior and the template's
// seam are tier 2's (tests/unit/designbar.spec.ts, designlaunch.spec.ts):
// they need a real repository and stand-ins this file can't reach.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const HEAD = 'a'.repeat(40)
const HEAD_TREE = 'b'.repeat(40)
const SNAP_TREE = 'd'.repeat(40)
const SNAP = 'e'.repeat(40)
const LOCK_OID = 'f'.repeat(40)
const BLOB = '1'.repeat(40)
const LITTER = '/repo/.claude/litter'

/** `criteria` criteria, then one ban. */
const barOf = (criteria: number) => [
  ...Array.from({ length: criteria }, (_, i) => ({ id: `C${i + 1}`, text: `criterion ${i + 1}`, evidence: 'a test' })),
  { id: 'B1', text: 'no sleep in tests', evidence: 'grep', reason: 'flaky' },
]

/** A project ban committed at HEAD (store.ts reads it through ls-tree, cat-file and log). */
const BAN_ID = 'P-no-drop'
const BAN_REL = `.litter/rules/${BAN_ID}.md`
const BAN = ['---', `id: ${BAN_ID}`, 'version: 1', 'status: accepted', 'type: ban', 'applies:', '  paths: []', '  when: changing the schema', 'export: true', '---', '', '## Rule', 'Never drop a table.', '', '## Why', 'Data loss.', ''].join('\n')

type Git = { refs: Map<string, string>; calls: string[][]; unknown: string[][] }

/**
 * phase4wiring.test.ts's world: $.fs from a map of files, and $.process.run
 * for a plain checkout at /repo whose HEAD is main, with the git calls a
 * design's run.start makes. `ban` commits BAN_REL at HEAD. Any other git
 * call fails, and is listed in `unknown`.
 */
function world(on: On, opts: { ban?: boolean } = {}): { files: Map<string, string>; git: Git; changed: string[]; arm: () => void } {
  const files = new Map<string, string>()
  const blobs = new Map<string, string>()
  const changed: string[] = []
  let armed = false
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
    if (armed) changed.push(`write ${e.path}`)
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
      if (armed) changed.push(`mv ${argv.slice(-2).join(' ')}`)
      const [from, to] = argv.slice(-2) as [string, string]
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return run(0)
    }
    if (argv[0] === 'rm') {
      if (armed) changed.push(`rm ${argv[argv.length - 1]}`)
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
    if (opts.ban && sub[0] === 'ls-tree' && has('.litter/rules/')) return run(0, `100644 blob ${BLOB}\t${BAN_REL}\0`)
    if (opts.ban && sub[0] === 'cat-file' && sub.includes(BLOB)) return run(0, BAN)
    if (opts.ban && sub[0] === 'log' && has(BAN_REL)) return run(0, `${HEAD}\n`)
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
  if (opts.ban) files.set(`/repo/${BAN_REL}`, BAN)
  return { files, git, changed, arm: () => (armed = true) }
}

type Reply = { ok: boolean; error?: string; field?: string; args?: Record<string, unknown>; warnings?: string[]; [k: string]: unknown }
const parse = (r: { result?: unknown }) => JSON.parse(String(r.result)) as Reply

describe("a design's run.start through the record tool (WP-BD)", () => {
  test('a bar past 12 criteria launches with the warning; the unknowns come back as objects, with the template and prior fields', async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const { git } = world(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const r = parse(
      await $.tool.call({
        tool: 'mcp__litter__record',
        tool_use_id: 't-launch',
        kind: 'run.start',
        workflow: 'design',
        authorized: ['read the retry code'],
        goal: 'design the retry',
        deliverable: 'research',
        // As a model sends the lists the schema declares: the tool decodes them.
        bar: JSON.stringify(barOf(13)),
        empiricalUnknowns: JSON.stringify([{ question: 'Does the server send Retry-After?', smallest_test: 'curl -I', kill_result: 'no header' }, 'Is the timeout per attempt?']),
      }),
    )
    expect(git.unknown).toEqual([])
    expect(r).toEqual(expect.objectContaining({ ok: true, warnings: ['the bar has 13 criteria; group related criteria (the interview aims for about 10)'] }))
    expect(r.args).toEqual(
      expect.objectContaining({
        bar: barOf(13),
        empiricalUnknowns: [
          { id: 'U1', question: 'Does the server send Retry-After?', smallest_test: 'curl -I', kill_result: 'no header' },
          { id: 'U2', question: 'Is the timeout per attempt?', smallest_test: '', kill_result: '' },
        ],
        template: expect.any(String),
        prior: null,
      }),
    )
  })

  test("a bar below the minimum and a third unknown are refused in the tool's error shape, before any git call but the session's", async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 1_800_000_000_000 })
    const { git } = world(on)
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    const before = git.calls.length
    const call = (n: number, fields: Record<string, unknown>) =>
      $.tool
        .call({ tool: 'mcp__litter__record', tool_use_id: `t-refuse-${n}`, kind: 'run.start', workflow: 'design', authorized: ['x'], goal: 'g', deliverable: 'plan', ...fields })
        .then(parse)
    expect(await call(1, { bar: barOf(5) })).toEqual({
      ok: false,
      error: "'bar' has 5 criteria; it needs at least 6 criteria (C<n>) and at least 1 categorical ban (B<n>), each { id, text, evidence, reason (a ban's) }",
      field: 'bar',
    })
    expect(await call(2, { bar: barOf(6), empiricalUnknowns: ['a', 'b', 'c'] })).toEqual({
      ok: false,
      error: "'empiricalUnknowns' takes at most two, and has 3; keep the two the design depends on most",
      field: 'empiricalUnknowns',
    })
    expect(git.calls.slice(before)).toEqual([])
  })
})

describe('rule.find { applicable } for a design (WP-BD)', () => {
  test("answers the selection with the items the rules add to your bar, and writes nothing", async ($, on) => {
    mock.store(on)
    mock.clock(on, { now: 5_000 })
    const { files, changed, arm } = world(on, { ban: true })
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    arm()
    const before = new Map(files)
    const applicable = { workflow: 'design', goal: 'design the retry', anchors: ['src/retry.ts'], runRules: ['keep it small'], bar: barOf(6) }
    const r = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 't-find', kind: 'rule.find', applicable }))
    expect(r).toEqual({
      ok: true,
      workflow: 'design',
      run: [`${BAN_ID}@1 (ban) changing the schema: Never drop a table.`],
      bar: [
        {
          id: 'B2',
          text: 'Never drop a table.',
          evidence: "the proposal's file list and design, checked against the ban",
          reason: 'Data loss.',
          rule: { id: BAN_ID, version: 1 },
        },
      ],
      versions: [{ id: BAN_ID, version: 1 }],
      problems: expect.any(Array),
    })
    // Without your draft bar: numbered from B1, with the note that the ids are assigned at launch.
    const { bar: _bar, ...noBar } = applicable
    const r2 = parse(await $.tool.call({ tool: 'mcp__litter__record', tool_use_id: 't-find-2', kind: 'rule.find', applicable: noBar }))
    expect((r2.bar as { id: string }[]).map(b => b.id)).toEqual(['B1'])
    expect(r2.note).toEqual(expect.stringContaining('run.start assigns them at launch'))
    expect(changed).toEqual([])
    expect(files).toEqual(before)
  })
})
