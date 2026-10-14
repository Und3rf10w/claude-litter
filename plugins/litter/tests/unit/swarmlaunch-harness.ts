// The world K's tier-2 specs share (swarmlaunch, owner, recover and
// ownership; WP-K, FIX-Q): a scratch repository with its litter directory,
// the session set, every module's tables reset, and stand-ins for some of the
// other packages' functions K calls through its `deps` tables (COMMON,
// "Another package's module"). The stand-ins do what each one's doc comment
// says, on real files: a node's `agents/<id>.json`, J's revision files. M's
// policy.json writers are the real ones (guard.ts), since the ownership
// checks live in them. Not a spec itself.

import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { Ports } from '../../hooks/ports'
import type { NodePolicy } from '../../hooks/hookfiles'
import type { HealthInput, HealthReport, NodeBinding, OwnerBlob, SavedSwarm, SpecCheck, SwarmSpec, ValidateCtx } from '../../hooks/swarm/types'
import { agentPolicyPath, revisionBriefPath, revisionPath, swarmBriefPath, swarmDir, swarmJsonPath } from '../../hooks/layout'
import { atomicWriteJson, readJson } from '../../hooks/fsx'
import { setOptions, updateSession } from '../../hooks/session'
import { appendLaunchRecord } from '../../hooks/records/swarm'
import { attach, flushed, putBinding, resetForTests } from '../../hooks/swarm/state'
import type { SwarmReadReply } from '../../hooks/records/swarm'
import { SWARM_READ } from '../../hooks/swarm/tools'
import { deps as launchDeps, launchSwarm, swarmReadTool } from '../../hooks/swarm/launch'
import { deps as ownerDeps, resetOwnersForTests } from '../../hooks/swarm/owner'
import { deps as recoverDeps, resetRecoveryForTests } from '../../hooks/swarm/recover'
import { resetEndForTests } from '../../hooks/swarm/end'
import { resetForTests as resetAdmitForTests } from '../../hooks/swarm/admit'
import { fireEvery, nodePorts, scratch, scratchRepo, type TestPorts } from './support/node-ports'

/** 2026-10-03 12:00:00 UTC, so a launch id is `20261003-120000`. */
export const NOW = Date.UTC(2026, 9, 3, 12, 0, 0)

const originals = { launch: { ...launchDeps }, owner: { ...ownerDeps }, recover: { ...recoverDeps } }

/** What the stand-ins were asked. */
export type Calls = {
  validated: { spec: unknown; ctx: ValidateCtx }[]
  health: HealthInput[]
  cleanups: { swarm: string; launch: string }[]
  stopping: string[]
  adopted: number
}

export type World = {
  /** The current process's ports: `restart` replaces them. */
  p: TestPorts
  /** The primary checkout, resolved. */
  dir: string
  litterDir: string
  git: (...argv: string[]) => Promise<string>
  calls: Calls
  /** What validateSpec answers (J): edit it to refuse. */
  check: SpecCheck
  /** What checkHealth answers (J). */
  health: HealthReport
  /** P's real cleanupLaunch runs behind the recording stand-in (off by default: most specs only check it's called). */
  realCleanup: boolean
  /**
   * Another process on the same repository and machine (`$.store` is shared by
   * every session there): the module's tables reset, as a reload starts them,
   * and new ports with `sessionId`, the store copied over, the clock kept.
   * The old process's beat stops with it.
   */
  restart(sessionId: string): Promise<TestPorts>
  done(): Promise<void>
}

