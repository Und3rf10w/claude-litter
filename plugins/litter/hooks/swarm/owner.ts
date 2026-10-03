// WP-K: who owns a live swarm (15.4, "One session owns a live swarm"): the
// create-only ref and its blob, the lease beat, handover, the stale owner
// standing down, the rebind's swap after a /clear, and the release at End.
//
// Built like the run lock (lock.ts; plan section 9, "Launch preconditions",
// step 0): `refs/litter-swarm/<name>` names a blob `{ swarm, launch, session,
// generation, host, pid, acquiredAt }`, so every acquisition, swap and
// handover has its own oid. Git's ref lock makes the create and each
// compare-and-swap atomic across processes and linked worktrees. Every ref
// change here is a compare-and-swap on the oid this process holds, so nothing
// ever moves a ref another session took.
//
// What this module holds is this process's: the swarms it owns, with the oid
// and generation, and their beats. A reload starts empty, and recovery
// (recover.ts) takes each owned swarm back with retakeOwnership.

import type { Ports, RunResult } from '../ports'
import type { SwarmEntry } from '../hookfiles'
import type { LiveSwarm, OwnerBlob, OwnerView } from './types'
import { ownerLeasePath, SWARM_NAME, swarmRef } from '../layout'
import { atomicWriteJson, readJson, remove, serial } from '../fsx'
import { repoOf } from '../lifecycle'
import { OID } from '../worktrees'
import { appendLaunchRecord } from '../records/swarm'
import { liveSwarm, patchLiveSwarm, withGateClosed } from './state'
import { heldBy, notNewer, patchSwarmPolicy, writeSwarmPolicy } from './guard'
import { readLaunchFacts, recoverOwnedLaunch } from './recover'

/** The ownership a launch took: `refs/litter-swarm/<name>` at its blob. */
export type Ownership = { ref: string; oid: string; generation: number }

/**
 * What this process holds of a swarm, checked against the ref just now
 * (confirmOwnership): the launch, the generation, and every oid it held under
 * it, the current one first. guard.ts's heldBy takes it as the entry a
 * destructive write expects.
 */
export type OwnerHeld = { launch: string; generation: number; oids: string[] }

/** How often an owner beats its lease. */
export const OWNER_BEAT_MS = 10_000
/** A lease (or, with none, an acquisition) older than this may be handed over (15.4). */
export const OWNER_STALE_MS = 60_000

/**
 * The other packages' functions this module calls, through one table so tier
 * 2 can stand in for them: in K's worktree their bodies are stubs (COMMON,
 * "Another package's module"). The mod never changes it.
 */
export const deps = {
  writeSwarmPolicy: (...a: Parameters<typeof writeSwarmPolicy>) => writeSwarmPolicy(...a),
  patchSwarmPolicy: (...a: Parameters<typeof patchSwarmPolicy>) => patchSwarmPolicy(...a),
}

/** The lease beside the blob: `swarms/<name>/owner-lease-<oid>.json`. */
type OwnerLease = { oid: string; swarm: string; session: string; beatAt: number }

/** One swarm this process owns. */
type Held = {
  litterDir: string
  name: string
  ref: string
  oid: string
  /** Every oid this process held under this generation, the current one first: the entry may still name an earlier one. */
  oids: string[]
  generation: number
  blob: OwnerBlob
  /** A beat found the ref moved: this process stood down. */
  lost: boolean
  timer: { cancel(): void } | null
  busy: Promise<void> | null
}

const held = new Map<string, Held>()

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const ownerKey = (litterDir: string, name: string) => `swarm-owner:${litterDir}:${name}`
const PID = /^[0-9]{1,10}$/

function git(p: Ports, repo: string, argv: readonly string[], stdin?: string): Promise<RunResult> {
  return p.run(['git', '-C', repo, ...argv], stdin === undefined ? {} : { stdin })
}

// ---------------------------------------------------------------------------
// The ref and its blob

