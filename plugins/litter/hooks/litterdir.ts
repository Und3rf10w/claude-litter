// litterDir: `<primary checkout>/.claude/litter`, resolved once per session
// from git's own answers (plan section 10, "One litter directory"). Also the
// read-only `run.find` record. Owner: phase 1b, work package B.

import type { Ports } from './ports'
import type { RecordHandler } from './records/core'
import { notYet } from './records/core'

export type LitterDirResult = { ok: true; litterDir: string; primary: string | null; commonDir: string } | { ok: false; error: string }

export async function resolveLitterDir(_p: Ports, _cwd: string): Promise<LitterDirResult> {
  return { ok: false, error: 'litterdir: not built yet (phase 1b, B)' }
}

/** `run.find { run?, workflow? }`: absolute paths, newest first, writes nothing. */
export const recordRunFind: RecordHandler = async () => notYet('run.find', '1b')