/** Every node kind K handles: a `new` orchestrator with spawns, a `none` one that spawns nothing, an `inherit` and an `own` worker. */
export function aSpec(name = 'alpha'): SwarmSpec {
  return {
    name,
    goal: 'Make the parser accept trailing commas, and document it.',
    nodes: [
      {
        id: 'lead-a',
        kind: 'orchestrator',
        brief: 'briefs/lead-a.md',
        task: 'Split the parser change between your workers.',
        worktree: { new: { from: 'main', branch: 'feature/alpha' } },
        spawns: { fixer: 2, scout: 1 },
        authority: { commit: true, push: 'own-branch' },
        tools: { deny: ['WebFetch'] },
        report: ['done', 'blocked'],
        model: 'sonnet',
        effort: 'high',
      },
      { id: 'docs', kind: 'orchestrator', worktree: 'none', spawnOther: false, authority: { commit: false }, maxTurns: 40 },
      {
        id: 'fixer',
        kind: 'worker',
        worktree: 'inherit',
        authority: { commit: true },
        paths: ['src/'],
        spawnOther: false,
        tools: { allow: ['Read', 'Edit', 'Bash'] },
        permissionMode: 'acceptEdits',
      },
      { id: 'scout', kind: 'worker', worktree: 'own', authority: { commit: true, rewriteHistory: false } },
    ],
  }
}

export const BRIEFS: Readonly<Record<string, string>> = { 'lead-a': 'Own the parser change in src/parser.ts.' }

/** Saves `spec` as J would: swarm.json and its briefs, and the same at `revisions/<revision>`. */
export async function saveSwarm(w: World, spec: SwarmSpec, briefs: Readonly<Record<string, string>> = BRIEFS, revision = 1): Promise<void> {
  const { p, litterDir } = w
  await atomicWriteJson(p, swarmJsonPath(litterDir, spec.name), spec)
  await atomicWriteJson(p, revisionPath(litterDir, spec.name, revision), spec)
  for (const [node, text] of Object.entries(briefs)) {
    await p.fs.write(swarmBriefPath(litterDir, spec.name, node), text)
    await p.fs.write(revisionBriefPath(litterDir, spec.name, revision, node), text)
  }
}

async function readRevisionFile(p: Ports, litterDir: string, name: string, n: number): Promise<SavedSwarm | null> {
  const spec = await readJson<SwarmSpec>(p, revisionPath(litterDir, name, n))
  if (!spec) return null
  const briefs: Record<string, string> = {}
  for (const node of spec.nodes) {
    const path = revisionBriefPath(litterDir, name, n, node.id)
    if (await p.fs.exists(path)) briefs[node.id] = await p.fs.read(path)
  }
  return { spec, revision: n, briefs }
}

/** M's nodePolicyFor, cut to what K's specs read: the binding's identity, its generation and the flags. */
export function nodePolicyOf(b: NodeBinding, flags: { admitted: boolean; stopped: string | null; bind: boolean }): NodePolicy {
  return {
    swarm: b.swarm,
    launch: b.launch,
    node: b.node,
    n: b.n,
    kind: b.kind,
    of: b.of,
    type: b.type,
    parent: b.parent,
    generation: b.generation,
    dir: b.cwd,
    paths: null,
    protect: [],
    branch: b.branch,
    authority: {},
    toolsDeny: [],
    bashDeny: [],
    spawns: [],
    spawnOther: true,
    ...flags,
  }
}

/** A node's policy file as M writes it. */
export const readNodePolicy = (w: World, agentId: string) => readJson<{ v: 1; node: NodePolicy }>(w.p, agentPolicyPath(w.litterDir, agentId))

/** policy.json's text, or null: a spec compares it byte for byte. */
export async function policyText(w: World): Promise<string | null> {
  const path = join(w.litterDir, 'hooks', 'policy.json')
  return (await w.p.fs.exists(path)) ? w.p.fs.read(path) : null
}

