// Tier 4: saves a swarm's first revision into a scratch repo's litter
// directory through J's store, as the builder's [Save] would, so a live
// session can open it and press [Launch]. Run with bun from tests/unit:
//
//   bun ../headless/fixtures/swarm-save.ts <repo> <spec.json> <briefs dir>
//
// Each `<briefs dir>/<node>.md` is that node's brief. Prints the revision, or
// every error and exits 1.

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SwarmSpec } from '../../../hooks/swarm/types'
import { saveRevision } from '../../../hooks/swarm/store'
import { updateSession } from '../../../hooks/session'
import { nodePorts } from '../../unit/support/node-ports'

const [repo, specPath, briefsDir] = process.argv.slice(2)
if (!repo || !specPath || !briefsDir) {
  console.error('usage: swarm-save.ts <repo> <spec.json> <briefs dir>')
  process.exit(2)
}
const spec = JSON.parse(readFileSync(specPath, 'utf8')) as SwarmSpec
const briefs: Record<string, string> = {}
for (const f of readdirSync(briefsDir)) if (f.endsWith('.md')) briefs[f.slice(0, -3)] = readFileSync(join(briefsDir, f), 'utf8')

const litterDir = join(repo, '.claude', 'litter')
const p = nodePorts({ cwd: repo })
updateSession({ litterDir })
const r = await saveRevision(p, litterDir, spec.name, { spec, briefs }, { from: 'save', changes: ['nodes'] })
if (r.ok) console.log(`saved ${spec.name} revision ${r.revision}`)
else {
  for (const e of r.errors) console.error(`${e.node ?? '-'} ${e.field}: ${e.error}`)
  process.exit(1)
}
