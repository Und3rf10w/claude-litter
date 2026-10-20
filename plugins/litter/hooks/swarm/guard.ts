// The mod's writer for the files guard.sh and hold.sh read (plan 15.4, "The
// guard for nodes"; 15.8, "The node policy"; section 9, "Mod-to-hook state"):
// a node's or child's policy (`agents/<agentId>.json` with `node`),
// policy.json's `swarm` entry with `active`, and the pending markers a crash
// left. Owner: phase 2b-1, package M.
//
// Every file is replaced atomically, before the call that changed it is
// answered, so the agent's next tool call already sees the change. A node's
// policy is keyed by agentId, never by session, so a /clear leaves it as it is.
//
// Every write and patch of one agent's file runs under that file's serial
// key. A write reads the stopped list inside it, so a Stop (end.ts, stopNode:
// the list, then the patch under the same key) can't fall between the read
// and the write. A write or patch that admits the agent removes its `done/`
// first: an agent that runs again isn't finished, whatever its last stop or
// hand-back wrote (hold.sh waits on that file).

import type { Ports } from '../ports'
import type { AgentPolicy, NodePolicy, PendingMarker, Policy, SwarmEntry } from '../hookfiles'
import type { LiveSwarm, NodeBinding } from './types'
import { agentPolicyPath, donePath, holdPath, hooksDir, nodeTypeName, pendingDir, policyPath, shellsPath } from '../layout'
import { atomicWriteJson, readJson, remove, serial } from '../fsx'
import { policyKey, readPolicy, setActive, updatePolicy, writePolicy } from '../policy'
import { ROLE_POLICIES } from '../roles'
import * as state from './state'

/** The binding's state flags a policy carries. */
export type NodeFlags = { admitted: boolean; stopped: string | null; bind: boolean }

/** An id the hooks name a file by (lib.sh's lt_id_ok). */
const AGENT_ID = /^[A-Za-z0-9_-]{1,128}$/

/** The rule folders (plan 16.1), under a node's directory as under the primary checkout. */
const RULE_DIRS = ['.litter', '.litter.local', '.claude/rules/litter', '.claude/rules/litter-local'] as const

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const trimSlash = (path: string): string => (path.length > 1 ? path.replace(/\/+$/, '') : path)

function checkId(agentId: string): void {
  if (!AGENT_ID.test(agentId)) throw new Error(`litter: ${JSON.stringify(agentId)} isn't an agent id the hooks can name a file by`)
}

/**
 * A `paths` entry under the node's directory (15.3: relative to it, a
 * trailing `/` a folder), its `.` and `..` folded; null when it leaves the
 * directory, so the entry allows nothing rather than something else.
 */
function underDir(dir: string, entry: string): string | null {
  const parts: string[] = []
  for (const part of (entry.startsWith('/') ? entry : `${dir}/${entry}`).split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(part)
  }
  const path = `/${parts.join('/')}`
  if (path === dir) return `${dir}/`
  if (!path.startsWith(`${dir}/`)) return null
  return entry === '' || entry.endsWith('/') || /(^|\/)\.{1,2}$/.test(entry) ? `${path}/` : path
}

const fullRef = (branch: string | null): string | null =>
  branch === null || branch === '' ? null : branch.startsWith('refs/') ? branch : `refs/heads/${branch}`

/**
 * A node's or child's NodePolicy, from the spec at `swarm.revision`, the
 * binding and the flags. A child gets its node's scope: its binding names its
 * node, and its directory is the one the spawn check pinned it to. Throws for
 * a node the launched spec doesn't have.
 */
export function nodePolicyFor(binding: NodeBinding, swarm: LiveSwarm, flags: NodeFlags): NodePolicy {
  const spec = swarm.spec.nodes.find(n => n.id === binding.node)
  if (!spec) throw new Error(`litter: node ${binding.node} isn't in swarm ${swarm.name} at revision ${swarm.revision}`)
  const dir = trimSlash(binding.cwd)
  const typeOf = (id: string): string => swarm.types[id] ?? `litter:${nodeTypeName(swarm.name, id)}`
  const authority = { ...(spec.authority ?? {}) }
  const protect = [
    swarm.roots.litterDir,
    ...swarm.roots.litterCopies,
    ...swarm.roots.ruleDirs,
    `${dir}/.claude/litter`,
    ...RULE_DIRS.map(r => `${dir}/${r}`),
  ]
  return {
    swarm: binding.swarm,
    launch: binding.launch,
    node: binding.node,
    n: binding.kind === 'child' ? 0 : binding.n,
    kind: binding.kind,
    of: binding.of,
    type: binding.type !== '' ? binding.type : typeOf(binding.node),
    parent: binding.parent,
    generation: binding.generation,
    dir,
    paths: spec.paths === undefined ? null : spec.paths.flatMap(e => underDir(dir, e) ?? []),
    protect: [...new Set(protect.map(trimSlash).filter(x => x !== ''))],
    branch: authority.commit === true ? fullRef(binding.branch) : null,
    authority,
    toolsDeny: [...(spec.tools?.deny ?? [])],
    bashDeny: [...(spec.bash?.deny ?? [])],
    spawns: Object.keys(spec.spawns ?? {}).map(typeOf),
    spawnOther: spec.spawnOther !== false,
    admitted: flags.admitted,
    stopped: flags.stopped,
    bind: flags.bind,
  }
}

