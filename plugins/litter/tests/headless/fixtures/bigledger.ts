// Tier 4 (ui-ledger.sh): a run ledger as long as a busy swarm's, made and
// then grown by hand, chained as ledgercore.ts chains it (each file
// `${JSON.stringify(rec)}\n`, its `prev` the sha256 of the file before). The
// session's store holds no head for the scratch path, so litter reads the
// ledger as another store's (anchor none) and adopts every record.
//
//   bun bigledger.ts make <runDir> <run> <records> <bytes>
//       writes <runDir>/run.json and records 1..n, each body padded to about <bytes>
//   bun bigledger.ts grow <runDir> <run> <every ms> <start file> <stop file> <bytes>
//       once <start file> exists, appends one record every <every ms> until
//       <stop file> exists; prints how many

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const name = (seq: number, kind: string) => `${String(seq).padStart(6, '0')}-${kind}.json`

function write(dir: string, run: string, seq: number, kind: string, prev: string | null, body: unknown): string {
  const rec = { v: 1, seq, kind, run, at: Date.now(), by: { source: 'mod' }, prev, body }
  const text = `${JSON.stringify(rec)}\n`
  writeFileSync(join(dir, name(seq, kind)), text)
  return sha(text)
}

const pad = (bytes: number, seq: number) => ({ n: seq, note: `record ${seq} `.padEnd(Math.max(0, bytes), '.') })

function last(dir: string): { seq: number; sha: string | null } {
  const names = readdirSync(dir).filter(n => /^[0-9]{6}-.+\.json$/.test(n)).sort()
  const top = names.at(-1)
  return top ? { seq: names.length, sha: sha(readFileSync(join(dir, top), 'utf8')) } : { seq: 0, sha: null }
}

const [op, runDir, run, a, b, c, d] = process.argv.slice(2)
if (!op || !runDir || !run) {
  console.error('usage: bigledger.ts make <runDir> <run> <records> <bytes> | grow <runDir> <run> <every ms> <start file> <stop file> <bytes>')
  process.exit(2)
}
const dir = join(runDir, 'ledger')
mkdirSync(dir, { recursive: true })

if (op === 'make') {
  const n = Number(a)
  const bytes = Number(b ?? 0)
  // Not a run.json litter reads (no `v`): the board shows the run from its ledger alone.
  writeFileSync(join(runDir, 'run.json'), `${JSON.stringify({ note: 'a tier-4 ledger replay', run }, null, 2)}\n`)
  let prev = write(dir, run, 1, 'run.start', null, { workflow: 'fanout', authorized: ['tier-4 ledger replay'] })
  for (let seq = 2; seq <= n; seq++) prev = write(dir, run, seq, 'finding', prev, pad(bytes, seq))
  console.log(`made ${n} records in ${dir}`)
} else if (op === 'grow') {
  const every = Number(a)
  const start = b!
  const stop = c!
  const bytes = Number(d ?? 0)
  let added = 0
  while (!existsSync(start) && !existsSync(stop)) await Bun.sleep(200)
  for (;;) {
    if (existsSync(stop)) break
    const top = last(dir)
    write(dir, run, top.seq + 1, 'finding', top.sha, pad(bytes, top.seq + 1))
    added++
    await Bun.sleep(every)
  }
  console.log(`grew ${added} records`)
} else {
  console.error(`unknown op ${op}`)
  process.exit(2)
}
