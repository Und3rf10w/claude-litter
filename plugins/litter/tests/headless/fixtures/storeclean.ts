// Tier 4: drops a case's keys from litter's `$.store` once the case is done
// (lib.sh's h_done). A case's session loads the plugin as litter@inline, as
// a --plugin-dir session of yours does, so its keys (ledger heads, worktree
// roots, swarm parts, each named by the case's scratch paths) land in your
// own store file and would stay there, read and rewritten at every set.
//
//   bun storeclean.ts <case dir>
//
// Drops each key whose name or value holds <case dir> (or its /private
// spelling). The engine's own lock is taken first, as $.store takes it
// (proper-lockfile: the folder `<file>.lock`), so a live session's write is
// never lost: one that comes meanwhile waits, as on any other session's. A
// lock held past 5 s is left alone and nothing is dropped. The file is
// rewritten beside itself, then renamed over it.

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const caseDir = process.argv[2]
if (!caseDir || !caseDir.startsWith('/') || caseDir.split('/').filter(Boolean).length < 3) {
  console.error('usage: storeclean.ts <case dir> (absolute, at least three folders deep)')
  process.exit(2)
}

// The engine's file name for a plugin id: unsafe characters to _, then a short hash.
const id = 'litter@inline'
const fileName = `${id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64)}-${createHash('sha256').update(id).digest('hex').slice(0, 12)}.json`
const config = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME ?? '', '.claude')
const file = join(config, 'plugins', 'store', fileName)
if (!existsSync(file)) {
  console.log('storeclean: no store file')
  process.exit(0)
}

const spellings = [caseDir.replace(/\/+$/, '')]
if (spellings[0]!.startsWith('/private/')) spellings.push(spellings[0]!.slice('/private'.length))
else spellings.push(`/private${spellings[0]}`)
const names = (text: string) => spellings.some(s => text.includes(s))

const lock = `${file}.lock`
let held = false
for (let i = 0; i < 100; i++) {
  try {
    mkdirSync(lock)
    held = true
    break
  } catch {
    await Bun.sleep(50)
  }
}
if (!held) {
  const age = existsSync(lock) ? Math.round((Date.now() - statSync(lock).mtimeMs) / 1000) : -1
  console.log(`storeclean: the store's lock stayed held (${age} s old); nothing dropped`)
  process.exit(0)
}
try {
  const store = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
  const kept: Record<string, unknown> = {}
  let dropped = 0
  for (const [k, v] of Object.entries(store)) {
    if (names(k) || names(JSON.stringify(v) ?? '')) dropped++
    else kept[k] = v
  }
  if (dropped > 0) {
    const tmp = `${file}.storeclean-${process.pid}`
    writeFileSync(tmp, `${JSON.stringify(kept, null, 2)}\n`, { mode: 0o600 })
    renameSync(tmp, file)
  }
  console.log(`storeclean: dropped ${dropped} keys naming ${spellings[0]}`)
} finally {
  rmdirSync(lock)
}
