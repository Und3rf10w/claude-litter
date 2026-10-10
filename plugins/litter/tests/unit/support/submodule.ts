// A nested repository whose own .git/config names a clean filter, for the
// specs that check a git call never looks inside a submodule's work tree: a
// git that does runs a child git there, and that child runs the filter.

import { existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Ports } from '../../../hooks/ports'

export type FilteredSubmodule = {
  /** Its folder. */
  path: string
  /** Its first commit, with f.txt and the .gitattributes naming the filter. */
  commit: string
  /** A new empty commit, so a gitlink at `commit` has moved; no filter runs. */
  move(): Promise<string>
  /** Names the clean filter in its own config and makes f.txt stat-dirty: from here, a git that looks inside runs it. */
  arm(): Promise<void>
  /** Whether the filter ran since the last call; f.txt, while it's there, is stat-dirty again either way. */
  ran(): boolean
}

let bump = 0

/**
 * A repository at `path`, one commit in it, its filter not yet named. The
 * filter appends to `marker`, which belongs outside every repository the spec
 * looks at.
 */
export async function filteredSubmodule(p: Ports, path: string, marker: string): Promise<FilteredSubmodule> {
  const git = async (...argv: string[]): Promise<string> => {
    const r = await p.run(['git', ...argv], { cwd: path })
    if (r.code !== 0) throw new Error(`git ${argv.join(' ')} in ${path}: ${r.stderr.trim()}`)
    return r.stdout.trim()
  }
  // A future mtime each time, so the index's stat of f.txt never matches and a look inside reads it through the filter.
  const restat = () => {
    const t = new Date(Date.UTC(2031, 0, 1) + ++bump * 60_000)
    if (existsSync(join(path, 'f.txt'))) utimesSync(join(path, 'f.txt'), t, t)
  }
  mkdirSync(path, { recursive: true })
  await git('init', '-q', '-b', 'main')
  writeFileSync(join(path, 'f.txt'), 'x\n')
  writeFileSync(join(path, '.gitattributes'), '* filter=x\n')
  await git('add', 'f.txt', '.gitattributes')
  await git('commit', '-q', '-m', 'sub')
  const commit = await git('rev-parse', 'HEAD')
  return {
    path,
    commit,
    move: async () => {
      const moved = await git('commit-tree', 'HEAD^{tree}', '-p', 'HEAD', '-m', 'moved')
      await git('update-ref', 'HEAD', moved)
      return moved
    },
    arm: async () => {
      await git('config', 'filter.x.clean', `sh -c 'echo ran >> "$0"; cat' '${marker}'`)
      restat()
    },
    ran: () => {
      const ran = existsSync(marker)
      rmSync(marker, { force: true })
      restat()
      return ran
    },
  }
}

/** A git that does look inside: the control that shows the filter is armed. */
export const LOOKS_INSIDE = ['status', '--porcelain', '--ignore-submodules=none'] as const
