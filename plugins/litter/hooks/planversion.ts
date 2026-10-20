// A run folder's plan.md, rewritten with the previous file kept as
// plan.<n>.md (COMMON step 2). plan.ts's plan.write and gate.amend write the
// chain root's through it, and a widening (WP-AO) the run's and the root's,
// from plan.ts and from run.start; lifecycle.ts can't import plan.ts, which
// imports it, so the writer lives here.

import type { Ports } from './ports'
import { planPath, planVersionPath } from './layout'
import { atomicWrite, serial } from './fsx'

/** The next free `n` of `plan.<n>.md` in runDir: one past the highest there. */
async function nextVersion(p: Ports, runDir: string): Promise<number> {
  if (!(await p.fs.exists(runDir))) return 1
  let max = 0
  for (const e of await p.fs.list(runDir)) {
    const m = /^plan\.([1-9][0-9]*)\.md$/.exec(e.name)
    if (m && e.kind === 'file') max = Math.max(max, Number(m[1]))
  }
  return max + 1
}

/**
 * Writes `text` as `<runDir>/plan.md`, first moving the current one, if any,
 * to `plan.<n>.md` with the next free n (layout.ts, planVersionPath).
 * Answers the path written (absolute) and the previous file's new path, or
 * null when there was none.
 *
 * The move is a copy and then the atomic replace, so plan.md is never missing
 * for a run.start that reads it meanwhile (lifecycle.ts reads the chain
 * root's).
 */
export async function writePlanVersion(p: Ports, runDir: string, text: string): Promise<{ path: string; previous: string | null }> {
  return serial(`plan-version:${runDir}`, async () => {
    const path = planPath(runDir)
    let previous: string | null = null
    if (await p.fs.exists(path)) {
      const old = await p.fs.read(path)
      previous = planVersionPath(runDir, await nextVersion(p, runDir))
      await atomicWrite(p, previous, old)
    }
    await atomicWrite(p, path, text)
    return { path, previous }
  })
}