/** The blob as JSON, every field its type; null for anything else (it's repository content). */
function parseBlob(text: string): OwnerBlob | null {
  try {
    const b = JSON.parse(text) as Record<string, unknown>
    if (typeof b !== 'object' || b === null) return null
    const { swarm, launch, session, generation, host, pid, acquiredAt } = b
    if (typeof swarm !== 'string' || typeof launch !== 'string' || typeof session !== 'string') return null
    if (typeof generation !== 'number' || !Number.isInteger(generation) || generation < 1) return null
    if (typeof host !== 'string' || typeof pid !== 'string' || typeof acquiredAt !== 'number') return null
    return { swarm, launch, session, generation, host, pid, acquiredAt }
  } catch {
    return null
  }
}

/**
 * The oid the ref names: null when it doesn't exist, undefined when git
 * couldn't tell (it didn't run, or failed otherwise).
 */
async function refOid(p: Ports, repo: string, name: string): Promise<string | null | undefined> {
  try {
    const r = await git(p, repo, ['rev-parse', '-q', '--verify', swarmRef(name)])
    if (r.code === 1) return null
    const oid = r.stdout.trim()
    return r.code === 0 && OID.test(oid) ? oid : undefined
  } catch {
    return undefined
  }
}

/** The ref's oid and its blob (null when it doesn't parse), or null when no one holds it. */
export async function readOwnerRef(p: Ports, litterDir: string, name: string): Promise<{ oid: string; blob: OwnerBlob | null } | null> {
  if (!SWARM_NAME.test(name)) return null
  const repo = repoOf(litterDir)
  const oid = await refOid(p, repo, name)
  if (!oid) return null
  const b = await git(p, repo, ['cat-file', 'blob', oid])
  return { oid, blob: b.code === 0 ? parseBlob(b.stdout) : null }
}

async function writeBlob(p: Ports, repo: string, blob: OwnerBlob): Promise<string> {
  const r = await git(p, repo, ['hash-object', '-w', '--stdin'], JSON.stringify(blob))
  const oid = r.stdout.trim()
  if (r.code !== 0 || !OID.test(oid)) throw new Error(`litter: couldn't write the ownership blob: ${r.stderr.trim()}`)
  return oid
}

/** `git update-ref <ref> <new> <old>`: a compare-and-swap, or with `old` '' a create. */
async function swapRef(p: Ports, repo: string, name: string, next: string, old: string, why: string): Promise<boolean> {
  const r = await git(p, repo, ['update-ref', '-m', `litter: swarm ${name}: ${why}`, swarmRef(name), next, old])
  return r.code === 0
}

let me: { host: string; pid: string } | null = null

/**
 * This process: its host (`uname -n`) and Claude Code's pid (`echo $PPID`,
 * spike 16: the argv runs with no shell between). Read once per module
 * instance, which a restart replaces. A pid that can't be read is '', which a
 * handover treats like another host's.
 */
async function whoAmI(p: Ports): Promise<{ host: string; pid: string }> {
  if (me) return me
  const [h, pp] = await Promise.all([
    p.run(['uname', '-n']).catch(() => null),
    p.run(['sh', '-c', 'echo $PPID']).catch(() => null),
  ])
  const host = h?.code === 0 ? h.stdout.trim() : ''
  const pid = pp?.code === 0 ? pp.stdout.trim() : ''
  me = { host: host === '' ? 'unknown' : host, pid: PID.test(pid) ? pid : '' }
  return me
}

/** Whether `pid` runs on this host: `kill -0`, the pid all digits and its own argv element. Null when it can't tell. */
async function pidAlive(p: Ports, pid: string): Promise<boolean | null> {
  if (!PID.test(pid)) return null
  try {
    const r = await p.run(['sh', '-c', 'kill -0 "$1" 2>/dev/null', 'sh', pid])
    return r.code === 0
  } catch {
    return null
  }
}

const holderText = (blob: OwnerBlob | null, oid: string): string =>
  blob ? `session ${blob.session} on ${blob.host} (generation ${blob.generation})` : `an unreadable blob (${oid})`

function hold(litterDir: string, name: string, oid: string, blob: OwnerBlob, was: readonly string[] = []): Held {
  const prev = held.get(name)
  prev?.timer?.cancel()
  const oids = [oid, ...was.filter(x => x !== oid)]
  const h: Held = { litterDir, name, ref: swarmRef(name), oid, oids, generation: blob.generation, blob, lost: false, timer: null, busy: null }
  held.set(name, h)
  return h
}