/** One key per agent's file: a write and a patch of the same file never interleave. */
const nodeKey = (litterDir: string, agentId: string) => `node-policy:${litterDir}:${agentId}`

/**
 * Why the agent, or else the agent that spawned it, is on its swarm's
 * stopped list now (state.ts); null when neither is. A stop of the parent
 * that came before this agent had a binding couldn't name it (end.ts,
 * stopNode, by descendants), so the parent's entry counts too (15.4: a
 * stopped node starts nothing, and what it started is stopped with it).
 */
function stoppedNow(swarm: string, agentId: string, parent: string | null): string | null {
  const list = state.stopped(swarm)
  const own = list.find(x => x.agentId === agentId)
  if (own) return own.reason
  return parent === null ? null : (list.find(x => x.agentId === parent)?.reason ?? null)
}

/** done/<agentId> goes before the file that admits it: hold.sh must never see an admitted agent as finished. */
async function clearDone(p: Ports, litterDir: string, agentId: string): Promise<void> {
  const path = donePath(litterDir, agentId)
  if (await p.fs.exists(path)) await remove(p, path)
}

/**
 * Writes `agents/<agentId>.json` as `{ v: 1, node }`, atomically. `stopped`
 * is the node's own, else what the stopped list says now, read under the
 * file's key. Admitted, its `done/` is removed first.
 */
export async function writeNodePolicy(p: Ports, litterDir: string, agentId: string, node: NodePolicy): Promise<void> {
  checkId(agentId)
  await serial(nodeKey(litterDir, agentId), async () => {
    const file: AgentPolicy = { v: 1, node: { ...node, stopped: node.stopped ?? stoppedNow(node.swarm, agentId, node.parent) } }
    if (node.admitted) await clearDone(p, litterDir, agentId)
    await atomicWriteJson(p, agentPolicyPath(litterDir, agentId), file)
  })
}

/** Read, change and write under one serial key per file; a missing file stays missing. Admitting, its `done/` goes first. */
export async function patchNodePolicy(p: Ports, litterDir: string, agentId: string, patch: Partial<NodePolicy>): Promise<void> {
  checkId(agentId)
  await serial(nodeKey(litterDir, agentId), async () => {
    const path = agentPolicyPath(litterDir, agentId)
    const file = await readJson<AgentPolicy>(p, path)
    if (file === undefined) return
    if (file === null || file.v !== 1 || typeof file.node !== 'object' || file.node === null) {
      throw new Error(`litter: ${path} isn't a node's policy; left as it is`)
    }
    if (patch.admitted === true) await clearDone(p, litterDir, agentId)
    await atomicWriteJson(p, path, { ...file, node: { ...file.node, ...patch } } satisfies AgentPolicy)
  })
}

/** patchNodePolicy for each agent; every one is tried, and the failures are reported together. */
export async function patchNodePolicies(p: Ports, litterDir: string, agentIds: readonly string[], patch: Partial<NodePolicy>): Promise<void> {
  const ids = [...new Set(agentIds)]
  const results = await Promise.allSettled(ids.map(id => patchNodePolicy(p, litterDir, id, patch)))
  const failed = results.flatMap((r, i) => (r.status === 'rejected' ? [`${ids[i]}: ${errText(r.reason)}`] : []))
  if (failed.length > 0) throw new Error(`litter: ${failed.length} of ${ids.length} node policies not changed (${failed.join('; ')})`)
}

