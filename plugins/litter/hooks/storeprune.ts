// litter's keys in `$.store` that nothing reads again, dropped. The store is
// one file for every project and session, 4 MiB in all, and the engine
// rewrites the whole file at each `set`, so keys for folders that are gone
// (a deleted checkout, a scratch repo, an ended swarm's part) cost every write.
//
// A key is dropped only when what it's for is provably gone:
//  - a key named by a path (a run's ledger head, its events, a checkout's
//    project folder or worktree root…), when that path no longer exists;
//  - a value naming a run folder or a checkout (a workflow's or a task's run,
//    an agent's cwd), when that folder no longer exists, and a run's agent
//    list once none of its agents is left;
//  - a swarm's keys (its state part, summary, composer, draft), when its
//    litter folder is gone, or (not the draft) its swarm folder; and its state
//    part when the launch it holds has recorded swarm.end and this session
//    doesn't hold the swarm live (an end whose own delete never ran).
// Anything else, and anything a read fails on, stays.

import type { Ports } from './ports'
import { launchDir, ledgerDir, swarmDir } from './layout'
import { liveSwarm } from './swarm/state'

/** The cap on all of a plugin's `$.store` (the engine's). */
export const STORE_CAP_BYTES = 4 * 1024 * 1024

/** Keys whose rest is a path: dropped when it's gone. */
const PATH_PREFIXES = [
  'litter.head.',
  'litter.projectDir.',
  'litter.worktreeRoot.',
  'litter.events.',
  'litter.pending.',
  'litter.inflight.',
  'litter.repair.start.',
] as const

/** Keys whose value names a run folder (`runDir`). */
const RUN_VALUE_PREFIXES = ['litter.wf.', 'litter.task.'] as const

/** A swarm's keys: `<prefix><litterDir>.<swarm>`. */
const SWARM_PREFIXES = ['litter.swarm.state.', 'litter.swarm.summary.', 'litter.swarm.composer.', 'litter.swarm.draft.'] as const

/** What the last pass found, for the Doctor's row. */
export type StoreMeasure = { at: number; keys: number; bytes: number; dropped: number }

let last: StoreMeasure | null = null
let running: Promise<StoreMeasure | null> | null = null

/** The last pass's measure, or null before one has run in this module instance. */
export const storeMeasure = (): StoreMeasure | null => last

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const absolute = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/')

/** `<litterDir>.<swarm>` split at the litter folder's own name, or null when it doesn't end in one. */
function swarmKeyParts(rest: string): { litterDir: string; swarm: string } | null {
  const at = rest.lastIndexOf('/.claude/litter.')
  if (at < 0 || !rest.startsWith('/')) return null
  const litterDir = rest.slice(0, at + '/.claude/litter'.length)
  const swarm = rest.slice(litterDir.length + 1)
  return swarm === '' || swarm.includes('/') ? null : { litterDir, swarm }
}

/**
 * One pass: drops what's provably gone (the file's header), then measures
 * what's left. Null when the store can't list its keys (a host without
 * `keys`). One pass at a time; a second caller gets the first's.
 */
export function pruneStore(p: Ports): Promise<StoreMeasure | null> {
  running ??= prune(p).finally(() => {
    running = null
  })
  return running
}

/**
 * The pause after each store call of a pass. Every get, set or delete makes
 * the engine read (and a delete rewrite) the whole store file, under the lock
 * other sessions' writes wait on, so a pass spreads its calls out.
 */
export const PRUNE_PACE_MS = 25

/** A pass's store, each key read at most once, every call paced (PRUNE_PACE_MS). */
function pacedStore(p: Ports): {
  get(key: string): Promise<unknown>
  delete(key: string): Promise<void>
  exists: Ports['fs']['exists']
  list: Ports['fs']['list']
} {
  const values = new Map<string, Promise<unknown>>()
  // p.sleep: a pass runs from a timer, outside any hook, so the wait costs no hook's budget.
  const pause = () => p.sleep(PRUNE_PACE_MS)
  return {
    exists: path => p.fs.exists(path),
    list: path => p.fs.list(path),
    get: key => {
      let v = values.get(key)
      if (!v) {
        v = p.store.get(key).then(async got => {
          await pause()
          return got
        })
        values.set(key, v)
      }
      return v
    },
    delete: async key => {
      await p.store.delete(key)
      values.delete(key)
      await pause()
    },
  }
}