const heldOf = (h: Held): OwnerHeld => ({ launch: h.blob.launch, generation: h.generation, oids: [...h.oids] })

/** Creates the ref, create-only, at a blob `{ swarm, launch, session, generation: 1, host, pid, acquiredAt }`. Rejects when it exists. */
export async function acquireOwnership(p: Ports, litterDir: string, name: string, launch: string): Promise<Ownership> {
  if (!SWARM_NAME.test(name)) throw new Error(`litter: '${name}' isn't a swarm name`)
  const repo = repoOf(litterDir)
  const { host, pid } = await whoAmI(p)
  const blob: OwnerBlob = { swarm: name, launch, session: await p.sessionId(), generation: 1, host, pid, acquiredAt: await p.now() }
  return serial(ownerKey(litterDir, name), async () => {
    const oid = await writeBlob(p, repo, blob)
    if (!(await swapRef(p, repo, name, oid, '', `launch ${launch}`))) {
      const holder = await readOwnerRef(p, litterDir, name)
      throw new Error(
        holder
          ? `litter: swarm ${name} is already owned: ${swarmRef(name)} names ${holderText(holder.blob, holder.oid)}`
          : `litter: couldn't take ${swarmRef(name)}`,
      )
    }
    const h = hold(litterDir, name, oid, blob)
    return { ref: h.ref, oid, generation: 1 }
  })
}

/**
 * Recovery's swap (recover.ts, step 5): the ref still names `expect`, whose
 * blob names this session, so it moves to a blob with this process's pid and
 * host, keeping the session and generation. Null when the ref moved, the blob
 * isn't this session's, or the swap failed: then nothing is held.
 */
export async function retakeOwnership(
  p: Ports,
  litterDir: string,
  name: string,
  expect: { oid: string; blob: OwnerBlob },
): Promise<Ownership | null> {
  const repo = repoOf(litterDir)
  const { host, pid } = await whoAmI(p)
  const session = await p.sessionId()
  if (expect.blob.session !== session || expect.blob.swarm !== name) return null
  return serial(ownerKey(litterDir, name), async () => {
    if ((await refOid(p, repo, name)) !== expect.oid) return null
    const blob: OwnerBlob = { ...expect.blob, host, pid }
    const oid = await writeBlob(p, repo, blob)
    // The same blob hashes to the same oid: nothing to swap.
    if (oid !== expect.oid && !(await swapRef(p, repo, name, oid, expect.oid, 'restart'))) return null
    if (oid !== expect.oid) await remove(p, ownerLeasePath(litterDir, name, expect.oid)).catch(() => {})
    // The entry may still name the earlier process's oid, this session's too.
    const h = hold(litterDir, name, oid, blob, [expect.oid])
    return { ref: h.ref, oid, generation: h.generation }
  })
}

// ---------------------------------------------------------------------------
// The beat

/**
 * The entry the beat keeps in policy.json (Q4): the launch, state, common dir
 * and node types from the live swarm, the owner from what this process holds.
 * Null while there's no live swarm of its own to describe (Launch before
 * swarm.start, a handover before its recovery).
 */
function entryOf(h: Held, s: LiveSwarm | null, checkedAt: number): SwarmEntry | null {
  if (!s || s.readOnly || s.lost || s.launch !== h.blob.launch) return null
  return {
    launch: s.launch,
    state: s.state,
    commonDir: s.commonDir,
    owner: { ref: h.ref, oid: h.oid, generation: h.generation, session: h.blob.session, checkedAt },
    nodeTypes: Object.values(s.types),
  }
}

/**
 * The ref names another oid, or none: this process stands down (15.4, "A
 * stale owner stands down"). The swarm is lost in state.ts, so L refuses its
 * spawns and sends, and the beat stops. Nothing is written: the new owner's
 * entry in policy.json carries the next generation, which denies every node
 * bound under this one, and until it's written the guard's stale check
 * (`checkedAt` over 10 s old, then rev-parse) denies them. Nothing is removed.
 * Not even a record: the launch ledger has one writer, the new owner.
 */
