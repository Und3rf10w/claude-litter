// Tier 2: the snapshot against real git (plan section 9, "Snapshot").

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from 'bun:test'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { GitFailed, dirtySubmodules, snapshot } from '../../hooks/snapshot'
import { nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

// Real git (submodule clones among it), slow on a busy machine.
setDefaultTimeout(120_000)

let p: TestPorts
let dir: string
let cleanup: () => void
let git: (...argv: string[]) => Promise<string>

beforeEach(async () => {
  p = nodePorts()
  ;({ dir, cleanup } = scratch())
  ;({ git } = await scratchRepo(p, dir))
})
afterEach(() => cleanup())

const headTree = async () => (await git('rev-parse', 'HEAD^{tree}')).trim()
const indexState = async () => (await git('ls-files', '-s', '-v')).trim()
const write = (path: string, text: string) => {
  mkdirSync(join(dir, path, '..'), { recursive: true })
  writeFileSync(join(dir, path), text)
}

describe('snapshot', () => {
  test('a clean tree is HEAD^{tree}, and the real index is untouched', async () => {
    const before = await indexState()
    const s = await snapshot(p, dir)
    expect(s).toEqual({ tree: await headTree(), dirty_submodules: [], sparse: false })
    expect(await indexState()).toBe(before)
    expect((await git('status', '--porcelain')).trim()).toBe('')
  })

  test('an edit and a new file are in the tree; the real index still is not', async () => {
    write('README.md', 'changed\n')
    write('src/new.ts', 'export {}\n')
    const s = await snapshot(p, dir)
    expect(s.tree).not.toBe(await headTree())
    expect(await git('ls-tree', '-r', '--name-only', s.tree)).toContain('src/new.ts')
    expect((await git('diff', '--cached', '--name-only')).trim()).toBe('')
  })

  test('an assume-unchanged edit, which status hides, is in the tree', async () => {
    await git('update-index', '--assume-unchanged', 'README.md')
    write('README.md', 'hidden edit\n')
    expect((await git('status', '--porcelain')).trim()).toBe('')
    expect((await snapshot(p, dir)).tree).not.toBe(await headTree())
  })

  test("the mod's own paths are left out", async () => {
    write('.claude/litter/20261002-x/ledger/000001-finding.json', '{}\n')
    write('.claude/worktrees/w/file', 'x\n')
    write('.litter/rules.json', '{}\n')
    write('.litter.local/rules.json', '{}\n')
    write('.claude/rules/litter/a.md', 'x\n')
    write('.claude/rules/litter-local/b.md', 'x\n')
    expect((await snapshot(p, dir)).tree).toBe(await headTree())
  })

  test('the temporary index is removed', async () => {
    await snapshot(p, dir)
    const gitDir = join(dir, '.git')
    const left = (await p.fs.list(gitDir)).filter(e => e.name.startsWith('litter-snapshot-'))
    expect(left).toEqual([])
  })

  test('an unborn HEAD snapshots from the empty tree', async () => {
    const { dir: d2, cleanup: c2 } = scratch()
    try {
      await p.run(['git', 'init', '-q', '-b', 'main'], { cwd: d2 })
      writeFileSync(join(d2, 'a'), 'a\n')
      const s = await snapshot(p, d2)
      expect(s.tree).toMatch(/^[0-9a-f]{40,64}$/)
    } finally {
      c2()
    }
  })

  test('a submodule with a tracked edit or an untracked file is named, and is clean again once reverted', async () => {
    const { dir: subDir, cleanup: c2 } = scratch()
    try {
      await scratchRepo(p, subDir)
      await git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subDir, 'vendor/sub')
      await git('commit', '-q', '-m', 'add sub')
      expect(await dirtySubmodules(p, dir)).toEqual([])
      writeFileSync(join(dir, 'vendor/sub/README.md'), 'edit inside\n')
      expect((await snapshot(p, dir)).dirty_submodules).toEqual(['vendor/sub'])
      await p.run(['git', 'checkout', '-q', '--', 'README.md'], { cwd: join(dir, 'vendor/sub') })
      writeFileSync(join(dir, 'vendor/sub/untracked'), 'u\n')
      expect((await snapshot(p, dir)).dirty_submodules).toEqual(['vendor/sub'])
      rmSync(join(dir, 'vendor/sub/untracked'))
      const s = await snapshot(p, dir)
      expect(s.dirty_submodules).toEqual([])
      expect(s.tree).toBe(await headTree())
    } finally {
      c2()
    }
  })

  test('a change two submodules down is named by its top-level submodule, even with ignore = all', async () => {
    const { dir: leaf, cleanup: c1 } = scratch()
    const { dir: mid, cleanup: c2 } = scratch()
    try {
      await scratchRepo(p, leaf)
      const { git: gitMid } = await scratchRepo(p, mid)
      await gitMid('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', leaf, 'inner')
      await gitMid('commit', '-q', '-m', 'add inner')
      await git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', mid, 'vendor/mid')
      await git('commit', '-q', '-m', 'add mid')
      await git('-c', 'protocol.file.allow=always', 'submodule', 'update', '-q', '--init', '--recursive')
      expect(await dirtySubmodules(p, dir)).toEqual([])
      writeFileSync(join(dir, 'vendor/mid/inner/README.md'), 'edit two levels down\n')
      expect((await snapshot(p, dir)).dirty_submodules).toEqual(['vendor/mid'])
      await git('config', 'submodule.vendor/mid.ignore', 'all')
      await git('config', 'diff.ignoreSubmodules', 'all')
      expect((await git('status', '--porcelain')).trim()).toBe('')
      const s = await snapshot(p, dir)
      expect(s.dirty_submodules).toEqual(['vendor/mid'])
      expect(s.tree).toBe(await headTree())
    } finally {
      c1()
      c2()
    }
  }, 30_000)

  test("a submodule whose HEAD moved (SC..) is an ordinary change: a new gitlink, and clean", async () => {
    const { dir: subDir, cleanup: c2 } = scratch()
    try {
      await scratchRepo(p, subDir)
      await git('-c', 'protocol.file.allow=always', 'submodule', 'add', '-q', subDir, 'vendor/sub')
      await git('commit', '-q', '-m', 'add sub')
      const sub = join(dir, 'vendor/sub')
      writeFileSync(join(sub, 'next.txt'), 'n\n')
      await p.run(['git', 'add', 'next.txt'], { cwd: sub })
      await p.run(['git', 'commit', '-q', '-m', 'next'], { cwd: sub })
      const moved = (await p.run(['git', 'rev-parse', 'HEAD'], { cwd: sub })).stdout.trim()
      const s = await snapshot(p, dir)
      expect(s.dirty_submodules).toEqual([])
      expect(s.tree).not.toBe(await headTree())
      expect((await git('ls-tree', s.tree, 'vendor/sub')).trim()).toContain(moved)
    } finally {
      c2()
    }
  })

  test('skip-worktree set by hand, without sparse checkout: the plain snapshot sees edits and deletions', async () => {
    write('a.txt', 'a\n')
    write('b.txt', 'b\n')
    await git('add', '-A')
    await git('commit', '-q', '-m', 'files')
    await git('update-index', '--skip-worktree', 'a.txt', 'b.txt')
    write('a.txt', 'edited behind the bit\n')
    rmSync(join(dir, 'b.txt'))
    expect((await git('status', '--porcelain')).trim()).toBe('')
    const s = await snapshot(p, dir)
    expect(s.sparse).toBe(false)
    expect((await git('cat-file', '-p', `${s.tree}:a.txt`)).trim()).toBe('edited behind the bit')
    expect(await git('ls-tree', '-r', '--name-only', s.tree)).not.toContain('b.txt')
  })

  test('sparse with a skip-worktree bit set by hand inside the cone: its edit and its deletion are caught', async () => {
    write('in/a.ts', 'a\n')
    write('in/gone.ts', 'g\n')
    write('out/b.ts', 'b\n')
    await git('add', '-A')
    await git('commit', '-q', '-m', 'tree')
    await git('sparse-checkout', 'set', '--cone', 'in')
    await git('update-index', '--skip-worktree', 'in/a.ts', 'in/gone.ts')
    write('in/a.ts', 'edited behind the bit\n')
    rmSync(join(dir, 'in/gone.ts'))
    // git shows the bit only on absent files (it clears it from present ones as it reads the index).
    const before = await indexState()
    expect(before).toContain('S 100644')
    const s = await snapshot(p, dir)
    expect(s.sparse).toBe(true)
    const names = await git('ls-tree', '-r', '--name-only', s.tree)
    expect((await git('cat-file', '-p', `${s.tree}:in/a.ts`)).trim()).toBe('edited behind the bit')
    expect(names).not.toContain('in/gone.ts')
    // Out of the cone, the absent file is intentionally absent, and stays in the tree.
    expect(names).toContain('out/b.ts')
    expect(existsSync(join(dir, 'out/b.ts'))).toBe(false)
    expect(await indexState()).toBe(before)
  })

  test('sparse: clean is HEAD^{tree}; out-of-cone edits and new files are caught; absent files stay', async () => {
    write('in/a.ts', 'a\n')
    write('out/b.ts', 'b\n')
    write('out/c.ts', 'c\n')
    await git('add', '-A')
    await git('commit', '-q', '-m', 'tree')
    await git('sparse-checkout', 'set', '--cone', 'in')
    expect(existsSync(join(dir, 'out/b.ts'))).toBe(false)
    const clean = await snapshot(p, dir)
    expect(clean.sparse).toBe(true)
    expect(clean.tree).toBe(await headTree())
    // Materialize one out-of-cone file with an edit, and add a new one.
    write('out/b.ts', 'edited\n')
    write('out/new.ts', 'n\n')
    const s = await snapshot(p, dir)
    expect(s.tree).not.toBe(await headTree())
    const names = await git('ls-tree', '-r', '--name-only', s.tree)
    expect(names).toContain('out/new.ts')
    expect(names).toContain('out/c.ts')
    expect((await git('cat-file', '-p', `${s.tree}:out/b.ts`)).trim()).toBe('edited')
    expect(existsSync(join(dir, 'out/c.ts'))).toBe(false)
    expect((await git('ls-files', '-t', 'out/c.ts')).trim()).toBe('S out/c.ts')
  })

  test('staged content is never in the snapshot: the working tree is', async () => {
    const blob = (await p.run(['git', 'hash-object', '-w', '--stdin'], { cwd: dir, stdin: 'staged only\n' })).stdout.trim()
    await git('update-index', '--cacheinfo', `100644,${blob},README.md`)
    expect((await snapshot(p, dir)).tree).toBe(await headTree())
    expect((await git('ls-files', '-s', 'README.md')).trim()).toContain(blob)
  })

  test('a failing git rejects with GitFailed, and leaves no temporary index', async () => {
    const { dir: notRepo, cleanup: c2 } = scratch()
    try {
      await expect(snapshot(p, notRepo)).rejects.toBeInstanceOf(GitFailed)
    } finally {
      c2()
    }
  })
})