/** Removes an agent's policy, with its `done/`, `hold/` and `shells/` files. */
export async function removeNodePolicy(p: Ports, litterDir: string, agentId: string): Promise<void> {
  checkId(agentId)
  await serial(nodeKey(litterDir, agentId), async () => {
    await remove(p, agentPolicyPath(litterDir, agentId))
    await remove(p, donePath(litterDir, agentId))
    await remove(p, holdPath(litterDir, agentId))
    await remove(p, shellsPath(litterDir, agentId))
  })
}

/**
 * Whether the swarm entry policy.json holds now is one a writer may change.
 * policy.json is shared by every session in the repository, so each writer
 * says whose entry it expects (15.4, "A stale owner stands down"): a stale
 * owner never writes over, or removes, a new owner's entry.
 */
export type EntryCheck = (cur: SwarmEntry) => boolean

/**
 * The entry is the one this owner holds: its launch and generation, and a ref
 * oid it held under them (a /clear rebind moves the oid, and the entry follows
 * a step later). What a destructive write expects: End's removal, the
 * stopping, a failed launch's removal.
 */
export const heldBy =
  (o: { launch: string; generation: number; oids: readonly string[] }): EntryCheck =>
  e =>
    e.launch === o.launch && e.owner?.generation === o.generation && o.oids.includes(e.owner.oid)

/**
 * Anything but a newer owner's entry for the same launch (a handover's next
 * generation): what the owner's beat (healing its own entry), recovery and a
 * handover write over. A leftover of another launch is written over too.
 */
export const notNewer =
  (launch: string, generation: number): EntryCheck =>
  e =>
    !(e.launch === launch && typeof e.owner?.generation === 'number' && e.owner.generation > generation)

/**
 * Whether `agents/` still holds a node's or child's binding file. One that
 * doesn't parse counts: it may be a node's, and the guard denies on it. A
 * fanout writer's (`run`, no `node`) doesn't: a run's leftovers would keep
 * `active` for good.
 */
export async function nodeBindingsLeft(p: Ports, litterDir: string): Promise<boolean> {
  const dir = `${hooksDir(litterDir)}/agents`
  if (!(await p.fs.exists(dir))) return false
  for (const e of await p.fs.list(dir)) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue
    try {
      const file = await readJson<AgentPolicy>(p, `${dir}/${e.name}`)
      // Gone since the list.
      if (file === undefined) continue
      const runOnly = file !== null && typeof file === 'object' && file.node === undefined && typeof file.run === 'string'
      if (!runOnly) return true
    } catch {
      return true
    }
  }
  return false
}

/**
 * Removes `active` unless a node's binding file is left (Q10): the guard
 * denies a running node whose swarm has ended only while `active` exists,
 * since every script passes on the fast path without it (lib.sh, lt_begin).
 * Unserialised: call it under `policyKey`, once policy.json names nothing live.
 */
export async function removeActiveIfUnbound(p: Ports, litterDir: string): Promise<void> {
  if (!(await nodeBindingsLeft(p, litterDir))) await setActive(p, litterDir, false)
}

/**
 * `active` goes when nothing needs it: policy.json names no run and no swarm,
 * and `agents/` holds no node's binding (Q10). U's sweep calls it once it has
 * removed the last kept file. A policy.json that doesn't parse, or of another
 * version, leaves `active`: the guard denies on it ("policy unreadable").
 */
export async function releaseActive(p: Ports, litterDir: string): Promise<void> {
  await serial(policyKey(litterDir), async () => {
    const path = policyPath(litterDir)
    let cur: Policy | null | undefined
    try {
      cur = await readJson<Policy>(p, path)
    } catch (err) {
      p.log(`${path} doesn't parse, so hooks/active is left: ${errText(err)}`)
      return
    }
    if (cur !== undefined && (cur === null || typeof cur !== 'object' || cur.v !== 1)) {
      p.log(`${path} isn't version 1, so hooks/active is left`)
      return
    }
    if (cur && (cur.run != null || cur.swarm != null)) return
    await removeActiveIfUnbound(p, litterDir)
  })
}

/**
 * Sets (or with null removes) policy.json's `swarm.swarms[name]`, creating
 * policy.json when there's none, and `active` when the first swarm goes live
 * (removed when the last goes, no run is active and no node's binding file is
 * left). It can't use updatePolicy, which writes nothing when there's no
 * policy.json, so it reads, changes and writes under
 * `serial(policyKey(litterDir))` directly (policy.ts), the key activate,
 * deactivate and updatePolicy share; never calling updatePolicy inside it,
 * since a nested serial on the same key waits on itself.
 *
 * `expected` says whose entry the writer may change (heldBy, notNewer): an
 * entry there that fails it is left, and nothing is written. Only Launch's
 * first write passes none, so it replaces a leftover no one owns.
 */