function standDown(p: Ports, h: Held, now: string | null): void {
  h.lost = true
  h.timer?.cancel()
  h.timer = null
  patchLiveSwarm(h.name, { lost: true })
  p.log(`swarm ${h.name}: ${h.ref} now names ${now ?? 'nothing'}, not ${h.oid}; this session stands down and touches nothing of it`)
  p.toast(`litter: swarm ${h.name} was handed to another session; this session no longer acts on it`)
}

/**
 * One beat: the ref check, the lease, and policy.json's entry with its
 * `owner.checkedAt` (seconds). Never rejects.
 *
 * The whole entry, not a patch of its check time (Q4): policy.json is shared
 * by every session in the repository, and the serial key only orders this
 * process's writes, so another session's read-modify-write can lose this
 * swarm's entry, or bring back an older one. While the ref is its own, the
 * beat writes the entry it holds, and `active` with it (writeSwarmPolicy),
 * over anything but a newer owner's (notNewer). That also heals a rebind
 * whose patch failed (Q3) and an `active` a node removed from Bash.
 */
function beat(p: Ports, h: Held): Promise<void> {
  if (h.lost || held.get(h.name) !== h) return Promise.resolve()
  if (h.busy) return h.busy
  h.busy = serial(ownerKey(h.litterDir, h.name), async () => {
    try {
      if (h.lost || held.get(h.name) !== h) return
      const now = await refOid(p, repoOf(h.litterDir), h.name)
      // Git couldn't tell: the next beat asks again.
      if (now === undefined) return p.log(`swarm ${h.name}: the beat couldn't read ${h.ref}`)
      if (now !== h.oid) return standDown(p, h, now)
      const at = await p.now()
      const lease: OwnerLease = { oid: h.oid, swarm: h.name, session: h.blob.session, beatAt: at }
      await atomicWriteJson(p, ownerLeasePath(h.litterDir, h.name, h.oid), lease)
      // Checked, read and handed to the writer's queue in one step, with no await between: a stop of the beat
      // (End's release, a failed launch) comes before or after it, and a removal after it isn't undone.
      if (h.timer === null || h.lost || held.get(h.name) !== h) return
      const entry = entryOf(h, liveSwarm(h.name), Math.floor(at / 1000))
      if (entry) await deps.writeSwarmPolicy(p, h.litterDir, h.name, entry, notNewer(entry.launch, h.generation))
    } catch (err) {
      p.log(`swarm ${h.name}: the ownership beat failed: ${errText(err)}`)
    }
  }).finally(() => {
    h.busy = null
  })
  return h.busy
}

/** Starts the 10 s beat for an owned swarm: the ref check, the lease file, policy.json's `owner.checkedAt`. */
export function startOwnerBeat(p: Ports, litterDir: string, name: string): void {
  const h = held.get(name)
  if (!h || h.litterDir !== litterDir) throw new Error(`litter: this session holds no ownership of swarm ${name}`)
  if (h.lost) return
  h.timer?.cancel()
  void beat(p, h)
  // The callback hands back the beat's promise, so a caller that awaits its timers sees it done.
  h.timer = p.every(OWNER_BEAT_MS, () => beat(p, h))
}

/** Stops one swarm's beat, or every swarm's with no name (O at a session.end that isn't a clear). */
export function stopOwnerBeat(name?: string): void {
  for (const h of held.values()) {
    if (name !== undefined && h.name !== name) continue
    h.timer?.cancel()
    h.timer = null
  }
}

/** This session's ownership of `name` was lost (a beat found the ref moved). */
export function ownerLost(name: string): boolean {
  return held.get(name)?.lost === true || liveSwarm(name)?.lost === true
}

/** What this process holds for `name`, while it owns it. */
export function ownedSwarm(name: string): Ownership | null {
  const h = held.get(name)
  return h && !h.lost ? { ref: h.ref, oid: h.oid, generation: h.generation } : null
}

