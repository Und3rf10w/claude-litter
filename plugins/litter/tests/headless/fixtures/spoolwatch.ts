// Tier 4: keeps every spool file the hooks write (ui-ask.sh). The mod's drain
// renames a session's live spool aside, reads it and removes it, a second or
// so after the line lands, so a shell loop that copies the spool on a timer
// misses lines under load. This hard-links each file into <out> the first
// time it's seen, on the folder's change events and on a 50 ms poll, both in
// this one process: the link keeps the file's lines after the drain removes
// it, those appended after the link too. A file is linked once (by device
// and inode), its live name and its aside name alike. Run with bun:
//
//   bun tests/headless/fixtures/spoolwatch.ts <spool dir> <out dir> <stop file>
//
// It runs until <stop file> exists, then takes one last look and exits 0.

import { existsSync, linkSync, mkdirSync, readdirSync, statSync, watch } from 'node:fs'

const [spool, out, stop] = process.argv.slice(2)
if (!spool || !out || !stop) {
  console.error('usage: bun spoolwatch.ts <spool dir> <out dir> <stop file>')
  process.exit(2)
}
mkdirSync(out, { recursive: true })

const seen = new Set<string>()
let count = 0

function look(): void {
  let names: string[]
  try {
    names = readdirSync(spool)
  } catch {
    return
  }
  for (const name of names) {
    if (!name.includes('.jsonl')) continue
    const file = `${spool}/${name}`
    try {
      const st = statSync(file)
      if (!st.isFile()) continue
      const key = `${st.dev}:${st.ino}`
      if (seen.has(key)) continue
      count += 1
      linkSync(file, `${out}/${count}`)
      seen.add(key)
    } catch {
      // Renamed or removed since the listing: its aside name, or the next look.
    }
  }
}

let watcher: ReturnType<typeof watch> | null = null
function arm(): void {
  if (watcher !== null) return
  try {
    watcher = watch(spool, () => look())
  } catch {
    // No folder yet: the poll looks, and arms the watch once it's there.
  }
}

const timer = setInterval(() => {
  arm()
  look()
  if (existsSync(stop)) {
    clearInterval(timer)
    watcher?.close()
    look()
    process.exit(0)
  }
}, 50)
arm()
look()
