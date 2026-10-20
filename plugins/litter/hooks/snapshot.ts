// The tree snapshot: a temporary index, `git add -A` with the excludes, and
// `write-tree`, plus the sparse-checkout path and the submodule check (plan
// section 9, "Snapshot"). Built in phase 1a, since run.start (D) and verify
// and land (C) all take it; C owns its tests from here on.

import type { Ports } from './ports'
import type { Snapshot } from './records/execute'
import { SNAPSHOT_EXCLUDES } from './layout'
import { randomId, remove } from './fsx'

/**
 * `.` plus one `:(exclude)` per mod-owned path, for the clean checks (`git
 * status`). A snapshot's `add -A` builds its own with addSpec.
 */
export const SNAPSHOT_PATHSPEC: readonly string[] = ['.', ...SNAPSHOT_EXCLUDES.map(p => `:(exclude)${p}`)]

// Fields, not parameter properties, here and in the classes like it: node runs
// these files with their types stripped, which can't rewrite a parameter
// property (tests/unit/codexgraph.spec.ts keeps them out).
export class GitFailed extends Error {
  readonly argv: readonly string[]
  readonly code: number
  readonly stderr: string
  constructor(argv: readonly string[], code: number, stderr: string) {
    super(`git ${argv.join(' ')} failed (exit ${code}): ${stderr.trim()}`)
    this.argv = argv
    this.code = code
    this.stderr = stderr
  }
}

type Git = (argv: readonly string[], init?: { env?: Record<string, string>; stdin?: string }) => Promise<string>

function gitIn(p: Ports, checkout: string): Git {
  return async (argv, init) => {
    const r = await p.run(['git', '-C', checkout, ...argv], { ...init, timeoutMs: 120_000 })
    if (r.code !== 0) throw new GitFailed(argv, r.code, r.stderr)
    return r.stdout
  }
}

/** Is sparse checkout on for this worktree (`core.sparseCheckout`, worktree config included)? */
export async function isSparse(p: Ports, checkout: string): Promise<boolean> {
  const r = await p.run(['git', '-C', checkout, 'config', '--type=bool', '--get', 'core.sparseCheckout'])
  return r.code === 0 && r.stdout.trim() === 'true'
}

/**
 * Submodules with tracked changes (`M`) or untracked files (`U`) inside, from
 * `git status --porcelain=v2 -z --ignore-submodules=none`. One call covers
 * every depth: a change two levels down shows on the top-level entry.
 *
 * It looks inside on purpose, so, unlike the calls given NOT_INTO_SUBMODULES
 * (worktrees.ts), it runs a child git in each populated submodule, which reads
 * that submodule's own config and runs its filter drivers. In a checkout an
 * agent can write, a submodule's .git/config may be the agent's. A residual:
 * verify, land, run.start and repair hold a tree clean only with no dirty
 * submodule, so the check stays. The parent's `-c` settings reach the child,
 * so a host could override each `filter.<name>.*` the submodules name.
 */
export async function dirtySubmodules(p: Ports, checkout: string): Promise<string[]> {
  const out = await gitIn(p, checkout)(['status', '--porcelain=v2', '-z', '--ignore-submodules=none'])
  const fields = out.split('\0')
  const dirty: string[] = []
  for (let i = 0; i < fields.length; i++) {
    const entry = fields[i]!
    const kind = entry[0]
    // 1 XY sub mH mI mW hH hI path | 2 XY sub mH mI mW hH hI Xscore path \0 orig | u XY sub m1 m2 m3 mW h1 h2 h3 path
    const at = kind === '1' ? 8 : kind === '2' ? 9 : kind === 'u' ? 10 : -1
    if (kind === '2') i++ // the original path follows as its own field
    if (at < 0) continue
    const parts = entry.split(' ')
    const sub = parts[2] ?? ''
    if (sub[0] !== 'S') continue
    if (sub[2] === 'M' || sub[3] === 'U') dirty.push(parts.slice(at).join(' '))
  }
  return dirty.sort()
}

/**
 * Paths the real index marks skip-worktree that are absent on disk, and that
 * the sparse rules leave out: the intentionally absent ones (the sparse path's
 * step 2). An absent path inside the rules carries a skip-worktree bit set by
 * hand, and the file is deleted, so the snapshot takes the deletion, as the
 * plain snapshot does without sparse checkout.
 */