/**
 * Before anything destructive (End's finish and its stopping, Q2): the ref
 * read again, under the beat's key, since the beat that marks a swarm lost
 * runs only every 10 s. Answers what this process holds when the ref still
 * names its oid; 'lost' when it names another, or this process holds nothing
 * of it (it stands down, as a beat would: nothing is written, recorded or
 * removed); null when git couldn't tell, so the caller tries again later.
 */
export async function confirmOwnership(p: Ports, litterDir: string, name: string): Promise<OwnerHeld | 'lost' | null> {
  const h = held.get(name)
  if (!h || h.litterDir !== litterDir) {
    if (liveSwarm(name) && !liveSwarm(name)!.lost) {
      p.log(`swarm ${name}: this process holds no ownership of it, so it no longer acts on it`)
      patchLiveSwarm(name, { lost: true })
    }
    return 'lost'
  }
  if (h.lost) return 'lost'
  return serial(ownerKey(litterDir, name), async (): Promise<OwnerHeld | 'lost' | null> => {
    if (h.lost || held.get(name) !== h) return 'lost'
    const now = await refOid(p, repoOf(litterDir), name)
    if (now === undefined) return null
    if (now !== h.oid) {
      standDown(p, h, now)
      return 'lost'
    }
    return heldOf(h)
  })
}

// ---------------------------------------------------------------------------
// Reading it

async function leaseAge(p: Ports, litterDir: string, name: string, oid: string, now: number): Promise<number | null> {
  try {
    const lease = await readJson<OwnerLease>(p, ownerLeasePath(litterDir, name, oid))
    return lease && lease.oid === oid && typeof lease.beatAt === 'number' ? Math.max(0, now - lease.beatAt) : null
  } catch {
    return null
  }
}

/** The ref, its blob, the lease's age, whether it's this session's, and whether a handover is possible. */
export async function readOwner(p: Ports, litterDir: string, name: string): Promise<OwnerView | null> {
  if (!SWARM_NAME.test(name)) return null
  const ref = swarmRef(name)
  const found = await readOwnerRef(p, litterDir, name)
  if (!found) return { swarm: name, ref, oid: null, blob: null, leaseAgeMs: null, mine: false, canHandOver: false, why: 'no session owns it' }
  const { oid, blob } = found
  const now = await p.now()
  const leaseAgeMs = await leaseAge(p, litterDir, name, oid, now)
  const view = (canHandOver: boolean, why: string | null, mine = false): OwnerView => ({
    swarm: name,
    ref,
    oid,
    blob,
    leaseAgeMs,
    mine,
    canHandOver,
    why,
  })
  if (!blob) return view(false, `${ref} names a blob litter can't read (${oid})`)
  if (blob.session === (await p.sessionId())) return view(false, 'this session owns it', true)
  const age = leaseAgeMs ?? Math.max(0, now - blob.acquiredAt)
  if (age <= OWNER_STALE_MS) {
    return view(false, `its owner, session ${blob.session}, beat its lease ${Math.round(age / 1000)} s ago; a handover needs it over ${OWNER_STALE_MS / 1000} s stale`)
  }
  const { host } = await whoAmI(p)
  if (blob.host === host && PID.test(blob.pid)) {
    const alive = await pidAlive(p, blob.pid)
    if (alive !== false) {
      return view(false, alive ? `its owner's process ${blob.pid} is still running on this host` : `litter couldn't check its owner's process ${blob.pid}`)
    }
  }
  return view(true, null)
}

// ---------------------------------------------------------------------------
// Handover

type Refusal = { ok: false; reason: string }
const refuse = (reason: string): Refusal => ({ ok: false, reason: `litter: can't take over swarm: ${reason}` })