function install(w: World): void {
  Object.assign(launchDeps, {
    validateSpec: async (_p: unknown, spec: unknown, ctx: ValidateCtx) => {
      w.calls.validated.push({ spec, ctx })
      return structuredClone(w.check)
    },
    checkHealth: async (_p: unknown, input: HealthInput) => {
      w.calls.health.push(input)
      return structuredClone(w.health)
    },
    readSaved: async (p: Ports, litterDir: string, name: string) => {
      const dir = join(swarmDir(litterDir, name), 'revisions')
      if (!(await p.fs.exists(dir))) return null
      const ns = (await p.fs.list(dir)).map(e => /^([0-9]+)\.json$/.exec(e.name)?.[1]).filter((x): x is string => x !== undefined).map(Number)
      return ns.length === 0 ? null : readRevisionFile(p, litterDir, name, Math.max(...ns))
    },
    readRevision: readRevisionFile,
    readDraft: async (p: Ports, litterDir: string, name: string) => (await p.store.get(`litter.swarm.draft.${litterDir}.${name}`)) ?? null,
    // M's policy writers are the real ones (guard.ts): the ownership checks (Q2) live in them.
    cleanupLaunch: async (p: Ports, swarm: string, launch: string) => {
      w.calls.cleanups.push({ swarm, launch })
      if (w.realCleanup) await originals.launch.cleanupLaunch(p, swarm, launch)
    },
  } as Partial<typeof launchDeps>)
  Object.assign(recoverDeps, {
    readRevision: readRevisionFile,
    nodePolicyFor: (b: NodeBinding, _s: unknown, flags: { admitted: boolean; stopped: string | null; bind: boolean }) => nodePolicyOf(b, flags),
    writeNodePolicy: (p: Ports, litterDir: string, agentId: string, node: NodePolicy) => atomicWriteJson(p, agentPolicyPath(litterDir, agentId), { v: 1, node }),
    resumeStopping: async (_p: unknown, swarm: string) => void w.calls.stopping.push(swarm),
    adoptUnbound: async () => void w.calls.adopted++,
  } as Partial<typeof recoverDeps>)
}

function resetModules(): void {
  resetForTests()
  resetAdmitForTests()
  resetOwnersForTests()
  resetRecoveryForTests()
  resetEndForTests()
}

/** A scratch repository on `main` with `.claude/` ignored, its litter directory, and the session set for `sessionId`. */
export async function world(sessionId = 'sess-a'): Promise<World> {
  resetModules()
  const s = scratch('litter-k-')
  const dir = realpathSync(s.dir)
  const p = nodePorts({ sessionId, cwd: dir })
  p.clock.now = NOW
  const { git } = await scratchRepo(p, dir)
  await p.fs.write(join(dir, '.gitignore'), '.claude/\n')
  await git('add', '.gitignore')
  await git('commit', '-q', '-m', 'ignore')
  const litterDir = join(dir, '.claude', 'litter')
  setOptions(undefined)
  updateSession({ litterDir, litterDirError: null, toolsRefused: null, swarmToolsRefused: null, ready: true })
  attach(p, litterDir)
  const w: World = {
    p,
    dir,
    litterDir,
    git,
    calls: { validated: [], health: [], cleanups: [], stopping: [], adopted: 0 },
    check: { ok: true, errors: [], warnings: [] },
    health: { rows: [], errors: 0, warnings: 0, snippet: null },
    realCleanup: false,
    restart: async next => {
      await settle(w.p)
      const q = nodePorts({ sessionId: next, cwd: dir })
      q.clock.now = w.p.clock.now
      for (const [k, v] of w.p.storeMap) q.storeMap.set(k, structuredClone(v))
      w.p.timers.clear()
      resetModules()
      attach(q, litterDir)
      w.p = q
      return q
    },
    done: async () => {
      await settle(w.p)
      resetModules()
      Object.assign(launchDeps, originals.launch)
      Object.assign(ownerDeps, originals.owner)
      Object.assign(recoverDeps, originals.recover)
      updateSession({ litterDir: null, litterDirError: null, toolsRefused: null, swarmToolsRefused: null, ready: false })
      s.cleanup()
    },
  }
  install(w)
  return w
}

/** Saves `spec` and launches it, answering Launch. */
export async function launched(w: World, spec: SwarmSpec = aSpec()): Promise<string> {
  await saveSwarm(w, spec)
  w.p.answers.push('Launch')
  const r = await launchSwarm(w.p, spec.name)
  if (!r.ok) throw new Error(r.reason)
  // The launch's first beat, done.
  await settle(w.p)
  return r.launch
}

