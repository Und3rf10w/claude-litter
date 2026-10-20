// Tier 4: every rule file a scratch repo holds, as AD's loadRules reads it
// (what counts as accepted, 16.4), for rules.sh's "nothing else is
// accepted". Run with bun from tests/unit:
//
//   bun ../headless/fixtures/rules-load.ts <repo>
//
// Prints one JSON line: { rules: [{ id, version, scope, standing, delivered,
// path, sha256 }], problems }. It reads only the repo's project and local
// scopes and its rules ledger: the ports have no config dir, so your user
// rules aren't read (loadRules lists that as a problem). Writes nothing:
// the ledger heads it adopts stay in the ports' memory.

import { join } from 'node:path'
import { loadRules } from '../../../hooks/rules/store'
import { nodePorts } from '../../unit/support/node-ports'

const [repo] = process.argv.slice(2)
if (!repo || !repo.startsWith('/')) {
  console.error('usage: rules-load.ts <repo, absolute>')
  process.exit(2)
}
const p = nodePorts({ cwd: repo })
const { rules, problems } = await loadRules(p, join(repo, '.claude', 'litter'))
const out = rules.map(r => ({
  id: r.doc.id,
  version: r.doc.version,
  scope: r.scope,
  standing: r.standing,
  delivered: r.delivered ? `${r.delivered.id}@${r.delivered.version}` : null,
  path: r.path,
  sha256: r.sha256,
}))
console.log(JSON.stringify({ rules: out, problems }))