/** [Take over]: refused while the owner's lease is fresh or its pid alive here; then your confirmation, the swap to the next generation, and recovery. */
export async function handover(p: Ports, litterDir: string, name: string): Promise<{ ok: true } | { ok: false; reason: string }> {
  const view = await readOwner(p, litterDir, name)
  if (!view) return refuse(`'${name}' isn't a swarm name`)
  if (!view.oid || !view.blob) return refuse(`${name}: ${view.why ?? 'no session owns it'}`)
  if (!view.canHandOver) return refuse(`${name}: ${view.why ?? 'not now'}`)
  const old = { oid: view.oid, blob: view.blob }
  const facts = await readLaunchFacts(p, litterDir, name, old.blob.launch)
  if (!facts.start || facts.ended) return refuse(`${name}: its launch ${old.blob.launch} isn't live in the ledger`)
  if (facts.tampered) return refuse(`${name}: launch ${old.blob.launch}'s ledger is tampered at record ${facts.tampered.seq}`)
  const { host, pid } = await whoAmI(p)

  // Another host's process can't be checked from here: your word that its session is closed.
  if (old.blob.host !== host || !PID.test(old.blob.pid)) {
    const closed = await p
      .ask(
        `Swarm ${name} is owned by session ${old.blob.session} on ${old.blob.host}, which this session can't check. ` +
          `Take it over only if that session is closed. Is it closed?`,
        { options: ['It is closed', 'Cancel'], header: 'Take over swarm' },
      )
      .catch(() => null)
    if (closed !== 'It is closed') return refuse(`${name}: a handover from another host needs your confirmation that its session is closed`)
  }

  const bound = [...facts.nodes.values()].filter(r => r.body.kind !== 'child')
  const listed = bound.length === 0 ? 'none' : bound.map(r => `${r.body.node} #${r.body.n} (${r.body.agentId})`).join(', ')
  const answer = await p
    .ask(
      `Take over swarm ${name} (launch ${old.blob.launch}) from session ${old.blob.session}?\n` +
        `The nodes it had bound: ${listed}.\n` +
        `Any of them still alive in that session would be duplicated by a re-spawn here. Its agents stay denied, ` +
        `and this session can only re-spawn them.`,
      { options: ['Take over', 'Cancel'], header: 'Take over swarm' },
    )
    .catch(() => null)
  if (answer !== 'Take over') return refuse(`${name}: a handover needs your confirmation`)

  const repo = repoOf(litterDir)
  const session = await p.sessionId()
  const blob: OwnerBlob = { swarm: name, launch: old.blob.launch, session, generation: old.blob.generation + 1, host, pid, acquiredAt: await p.now() }
  const took = await serial(ownerKey(litterDir, name), async () => {
    if ((await refOid(p, repo, name)) !== old.oid) return null
    const oid = await writeBlob(p, repo, blob)
    if (!(await swapRef(p, repo, name, oid, old.oid, `handover to ${session}`))) return null
    return hold(litterDir, name, oid, blob)
  })
  if (!took) return refuse(`${name}: ${swarmRef(name)} changed while you confirmed`)
  startOwnerBeat(p, litterDir, name)

  const start = facts.start.body
  try {
    // The entry first, so the old generation's nodes are denied at once.
    const entry: SwarmEntry = {
      launch: old.blob.launch,
      state: facts.stopping ? 'stopping' : 'live',
      commonDir: start.commonDir,
      owner: { ref: took.ref, oid: took.oid, generation: took.generation, session, checkedAt: Math.floor((await p.now()) / 1000) },
      nodeTypes: Object.values(start.types),
    }
    // Over the old generation's entry, never a newer one's.
    await deps.writeSwarmPolicy(p, litterDir, name, entry, notNewer(entry.launch, took.generation))
    await appendLaunchRecord(p, litterDir, name, old.blob.launch, 'swarm.handover', { from: old.blob.session, to: session, generation: took.generation })
    await remove(p, ownerLeasePath(litterDir, name, old.oid)).catch(() => {})
    // Recovery, in this session now: the old bindings keep their generation, so the card offers them for re-spawn only.
    await withGateClosed(() => recoverOwnedLaunch(p, litterDir, name, facts, { oid: took.oid, generation: took.generation, session }))
  } catch (err) {
    p.log(`swarm ${name}: the handover took the ref, then failed: ${errText(err)}`)
    return { ok: false, reason: `litter: swarm ${name} is this session's now, but its recovery failed: ${errText(err)}` }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// The rebind and the release

/**
 * After a /clear (O): each owned swarm's ref swapped to a blob naming
 * `newSession`, keeping the generation. In this order (Q3): the entry's check
 * time first, since the beat is stopped for the rebind and a node's call
 * would otherwise find the check over 10 s old and rev-parse a ref about to
 * move; then the swap, this process's oid at once, and only then the entry's
 * oid. A failure of either patch is logged, and the next beat writes the
 * whole entry from what this process holds (Q4): the owner never stands down
 * from its own swap.
 */
export async function rebindOwnership(p: Ports, litterDir: string, newSession: string): Promise<void> {
  const repo = repoOf(litterDir)
  const patch = async (h: Held, what: string, change: (e: SwarmEntry) => SwarmEntry) => {
    try {
      await deps.patchSwarmPolicy(p, litterDir, h.name, change, heldBy(heldOf(h)))
    } catch (err) {
      p.log(`swarm ${h.name}: the rebind's ${what} in policy.json failed (the next beat writes it): ${errText(err)}`)
    }
  }
  for (const h of [...held.values()]) {
    if (h.litterDir !== litterDir || h.lost || h.blob.session === newSession) continue
    try {
      const done = await serial(ownerKey(litterDir, h.name), async () => {
        const now = await refOid(p, repo, h.name)
        if (now !== h.oid) {
          if (now !== undefined) standDown(p, h, now)
          return false
        }
        const before = Math.floor((await p.now()) / 1000)
        await patch(h, 'check time', e => ({ ...e, owner: { ...e.owner, checkedAt: before } }))
        const blob: OwnerBlob = { ...h.blob, session: newSession }
        const oid = await writeBlob(p, repo, blob)
        if (!(await swapRef(p, repo, h.name, oid, h.oid, `rebind to ${newSession}`))) return false
        const was = h.oid
        h.oid = oid
        h.oids = [oid, ...h.oids]
        h.blob = blob
        const s = liveSwarm(h.name)
        if (s && !s.readOnly) patchLiveSwarm(h.name, { owner: { ...s.owner, oid, session: newSession } })
        await remove(p, ownerLeasePath(litterDir, h.name, was)).catch(() => {})
        const checkedAt = Math.floor((await p.now()) / 1000)
        await patch(h, 'oid', e => ({ ...e, owner: { ...e.owner, oid, session: newSession, checkedAt } }))
        return true
      })
      if (done) startOwnerBeat(p, litterDir, h.name)
      else p.log(`swarm ${h.name}: its ownership wasn't moved to session ${newSession}`)
    } catch (err) {
      p.log(`swarm ${h.name}: the rebind's ownership swap failed: ${errText(err)}`)
    }
  }
}

/**
 * At End (P): a compare-and-delete of the ref on this session's oid, then the
 * lease file. Answers whether it released (Q2): false for a process that
 * doesn't hold it, for a stale owner (the ref names another oid; it stands
 * down), and when git failed; a ref already gone counts as released. Either
 * way this process holds it no longer.
 */
export async function releaseOwnership(p: Ports, litterDir: string, name: string): Promise<boolean> {
  stopOwnerBeat(name)
  const h = held.get(name)
  // Only an oid this process holds: a stale owner removes nothing, and another session's oid is never used.
  if (!h || h.lost || h.litterDir !== litterDir) return false
  return serial(ownerKey(litterDir, name), async () => {
    const repo = repoOf(litterDir)
    const r = await git(p, repo, ['update-ref', '-m', `litter: swarm ${name}: end`, '-d', h.ref, h.oid])
    let released = r.code === 0
    if (!released) {
      p.log(`swarm ${name}: ${h.ref} wasn't released (it doesn't name ${h.oid}): ${r.stderr.trim()}`)
      const now = await refOid(p, repo, name)
      if (now === null) released = true
      else if (now !== undefined && now !== h.oid) {
        standDown(p, h, now)
        if (held.get(name) === h) held.delete(name)
        return false
      }
    }
    await remove(p, ownerLeasePath(litterDir, name, h.oid)).catch(() => {})
    if (held.get(name) === h) held.delete(name)
    return released
  })
}

/** A fresh module's holdings, for tests: nothing owned, no beat, the host and pid read again. */
export function resetOwnersForTests(): void {
  for (const h of held.values()) h.timer?.cancel()
  held.clear()
  me = null
}