/** mcp__litter__swarm_read from the lead, its reply parsed. It's answered in the hook: `next` throws. */
export async function swarmRead(w: World, input: Record<string, unknown>): Promise<SwarmReadReply & Record<string, any>> {
  const e = { tool: SWARM_READ, tool_use_id: 'tu-read', ...input } as unknown as Parameters<typeof swarmReadTool>[1]
  const next = (async () => {
    throw new Error('passed on')
  }) as unknown as Parameters<typeof swarmReadTool>[2]
  const r = (await swarmReadTool(w.p, e, next)) as { result: string }
  return JSON.parse(r.result)
}

/** The oid `refs/litter-swarm/<name>` names, or null. */
export async function refOf(w: World, name = 'alpha'): Promise<string | null> {
  const r = await w.p.run(['git', '-C', w.dir, 'rev-parse', '-q', '--verify', `refs/litter-swarm/${name}`])
  return r.code === 0 ? r.stdout.trim() : null
}

export async function blobAt(w: World, oid: string): Promise<OwnerBlob> {
  return JSON.parse(await w.git('cat-file', 'blob', oid)) as OwnerBlob
}

/** Another process moves the ref to a blob of its own, compare-and-swap, as a handover or a restart does. */
export async function moveRef(w: World, blob: OwnerBlob, name = 'alpha'): Promise<string> {
  const old = (await refOf(w, name))!
  const r = await w.p.run(['git', '-C', w.dir, 'hash-object', '-w', '--stdin'], { stdin: JSON.stringify(blob) })
  const oid = r.stdout.trim()
  await w.git('update-ref', `refs/litter-swarm/${name}`, oid, old)
  return oid
}

/** A pid no process has: a shell's own, once it exited. */
export async function deadPid(w: World): Promise<string> {
  return (await w.p.run(['sh', '-c', 'echo $$'])).stdout.trim()
}

/** Lets in-flight work finish: a beat started without a wait (firing the timers awaits one in flight), and the store's mirror. */
export async function settle(p: TestPorts): Promise<void> {
  await fireEvery(p)
  await flushed()
}

/** An instance as L binds it: swarm.instance (not for a child) and swarm.node in the ledger, and the binding in state.ts. */
export async function bind(
  w: World,
  launch: string,
  b: Pick<NodeBinding, 'agentId' | 'node' | 'n' | 'kind' | 'cwd'> & Partial<Pick<NodeBinding, 'parent' | 'branch' | 'generation' | 'of' | 'revision'>>,
): Promise<NodeBinding> {
  const token = b.kind === 'child' ? null : `tok-${b.agentId}`
  const parent = b.parent ?? null
  const branch = b.branch ?? null
  const generation = b.generation ?? 1
  const revision = b.revision ?? 1
  if (token) {
    await appendLaunchRecord(w.p, w.litterDir, 'alpha', launch, 'swarm.instance', {
      node: b.node,
      n: b.n,
      parentAgentId: parent,
      tool_use_id: `tu-${b.agentId}`,
      cwd: b.cwd,
      branch,
      token,
    })
  }
  const rec = await appendLaunchRecord(w.p, w.litterDir, 'alpha', launch, 'swarm.node', {
    node: b.node,
    n: b.n,
    agentId: b.agentId,
    parentAgentId: parent,
    kind: b.kind,
    ...(b.of ? { of: b.of } : {}),
    cwd: b.cwd,
    branch,
    model: null,
    revision,
    generation,
  })
  const binding: NodeBinding = {
    agentId: b.agentId,
    swarm: 'alpha',
    launch,
    node: b.node,
    n: b.n,
    kind: b.kind,
    of: b.of ?? null,
    parent,
    type: `litter:sw-alpha-${b.node}`,
    cwd: b.cwd,
    branch,
    token,
    revision,
    generation,
    boundAt: rec.at,
    adopted: false,
  }
  putBinding(binding)
  return binding
}