export async function writeSwarmPolicy(p: Ports, litterDir: string, name: string, entry: SwarmEntry | null, expected?: EntryCheck): Promise<void> {
  await serial(policyKey(litterDir), async () => {
    const path = policyPath(litterDir)
    // A file that doesn't parse, or of another version, may hold a run's state: it's never written over.
    const cur = await readJson<Policy>(p, path)
    if (cur !== undefined && (cur === null || cur.v !== 1)) throw new Error(`litter: ${path} isn't version 1; the swarm entry for ${name} isn't written`)
    const swarms: Record<string, SwarmEntry> = { ...(cur?.swarm?.swarms ?? {}) }
    const there = Object.hasOwn(swarms, name) ? swarms[name] : undefined
    if (there !== undefined && expected && !expected(there)) {
      p.log(`swarm ${name}: policy.json's entry is another owner's (launch ${String(there.launch)}, generation ${String(there.owner?.generation)}); left as it is`)
      return
    }
    if (entry === null && there === undefined) return
    if (entry === null) delete swarms[name]
    else swarms[name] = entry
    const swarm = Object.keys(swarms).length > 0 ? { swarms } : null
    if (cur === undefined) {
      // A swarm can be live with no run: the roles are listed as policyFor lists them (lifecycle.ts).
      await writePolicy(p, litterDir, { v: 1, session: entry!.owner.session, litterDir, run: null, roles: { ...ROLE_POLICIES }, swarm })
      await setActive(p, litterDir, true)
      return
    }
    // `active` goes before the policy that no longer needs it, and comes after the one that does.
    if (swarm === null && cur.run === null) await removeActiveIfUnbound(p, litterDir)
    await writePolicy(p, litterDir, { ...cur, swarm })
    if (entry !== null) await setActive(p, litterDir, true)
  })
}

/**
 * Changes the entry through updatePolicy; `change` returning null, a missing
 * entry, or one that fails `expected` (whose entry the writer may change, as
 * writeSwarmPolicy's) leaves the file alone. That's how a stale owner leaves
 * the entry a new owner wrote.
 */
export async function patchSwarmPolicy(
  p: Ports,
  litterDir: string,
  name: string,
  change: (entry: SwarmEntry) => SwarmEntry | null,
  expected?: EntryCheck,
): Promise<void> {
  await updatePolicy(p, litterDir, policy => {
    const swarms = policy.swarm?.swarms
    if (!swarms || !Object.hasOwn(swarms, name)) return null
    if (expected && !expected(swarms[name]!)) return null
    const next = change(swarms[name]!)
    return next === null ? null : { ...policy, swarm: { swarms: { ...swarms, [name]: next } } }
  })
}

/** A swarm whose owner beat within this long is another live session's: its spawns may be in flight there. */
const OWNER_LIVE_SEC = 60
/** No spawn waits this long between its reservation and its binding, setup included. */
const MARKER_STALE_SEC = 15 * 60

/**
 * At session.start: removes leftover `hooks/pending/` markers (a crash
 * between reservation and binding). A reservation lives in module memory, so
 * no marker is this process's at its start. policy.json is shared by every
 * session in the repository, though, so a marker of a swarm another session
 * owns and still beats for is kept, unless it's older than any spawn takes.
 * A leftover marker would make every unknown agent's tool call wait 2 s.
 */
export async function clearPending(p: Ports, litterDir: string): Promise<void> {
  const dir = pendingDir(litterDir)
  if (!(await p.fs.exists(dir))) return
  const [sid, nowMs, policy] = await Promise.all([p.sessionId(), p.now(), readPolicy(p, litterDir).catch(() => undefined)])
  const now = nowMs / 1000
  const others = new Set(
    Object.entries(policy?.swarm?.swarms ?? {})
      .filter(([, e]) => e.owner?.session !== sid && typeof e.owner?.checkedAt === 'number' && now - e.owner.checkedAt < OWNER_LIVE_SEC)
      .map(([name]) => name),
  )
  for (const e of await p.fs.list(dir)) {
    const path = `${dir}/${e.name}`
    if (others.size > 0 && e.kind === 'file') {
      const marker = await readJson<PendingMarker>(p, path).catch(() => undefined)
      if (marker?.v === 1 && others.has(marker.swarm) && typeof marker.at === 'number' && now - marker.at < MARKER_STALE_SEC) continue
    }
    await remove(p, path).catch(err => p.log(`pending marker ${e.name} not removed: ${errText(err)}`))
  }
}
