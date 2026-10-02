// Tier 1: worktree.json as the engine runs session.start (plan section 9,
// "Run worktrees"): written from $.settings.read()'s merged settings, with no
// run active, and checked again on a 30 s clock. $.fs is answered from
// memory, and git with what it prints for a plain checkout at /repo.

import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

/** $.fs from a map of files, and $.process.run for litterdir.ts's git calls and fsx.ts's mv. */
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
      files.set(to, files.get(from) ?? '')
      files.delete(from)
      return run(0)
    }
    if (argv[0] === 'git' && argv.includes('rev-parse')) {
      if (argv.includes('--show-toplevel') && !argv.includes('--git-dir')) return run(0, '/repo\n')
      if (argv.includes('--git-dir') && argv.includes('--git-common-dir')) return run(0, '/repo/.git\n/repo/.git\n')
    }
    return run(1)
  })
  return files
}

const WORKTREE_JSON = '/repo/.claude/litter/hooks/worktree.json'

describe('worktree.json', () => {
  test("session.start writes it from the merged settings, and the 30 s check picks up a change", async ($, on) => {
    mock.store(on)
    const clock = mock.clock(on)
    const files = world(on)
    let settings: Record<string, unknown> = { worktree: { baseRef: 'head', symlinkDirectories: ['node_modules', 7] } }
    on('settings.read', async () => ({ value: settings }))
    on('tool.register', async (_$, e) => ({ value: { tool: `mcp__litter__${e.name}` } }))
    on('agent.register', async (_$, e) => ({ value: { agent: `litter:${e.name}` } }))
    on('session.id', async () => ({ value: 'tier1-session' }))
    on('ui.log', async () => ({ value: undefined }))
    on('session.start', async (_$, e) => ({ cwd: e.cwd }))
    await $.session.start({ cwd: '/repo', surface: null, isInteractive: false })
    expect(JSON.parse(files.get(WORKTREE_JSON) ?? 'null')).toEqual({ v: 1, baseRef: 'head', symlinkDirectories: ['node_modules'] })

    settings = {}
    await clock.advance(29_000)
    expect(JSON.parse(files.get(WORKTREE_JSON) ?? 'null').baseRef).toBe('head')
    await clock.advance(1_000)
    expect(JSON.parse(files.get(WORKTREE_JSON) ?? 'null')).toEqual({ v: 1, baseRef: 'fresh', symlinkDirectories: [] })
  })
})