async function prune(p: Ports): Promise<StoreMeasure | null> {
  const listKeys = p.store.keys
  if (!listKeys) return null
  const all = await listKeys()
  const keys = all.filter(k => k.startsWith('litter.'))
  const exists = memo(p)
  const store = pacedStore(p)
  const drop = new Set<string>()

  for (const key of keys) {
    try {
      if (await gone(store, key, exists)) drop.add(key)
    } catch {
      // A read that failed keeps the key.
    }
  }
  // A run's agent list, once none of its agents is left.
  const agents = new Set(keys.filter(k => k.startsWith('litter.agent.') && !drop.has(k)).map(k => k.slice('litter.agent.'.length)))
  for (const key of keys) {
    if (!key.startsWith('litter.agents.') || key.startsWith('litter.agents./') || key === 'litter.agents.pane' || drop.has(key)) continue
    const ids = await store.get(key).catch(() => null)
    if (Array.isArray(ids) && ids.every(id => typeof id === 'string' && !agents.has(id))) drop.add(key)
  }

  let dropped = 0
  for (const key of drop) {
    try {
      await store.delete(key)
      dropped++
    } catch {
      // Left for the next pass.
    }
  }
  // The size, as the engine counts it toward the cap: every key's JSON, each value read once this pass.
  let bytes = 2
  let n = 0
  for (const key of all) {
    if (drop.has(key)) continue
    const v = await store.get(key).catch(() => undefined)
    bytes += JSON.stringify(key).length + (v === undefined ? 4 : JSON.stringify(v).length) + 2
    n++
  }
  last = { at: await p.now(), keys: n, bytes, dropped }
  if (dropped > 0) p.log(`store: dropped ${dropped} keys for folders that are gone; ${n} keys, ${Math.round(bytes / 1024)} KiB of ${STORE_CAP_BYTES / 1024 / 1024} MiB left`)
  return last
}

type PassStore = ReturnType<typeof pacedStore>

/** `p.fs.exists`, asked once per path in a pass. */
function memo(p: Ports): (path: string) => Promise<boolean> {
  const seen = new Map<string, Promise<boolean>>()
  return path => {
    let r = seen.get(path)
    if (!r) {
      r = p.fs.exists(path)
      seen.set(path, r)
    }
    return r
  }
}

async function gone(store: PassStore, key: string, exists: (path: string) => Promise<boolean>): Promise<boolean> {
  for (const prefix of PATH_PREFIXES) {
    if (!key.startsWith(prefix)) continue
    const path = key.slice(prefix.length)
    return absolute(path) && !(await exists(path))
  }
  // lifecycle.ts's `litter.agents.<runDir>` (policy.ts's `litter.agents.<run>` is the agent list, below).
  if (key.startsWith('litter.agents./')) return !(await exists(key.slice('litter.agents.'.length)))
  for (const prefix of RUN_VALUE_PREFIXES) {
    if (!key.startsWith(prefix)) continue
    const v = await store.get(key)
    return isObject(v) && absolute(v.runDir) && !(await exists(v.runDir))
  }
  if (key.startsWith('litter.agent.')) {
    const v = await store.get(key)
    return isObject(v) && absolute(v.cwd) && !(await exists(v.cwd))
  }
  for (const prefix of SWARM_PREFIXES) {
    if (!key.startsWith(prefix)) continue
    const parts = swarmKeyParts(key.slice(prefix.length))
    if (!parts) return false
    if (!(await exists(parts.litterDir))) return true
    if (prefix === 'litter.swarm.draft.') return false
    if (!(await exists(swarmDir(parts.litterDir, parts.swarm)))) return true
    if (prefix === 'litter.swarm.state.') return ended(store, key, parts.litterDir, parts.swarm)
    return false
  }
  return false
}

/** A swarm part whose launch recorded swarm.end, for a swarm this session doesn't hold live. */
async function ended(store: PassStore, key: string, litterDir: string, swarm: string): Promise<boolean> {
  if (liveSwarm(swarm) !== null) return false
  const v = await store.get(key)
  const launch = isObject(v) && isObject(v.swarm) && typeof v.swarm.launch === 'string' ? v.swarm.launch : null
  if (!launch || launch.includes('/')) return false
  const dir = ledgerDir(launchDir(litterDir, swarm, launch))
  if (!(await store.exists(dir))) return false
  return (await store.list(dir)).some(e => e.kind === 'file' && /^[0-9]{6}-swarm\.end\.json$/.test(e.name))
}

/** The pass after session.start, then every few hours: on timers, so no hook waits on it. */
export const PRUNE_DELAY_MS = 20_000
export const PRUNE_EVERY_MS = 6 * 60 * 60 * 1000

export function startStorePrune(p: Ports): void {
  const run = () => void pruneStore(p).catch(err => p.log(`store prune failed: ${err instanceof Error ? err.message : String(err)}`))
  p.after(PRUNE_DELAY_MS, run)
  p.every(PRUNE_EVERY_MS, run)
}