async function absentSkipWorktree(p: Ports, git: Git, checkout: string): Promise<string[]> {
  const listed = (await git(['ls-files', '-t', '-z'])).split('\0')
  const marked = listed.filter(e => e.startsWith('S ')).map(e => e.slice(2))
  const absent: string[] = []
  const CHUNK = 64
  for (let i = 0; i < marked.length; i += CHUNK) {
    const chunk = marked.slice(i, i + CHUNK)
    const present = await Promise.all(
      chunk.map(path =>
        p.fs.stat(`${checkout}/${path}`).then(
          () => true,
          () => false,
        ),
      ),
    )
    chunk.forEach((path, j) => {
      if (!present[j]) absent.push(path)
    })
  }
  if (absent.length === 0) return absent
  // `check-rules` (git 2.41+) prints the paths the rules include. Without it,
  // every absent entry counts as intentionally absent, as before.
  const r = await p.run(['git', '-C', checkout, 'sparse-checkout', 'check-rules', '-z'], {
    stdin: `${absent.join('\0')}\0`,
    timeoutMs: 120_000,
  })
  if (r.code !== 0) return absent
  const inside = new Set(r.stdout.split('\0').filter(x => x !== ''))
  return absent.filter(path => !inside.has(path))
}

/**
 * The snapshot's `add -A` pathspec: `.` plus an exclude for each mod-owned
 * path the checkout's ignore rules don't already leave out, and the ones they
 * do. git (2.50) exits 1 for an exclude that names an ignored path, though the
 * index comes out right, so with every exclude a repo that ignores `.claude/`
 * failed each snapshot. `add -A .` skips an ignored path anyway, except for
 * files tracked there, so the snapshot resets those to HEAD's afterwards.
 * `--no-index`, since check-ignore leaves out a path with tracked files under it.
 */
async function addSpec(p: Ports, checkout: string): Promise<{ spec: string[]; ignored: string[] }> {
  const argv = ['check-ignore', '--no-index', '--stdin', '-z']
  const r = await p.run(['git', '-C', checkout, ...argv], { stdin: `${SNAPSHOT_EXCLUDES.join('\0')}\0`, timeoutMs: 120_000 })
  if (r.code !== 0 && r.code !== 1) throw new GitFailed(argv, r.code, r.stderr)
  const hit = new Set(r.stdout.split('\0'))
  const ignored = SNAPSHOT_EXCLUDES.filter(x => hit.has(x))
  return { spec: ['.', ...SNAPSHOT_EXCLUDES.filter(x => !hit.has(x)).map(x => `:(exclude)${x}`)], ignored }
}

/**
 * Snapshots the working tree at `checkout` (absolute) without touching the
 * real index: what a land would commit, the mod's own paths left out.
 * Rejects with GitFailed when git does.
 */
export async function snapshot(p: Ports, checkout: string): Promise<Snapshot> {
  const git = gitIn(p, checkout)
  // A mod-owned index inside the git dir, so `add -A` never sees it.
  const rel = (await git(['rev-parse', '--git-path', `litter-snapshot-${randomId()}.index`])).trim()
  const index = rel.startsWith('/') ? rel : `${checkout}/${rel}`
  const env = { GIT_INDEX_FILE: index }
  try {
    const sparse = await isSparse(p, checkout)
    const head = await p.run(['git', '-C', checkout, 'rev-parse', '--verify', '-q', 'HEAD^{tree}'])
    await git(head.code === 0 ? ['read-tree', 'HEAD'] : ['read-tree', '--empty'], { env })
    const { spec, ignored } = await addSpec(p, checkout)
    // `add -A` runs the clean filters the checkout's own config names, not a
    // submodule's (it adds a gitlink as its HEAD). An agent's .gitattributes
    // alone names no driver, and on Codex an agent can't write the checkout's
    // .git/config (it's protected), so this is low.
    if (sparse) {
      const absent = await absentSkipWorktree(p, git, checkout)
      if (absent.length > 0) {
        await git(['update-index', '-z', '--skip-worktree', '--stdin'], { env, stdin: `${absent.join('\0')}\0` })
      }
      await git(['-c', 'core.sparseCheckout=false', 'add', '-A', '--', ...spec], { env })
    } else {
      await git(['add', '-A', '--', ...spec], { env })
    }
    // Files tracked under an ignored mod-owned path stay as HEAD has them, as an exclude would leave them.
    if (ignored.length > 0 && head.code === 0) await git(['reset', '-q', 'HEAD', '--', ...ignored], { env })
    const tree = (await git(['write-tree'], { env })).trim()
    return { tree, dirty_submodules: await dirtySubmodules(p, checkout), sparse }
  } finally {
    await remove(p, index).catch(() => {})
    await remove(p, `${index}.lock`).catch(() => {})
  }
}
