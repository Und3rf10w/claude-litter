// WP-K: how a swarm goes live (15.4, Launch's seven steps): the checks, your
// confirmation, ownership and the `new` worktrees, the node types, the bound
// branches, swarm.start; and the lead's mcp__litter__swarm_read.
//
// Three parts (2b-2, X), so the builder's Launch and a repair swarm's share
// them: planLaunch (step 1's checks and step 5's branches as you'd confirm
// them), the confirmation (the builder's ask, or a repair's own), and goLive
// (steps 3 to 6). The builder's Launch fills the prompt box after (step 7); a
// repair under `repair: auto` doesn't, since the fanout's confirmation was
// its own (repair.ts).
//
// As in run.start (plan section 9, "The order matters"), every check that can
// refuse runs before anything is written: a refusal leaves no ref, worktree,
// type, record, policy entry or `active`. After the ref is taken, a failure
// records `swarm.end { status: 'launch_failed' }`, hands the launch's
// worktrees to P's cleanup, and releases the ref.
//
// Git runs only with argv built here from validated parts (section 9, "Mod
// safety"; 15.8, "Specs are data"): every spec value that reaches git has
// passed J's validation, and comes after `--end-of-options` or as a ref this
// module spelled out.

import type { AgentSpec, AgentStatus, Ports } from '../ports'
import type { PortHook, SwarmReadHook } from '../hooktypes'
import type { SwarmEntry } from '../hookfiles'
import type { SwarmReadInstance, SwarmReadLaunch, SwarmReadOrchestrator, SwarmReadReply, SwarmStartBody } from '../records/swarm'
import type { LiveSwarm, NodeDir, RepairBudget, ReportEvent, RunLink, SavedSwarm, SwarmNode, SwarmRoots, SwarmSpec, ValidateCtx } from './types'
import type { WaitBudget } from './admit'
import { LAUNCH_ID, launchDir, NODE_ID, nodeTypeName, SWARM_NAME, swarmNewWorktreeName } from '../layout'
import { getOptions, session } from '../session'
import { remove, sha256 } from '../fsx'
import { primaryOf, repoOf } from '../lifecycle'
import { BRANCH, litterWorktreeRoot, listedAt, listWorktrees, realOf } from '../worktrees'
import { readPolicy } from '../policy'
import { appendLaunchRecord, newLaunchId, readLaunchLedger } from '../records/swarm'
import { renderSlots } from '../prompts/slots'
import {
  AUTHORITY_COMMIT_NO,
  AUTHORITY_COMMIT_YES,
  AUTHORITY_LAND_YES,
  AUTHORITY_NONE,
  AUTHORITY_PATHS,
  AUTHORITY_PUSH_ANY,
  AUTHORITY_PUSH_ANY_FORCE,
  AUTHORITY_PUSH_NONE,
  AUTHORITY_PUSH_OWN_BRANCH,
  AUTHORITY_PUSH_OWN_BRANCH_FORCE,
  AUTHORITY_REWRITE_NO,
  AUTHORITY_REWRITE_YES,
  AUTHORITY_VERDICTS_YES,
  AUTHORITY_VERIFY_YES,
  AUTHORITY_WORKTREE_OPS_NO,
  AUTHORITY_WORKTREE_OPS_YES,
  DELEGATION_NO_OTHER,
  DELEGATION_NONE,
  DELEGATION_SPAWN_ITEM,
  DELEGATION_SPAWNS,
  REPORT_EVENT_PHRASES,
  REPORT_EVENTS_UNSET,
  REPORT_HOW_COMMON,
  REPORT_HOW_ORCHESTRATOR,
  REPORT_HOW_WORKER,
  SWARM_NODE,
} from '../prompts/swarm-node'
import {
  bindings,
  dropLiveSwarm,
  isStopped,
  lastReport,
  liveSwarm,
  liveSwarms,
  openQuestions,
  putLiveSwarm,
  queued,
  ready,
  reservations,
  status,
} from './state'
import { decodeSwarmInput, SWARM_READ } from './tools'
import { addSwarmWorktree } from './worktrees'
import { acquireOwnership, readOwnerRef, releaseOwnership, startOwnerBeat, stopOwnerBeat } from './owner'
import { authorityLines, continuationText, readLaunchFacts, refreshReadOnly, resumeTargets, settleStuck } from './recover'
import { activeRunsRepair, validateSpec } from './spec'
import { checkHealth } from './doctor'
import { readDraft, readRevision, readSaved } from './store'
import { heldBy, writeSwarmPolicy } from './guard'
import { cleanupLaunch, worktreesLeft } from './end'
import { measureSpend } from '../stats/spend'
import { waitBudget } from './admit'

/**
 * The other packages' functions this module calls, through one table so tier
 * 2 can stand in for them: in K's worktree their bodies are stubs (COMMON,
 * "Another package's module"). The mod never changes it.
 */
export const deps = {
  validateSpec: (...a: Parameters<typeof validateSpec>) => validateSpec(...a),
  checkHealth: (...a: Parameters<typeof checkHealth>) => checkHealth(...a),
  readSaved: (...a: Parameters<typeof readSaved>) => readSaved(...a),
  readRevision: (...a: Parameters<typeof readRevision>) => readRevision(...a),
  readDraft: (...a: Parameters<typeof readDraft>) => readDraft(...a),
  writeSwarmPolicy: (...a: Parameters<typeof writeSwarmPolicy>) => writeSwarmPolicy(...a),
  cleanupLaunch: (...a: Parameters<typeof cleanupLaunch>) => cleanupLaunch(...a),
}

/** Launch's answer: the new launch's id, or why it refused (N shows it). */
export type LaunchResult = { ok: true; launch: string } | { ok: false; reason: string }

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const RECORD_TOOL = 'mcp__litter__record'
/** The rule folders under a checkout (plan 16.1), as lifecycle.ts's policyFor names them. */
const RULE_DIRS = ['.litter', '.litter.local', '.claude/rules/litter', '.claude/rules/litter-local'] as const

/** sha256 of the spec's JSON: swarm.start's `specHash`, which recovery checks a spec against. */
export const specHash = (spec: SwarmSpec): Promise<string> => sha256(JSON.stringify(spec))

/** The type as the engine serves it. */
const servedType = (swarm: string, node: string) => `litter:${nodeTypeName(swarm, node)}`
const short = (ref: string) => ref.replace(/^refs\/heads\//, '')
/** Spec text on one line: a value can't start a line of its own in the ask or the prompt box. */
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
const worktreeOf = (n: SwarmNode) => n.worktree ?? 'inherit'
const spawnsOf = (n: SwarmNode): [string, number][] => Object.entries(n.spawns ?? {})

// ---------------------------------------------------------------------------
// The node types (step 4)

/** Lines of `{authority}`: one per field that's set, in litter-prompts.md's order. */
function authoritySlot(n: SwarmNode): string {
  const a = n.authority ?? {}
  const lines: string[] = []
  if (a.commit !== undefined) lines.push(a.commit ? AUTHORITY_COMMIT_YES : AUTHORITY_COMMIT_NO)
  if (a.push === 'own-branch') lines.push(a.forcePush ? AUTHORITY_PUSH_OWN_BRANCH_FORCE : AUTHORITY_PUSH_OWN_BRANCH)
  else if (a.push === 'any') lines.push(a.forcePush ? AUTHORITY_PUSH_ANY_FORCE : AUTHORITY_PUSH_ANY)
  else if (a.push === 'none') lines.push(AUTHORITY_PUSH_NONE)
  if (a.rewriteHistory !== undefined) lines.push(a.rewriteHistory ? AUTHORITY_REWRITE_YES : AUTHORITY_REWRITE_NO)
  if (a.worktreeOps !== undefined) lines.push(a.worktreeOps ? AUTHORITY_WORKTREE_OPS_YES : AUTHORITY_WORKTREE_OPS_NO)
  // 2b-2's grants (15.10): a line only when given, since unset and false both mean not given.
  if (a.verify === true) lines.push(AUTHORITY_VERIFY_YES)
  if (n.verdicts === true) lines.push(AUTHORITY_VERDICTS_YES)
  if (a.land === true) lines.push(AUTHORITY_LAND_YES)
  if (n.paths && n.paths.length > 0) lines.push(renderSlots(AUTHORITY_PATHS, { paths: n.paths.join(', ') }))
  return lines.length === 0 ? AUTHORITY_NONE : lines.join('\n')
}

function delegationSlot(spec: SwarmSpec, n: SwarmNode): string {
  const spawns = spawnsOf(n)
  const list = spawns.map(([w, count]) => renderSlots(DELEGATION_SPAWN_ITEM, { type: servedType(spec.name, w), node: w, n: count })).join('; ')
  const text = spawns.length > 0 ? renderSlots(DELEGATION_SPAWNS, { spawn_list: list }) : DELEGATION_NONE
  return n.spawnOther === false ? `${text} ${DELEGATION_NO_OTHER}` : text
}

/** `{report_events}`: the chosen events in words, in the slot table's order. */
function reportEventsSlot(n: SwarmNode): string {
  const chosen = (Object.keys(REPORT_EVENT_PHRASES) as ReportEvent[]).filter(k => n.report?.includes(k))
  const words = chosen.map(k => REPORT_EVENT_PHRASES[k])
  if (words.length === 0) return REPORT_EVENTS_UNSET
  return words.length === 1 ? words[0]! : `${words.slice(0, -1).join(', ')}, or ${words.at(-1)!}`
}

/**
 * A node's type for `p.registerAgent`, the same for every instance: the node
 * prompt with its slots filled (prompts/swarm-node.ts), tools, model, effort,
 * maxTurns, permissionMode, `background: true`. No per-instance value.
 * C's choice: `ctx.brief` is the node's brief text at the spec's revision
 * (null when it has none), read by the caller, so this stays synchronous.
 */
export function nodeTypeSpec(spec: SwarmSpec, node: string, ctx: { brief: string | null }): AgentSpec {
  const n = spec.nodes.find(x => x.id === node)
  if (!n) throw new Error(`litter: node ${node} isn't in swarm ${spec.name}`)
  const prompt = renderSlots(SWARM_NODE, {
    node: n.id,
    goal: spec.goal,
    brief: ctx.brief,
    authority: authoritySlot(n),
    delegation: delegationSlot(spec, n),
    report_how: `${REPORT_HOW_COMMON} ${n.kind === 'orchestrator' ? REPORT_HOW_ORCHESTRATOR : REPORT_HOW_WORKER}`,
    report_events: reportEventsSlot(n),
  })
  const parents = spec.nodes.filter(x => x.spawns && Object.hasOwn(x.spawns, n.id)).map(x => x.id)
  const description =
    n.kind === 'orchestrator'
      ? `litter swarm ${spec.name}: the ${n.id} orchestrator. Spawned by the litter swarm skill once you launch the swarm; don't spawn it otherwise.`
      : `litter swarm ${spec.name}: the ${n.id} worker. Spawned only by ${parents.length > 0 ? parents.join(', ') : 'its parent nodes'}, within their spawns.`
  const out: AgentSpec = { name: nodeTypeName(spec.name, n.id), description, prompt, background: true }
  // A node with an allow list still needs the record tool: swarm.bind is how it gets its binding back after a reload.
  const allow = n.tools?.allow ?? []
  if (allow.length > 0) out.tools = [...new Set([...allow, RECORD_TOOL])]
  const spawnsNothing = spawnsOf(n).length === 0 && n.spawnOther === false
  const deny = [...new Set([...(n.tools?.deny ?? []), ...(spawnsNothing ? ['Agent'] : [])])]
  if (deny.length > 0) out.disallowedTools = deny
  if (n.model !== undefined) out.model = n.model
  if (n.effort !== undefined) out.effort = n.effort
  if (n.maxTurns !== undefined) out.maxTurns = n.maxTurns
  if (n.permissionMode !== undefined) out.permissionMode = n.permissionMode
  return out
}

// ---------------------------------------------------------------------------
// The authority, as you confirm it and as the prompt box carries it

/** The nodes that commit in `id`'s directory: itself with `commit`, and each `inherit` worker below it, through inherit chains. */
function committersIn(spec: SwarmSpec, id: string, seen = new Set<string>()): string[] {
  if (seen.has(id)) return []
  seen.add(id)
  const n = spec.nodes.find(x => x.id === id)
  if (!n) return []
  const out = n.authority?.commit === true ? [id] : []
  for (const [w] of spawnsOf(n)) {
    const child = spec.nodes.find(x => x.id === w)
    if (child && worktreeOf(child) === 'inherit') out.push(...committersIn(spec, w, seen))
  }
  return out
}

/** Where a node's instances work, in words. */
function whereText(name: string, n: SwarmNode, dirs: Readonly<Record<string, NodeDir>>): string {
  const w = worktreeOf(n)
  const d = dirs[n.id]
  if (d) return d.created ? `${d.dir} (a new worktree)` : d.dir
  if (w === 'own') return `its own worktree per instance, on ${swarmOwnBranchText(name, n.id)}`
  return "its parent's directory"
}

const swarmOwnBranchText = (swarm: string, node: string) => `sw/${swarm}/${node}-<n>`

/** The branch a committing node is bound to, in words. */
function branchText(name: string, n: SwarmNode, dirs: Readonly<Record<string, NodeDir>>): string {
  const d = dirs[n.id]
  if (d?.branch) return short(d.branch)
  if (worktreeOf(n) === 'own') return swarmOwnBranchText(name, n.id)
  return "its parent's branch"
}

/** One node's authority on one line: what the prompt box carries, and what swarm.start records. */
function authorityLine(name: string, n: SwarmNode, dirs: Readonly<Record<string, NodeDir>>): string {
  const a = n.authority ?? {}
  const yes = (v: boolean | undefined) => (v === undefined ? 'unchecked' : v ? 'yes' : 'no')
  const force = a.forcePush ? 'with --force-with-lease when it must' : 'without force'
  const push =
    a.push === undefined
      ? 'push unchecked'
      : a.push === 'none'
        ? 'push: the lead pushes nothing for it'
        : a.push === 'own-branch'
          ? `push: the lead may push its own branch only (${branchText(name, n, dirs)}), ${force}`
          : `push: the lead may push its work to the branch it names, ${force}`
  const commit = a.commit === true ? `commit yes, on ${branchText(name, n, dirs)}` : `commit ${yes(a.commit)}`
  const paths = n.paths && n.paths.length > 0 ? `files only under ${n.paths.map(oneLine).join(', ')}` : 'files anywhere'
  // 2b-2's grants, only when given (a builder swarm has none: Launch refuses them).
  const grants = [
    a.verify === true ? "verify yes (the mod runs the run's verify)" : null,
    n.verdicts === true ? 'verdicts yes (the veto a land needs)' : null,
    a.land === true ? 'land yes (the mod lands only a verified, approved tree)' : null,
  ].filter((x): x is string => x !== null)
  return `${n.id}: ${commit}; ${push}; rewrite history ${yes(a.rewriteHistory)}; worktree commands ${yes(a.worktreeOps)}; ${paths}${grants.map(g => `; ${g}`).join('')}`
}

/** What litter leaves unchecked for a node: the classifier, your permission rules and your hooks still apply. */
function uncheckedOf(n: SwarmNode): string[] {
  const a = n.authority ?? {}
  const out: string[] = []
  if (a.commit === undefined) out.push('commit')
  if (a.push === undefined) out.push('push')
  if (a.rewriteHistory === undefined) out.push('rewriteHistory')
  if (a.worktreeOps === undefined) out.push('worktreeOps')
  if (!n.paths || n.paths.length === 0) out.push('paths')
  if (!n.tools?.allow && !n.tools?.deny) out.push('tools')
  return out
}

type NewWorktree = { node: string; path: string; branch: string; from: string }

/**
 * Step 2's question: `head` first (the builder's "Launch swarm …?", or a
 * repair's own with its run and budget), then each node with where it works
 * and its authority, the worktrees it creates, the warnings, and the new types.
 */
export function launchQuestion(plan: LaunchPlan, head: readonly string[]): string {
  const { dirs, authority, made, warnings, types } = plan
  const spec = plan.saved.spec
  const setup = getOptions().setup
  const lines: string[] = [...head, '', 'Each node, where it works, and its authority:']
  for (const n of spec.nodes) {
    lines.push(`- ${n.id} (${n.kind}), in ${whereText(spec.name, n, dirs)}`)
    lines.push(`  ${authority[n.id]!.slice(n.id.length + 2)}`)
    const deny = n.tools?.deny ?? []
    const allow = n.tools?.allow ?? []
    const extra = [
      allow.length > 0 ? `tools only ${allow.map(oneLine).join(', ')}` : null,
      deny.length > 0 ? `tools denied ${deny.map(oneLine).join(', ')}` : null,
      (n.bash?.deny ?? []).length > 0 ? `Bash denied ${n.bash!.deny!.map(oneLine).join(', ')}` : null,
      spawnsOf(n).length > 0 ? `spawns ${spawnsOf(n).map(([w, c]) => `${w} up to ${c}`).join(', ')}` : 'spawns no swarm agents',
      n.spawnOther === false ? 'no other agent types' : null,
    ].filter((x): x is string => x !== null)
    lines.push(`  ${extra.join('; ')}`)
    const unchecked = uncheckedOf(n)
    if (unchecked.length > 0) lines.push(`  Unchecked by litter: ${unchecked.join(', ')}`)
  }
  lines.push('', made.length === 0 ? 'It creates no worktree.' : 'The worktrees it creates:')
  for (const w of made) lines.push(`- ${w.path}, on a new branch ${w.branch} from ${oneLine(w.from)}${setup ? `, set up with ${setup.join(' ')}` : ''}`)
  if (warnings.length > 0) {
    lines.push('', 'Warnings:')
    for (const w of warnings) lines.push(`- ${oneLine(w)}`)
  }
  lines.push('', `New agent types: ${Object.values(types).join(', ')}`)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// Launch

type Refused = { ok: false; reason: string }
const refused = (name: string, problems: readonly string[]): Refused => ({
  ok: false,
  reason: problems.length === 1 ? `litter: can't launch swarm ${name}: ${problems[0]}` : `litter: can't launch swarm ${name}:\n${problems.map(x => `- ${x}`).join('\n')}`,
})

async function hasJq(p: Ports): Promise<boolean> {
  try {
    return (await p.run(['jq', '--version'])).code === 0
  } catch {
    return false
  }
}

async function gitOut(p: Ports, cwd: string, argv: readonly string[]): Promise<{ code: number; out: string }> {
  try {
    const r = await p.run(['git', '-C', cwd, ...argv])
    return { code: r.code, out: r.stdout.trim() }
  } catch {
    return { code: -1, out: '' }
  }
}

/** The branch checked out in `dir`, as a full ref; null on a detached HEAD or when git can't tell. */
async function boundBranch(p: Ports, dir: string): Promise<string | null> {
  const r = await gitOut(p, dir, ['symbolic-ref', '-q', 'HEAD'])
  return r.code === 0 && r.out.startsWith('refs/heads/') ? r.out : null
}

async function toplevel(p: Ports, dir: string): Promise<string | null> {
  const r = await gitOut(p, dir, ['rev-parse', '--show-toplevel'])
  return r.code === 0 && r.out !== '' ? realOf(p, r.out) : null
}

/** Every local branch's tip: `refs/heads/<name>` → oid. */
async function branchTips(p: Ports, repo: string): Promise<Record<string, string> | null> {
  const r = await gitOut(p, repo, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads'])
  if (r.code !== 0) return null
  const tips: Record<string, string> = {}
  for (const line of r.out.split('\n')) {
    const [ref, oid] = line.split('\0')
    if (ref && oid) tips[ref] = oid
  }
  return tips
}

/** As lifecycle.ts's policyFor computes a run's: every `.claude/litter/` copy and the rule folders, under each checkout the swarm works in. */
async function rootsOf(p: Ports, litterDir: string, dirs: readonly string[]): Promise<SwarmRoots> {
  const litter = await realOf(p, litterDir)
  const primary = primaryOf(litterDir)
  const tops = new Set<string>()
  if (primary) tops.add(await realOf(p, primary))
  for (const d of dirs) {
    const t = await toplevel(p, d)
    if (t) tops.add(t)
  }
  return {
    litterDir: litter,
    litterCopies: [...new Set([litter, ...[...tops].map(t => `${t}/.claude/litter`)])],
    ruleDirs: [...tops].flatMap(t => RULE_DIRS.map(r => `${t}/${r}`)),
  }
}

/** Launches in this process waiting for their ask: a second press is refused rather than queued behind it. */
const launching = new Set<string>()

/**
 * The types other live swarms serve, type → swarm (Launch refuses a type
 * another live swarm has). A swarm that would collide is read again first
 * (Q5): another session's copy from its ref and ledger, and a policy.json
 * entry counts only while its ref names its launch and that launch hasn't
 * ended, so a leftover entry, or a copy whose owner ended it, takes nothing.
 */
async function takenTypes(
  p: Ports,
  litterDir: string,
  name: string,
  entries: Readonly<Record<string, SwarmEntry>>,
  ours: ReadonlySet<string>,
): Promise<Map<string, string>> {
  const collides = (ts: readonly string[]) => ts.some(t => ours.has(t))
  const copies = liveSwarms().filter(s => s.name !== name && s.readOnly && collides(Object.values(s.types)))
  if (copies.length > 0) await refreshReadOnly(p, litterDir, copies.map(s => s.name))
  const taken = new Map<string, string>()
  for (const s of liveSwarms()) if (s.name !== name) for (const t of Object.values(s.types)) taken.set(t, s.name)
  for (const [other, entry] of Object.entries(entries)) {
    const ts = Array.isArray(entry?.nodeTypes) ? entry.nodeTypes : []
    if (other === name || !collides(ts)) continue
    if (!liveSwarm(other) && !(await entryLive(p, litterDir, other, entry))) continue
    for (const t of ts) taken.set(t, other)
  }
  return taken
}

/** A policy.json entry's launch is live: its ref names it, with swarm.start and no swarm.end. Git failing counts as live. */
async function entryLive(p: Ports, litterDir: string, name: string, entry: SwarmEntry): Promise<boolean> {
  const ref = await readOwnerRef(p, litterDir, name)
  if (ref === undefined) return true
  if (!ref?.blob || ref.blob.launch !== entry.launch || !LAUNCH_ID.test(entry.launch)) return false
  const facts = await readLaunchFacts(p, litterDir, name, entry.launch)
  return facts.start !== null && !facts.ended
}

/**
 * A launch that failed after its ref was taken, or whose session ended before
 * `swarm.start` (recover.ts, settleStuck): End's order (end.ts; Q6), so
 * swarm.end and summary.md say what's left. The cleanup of the worktrees it
 * made first, then `swarm.end { status: 'launch_failed' }` with the worktrees
 * and branches left (a `new` branch is never deleted), unless the ledger has a
 * swarm.end already, then the release: this process's ownership, or a stuck
 * ref's compare-and-delete. Each step's failure is logged, and the next runs:
 * a ledger that can't take swarm.end still lets the name go.
 */
export async function endFailedLaunch(
  p: Ports,
  litterDir: string,
  name: string,
  launch: string,
  reason: string,
  release: () => Promise<unknown>,
): Promise<void> {
  try {
    await deps.cleanupLaunch(p, name, launch)
  } catch (err) {
    p.log(`swarm ${name}: the failed launch's cleanup failed: ${errText(err)}`)
  }
  try {
    const { records, tampered } = await readLaunchLedger(p, litterDir, name, launch)
    if (tampered) throw new Error(`launch ${launch}'s ledger is tampered at record ${tampered.seq}`)
    if (!records.some(r => r.kind === 'swarm.end')) {
      const worktrees = await worktreesLeft(p, records, launch, null)
      const repo = repoOf(litterDir)
      const branches: string[] = []
      for (const b of [...new Set(worktrees.map(w => w.branch))].sort()) {
        if (BRANCH.test(b) && (await gitOut(p, repo, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`])).code === 0) branches.push(b)
      }
      await appendLaunchRecord(p, litterDir, name, launch, 'swarm.end', { status: 'launch_failed', settled: true, reason, nodes: {}, worktrees, branches })
    }
  } catch (err) {
    p.log(`swarm ${name}: launch_failed wasn't recorded: ${errText(err)}`)
  }
  await release().catch((err: unknown) => p.log(`swarm ${name}: its ref wasn't released: ${errText(err)}`))
}

/**
 * Marks a launch of `name` under way in this process: the release, or null
 * when one is already (a second press, or a repair racing it, is refused
 * rather than queued behind it). The caller releases it when it's done.
 */
export function beginLaunch(name: string): (() => void) | null {
  if (launching.has(name)) return null
  launching.add(name)
  return () => void launching.delete(name)
}

/**
 * Launches swarm `name` at its saved revision, or `opts.revision`, from the
 * builder: the checks, your confirmation, going live, then the prompt box.
 * Every refusing check runs before anything is written. Reads `session().litterDir`.
 */
export async function launchSwarm(p: Ports, name: string, opts?: { revision?: number }): Promise<LaunchResult> {
  if (typeof name !== 'string' || !SWARM_NAME.test(name)) return { ok: false, reason: `litter: '${String(name)}' isn't a swarm name` }
  const done = beginLaunch(name)
  if (!done) return refused(name, ['a launch of it is already waiting for your confirmation'])
  try {
    return await launch(p, name, opts ?? {})
  } catch (err) {
    return refused(name, [errText(err)])
  } finally {
    done()
  }
}

async function launch(p: Ports, name: string, opts: { revision?: number }): Promise<LaunchResult> {
  // Step 1. The builder's swarms get no verify or land (2b-2, decision 4).
  const planned = await planLaunch(p, name, { ...opts, grants: false })
  if (!planned.ok) return planned
  const { plan } = planned
  const spec = plan.saved.spec

  // Step 2: your confirmation. The authority lines are the ones swarm.start records and the prompt box carries.
  const question = launchQuestion(plan, [`Launch swarm ${spec.name} (revision ${plan.saved.revision})?`, `Goal: ${oneLine(spec.goal).slice(0, 300)}`])
  // The ask is an AskUserQuestion call (2.1.288), which a permission refusal fails; the health check above refuses dontAsk, the usual one.
  let askFailed: string | null = null
  const answer = await p.ask(question, { options: ['Launch', 'Cancel'], header: `Launch ${name}` }).catch((err: unknown) => {
    askFailed = errText(err)
    return null
  })
  if (askFailed !== null) {
    const why: string = askFailed
    return refused(name, [`Launch needs your confirmation, and the ask couldn't be shown: ${why.length > 160 ? `${why.slice(0, 159)}…` : why}`])
  }
  if (answer !== 'Launch') return refused(name, ['Launch needs your confirmation'])

  // Steps 3 to 6, then step 7: the start line and the authority in your prompt box, so the launch is your own message.
  const live = await goLive(p, plan, { confirmedBy: { ask: true } })
  if (live.ok) await fillStart(p, plan)
  return live
}

/**
 * What Launch's checks found (step 1, and step 5's branches as you'd confirm
 * them): everything going live needs, with nothing written yet.
 */
export type LaunchPlan = {
  name: string
  litterDir: string
  /** The spec and briefs launched, at their revision (a repair's own, in memory, until it's saved). */
  saved: SavedSwarm
  types: Record<string, string>
  dirs: Record<string, NodeDir>
  made: NewWorktree[]
  /** The validation's and the health check's warnings, for the ask. */
  warnings: string[]
  /** Node id → the authority line you confirm, swarm.start records and the prompt box carries. */
  authority: Record<string, string>
  repo: string
  root: string
  sessionCwd: string
  commonDir: string
}

/**
 * Step 1, every check that can refuse, and the directories and bound
 * branches as you'd confirm them: of `opts.saved` when given (a repair's
 * generated spec, before it's saved), else the saved revision or
 * `opts.revision`. `grants: false` refuses any `verify` or `land` authority
 * (the builder's swarms, in 2b-2). `forRun` (phase 3, decision 10) is the run
 * a repair bridge launches for: its own repair swarm may work in the active
 * run's checkout when that run is `forRun` and its open generation's
 * run.repair names this swarm. Writes nothing.
 */
export async function planLaunch(
  p: Ports,
  name: string,
  opts: { revision?: number; saved?: SavedSwarm; grants: boolean; forRun?: string },
): Promise<{ ok: true; plan: LaunchPlan } | Refused> {
  if (typeof name !== 'string' || !SWARM_NAME.test(name)) return { ok: false, reason: `litter: '${String(name)}' isn't a swarm name` }
  const info = session()
  const litterDir = info.litterDir
  if (!litterDir) {
    return refused(name, [`this session has no litter directory (${info.litterDirError ?? "session.start hasn't resolved it"}); open a session in the repository's checkout once`])
  }
  if (info.toolsRefused) return refused(name, [`litter's tools were refused (${info.toolsRefused}), and a swarm runs unguarded without them`])
  if (info.swarmToolsRefused) return refused(name, [`the swarm tools were refused (${info.swarmToolsRefused})`])
  if (!(await hasJq(p))) return refused(name, ["jq isn't on PATH, and every litter command hook needs it; install jq, then launch again"])
  // Another session's copy is read again first: one its owner has ended since doesn't refuse (Q5).
  if (liveSwarm(name)?.readOnly) await refreshReadOnly(p, litterDir, [name])
  const live = liveSwarm(name)
  if (live) {
    return refused(name, [live.readOnly ? `it's live, owned by session ${live.owner.session}` : `it's already live (launch ${live.launch})`])
  }
  // A ref a crash left (its launch ended, or never started) whose holder is this session or gone is finished first (Q1).
  const stuck = await settleStuck(p, litterDir, name)
  const holder = await readOwnerRef(p, litterDir, name)
  if (holder) {
    const who = holder.blob ? `session ${holder.blob.session} (launch ${holder.blob.launch})` : `an unreadable blob (${holder.oid})`
    return refused(name, [
      stuck.left
        ? `refs/litter-swarm/${name} exists: ${stuck.left}; launch again once that session has closed`
        : `refs/litter-swarm/${name} exists: it's owned by ${who}; end it there, or take it over from /litter swarms ${name}`,
    ])
  }
  // An entry of its own name with no ref is a leftover no one owns: this launch's entry replaces it.
  const policy = await readPolicy(p, litterDir).catch(() => undefined)

  const saved =
    opts.saved ?? (opts.revision !== undefined ? await deps.readRevision(p, litterDir, name, opts.revision) : await deps.readSaved(p, litterDir, name))
  if (!saved) return refused(name, [opts.revision !== undefined ? `revision ${opts.revision} doesn't exist` : "it has never been saved; save it in the builder first"])
  const spec = saved.spec
  if (spec.name !== name) return refused(name, [`its spec names swarm '${spec.name}'`])

  const problems: string[] = []
  // 2b-2 (decision 4): a node's verify and land are a repair swarm's alone, bound to the run it repairs.
  if (!opts.grants) {
    for (const n of spec.nodes ?? []) {
      for (const f of ['verify', 'land'] as const) {
        if (n.authority?.[f] === true) problems.push(`nodes.${n.id}.authority.${f}: only a repair swarm a run starts may verify or land, in this version; unset it`)
      }
    }
  }
  const types = Object.fromEntries(spec.nodes.map(n => [n.id, servedType(name, n.id)]))
  const ours = new Set(Object.values(types))
  const taken = await takenTypes(p, litterDir, name, policy?.swarm?.swarms ?? {}, ours)
  for (const t of ours) if (taken.has(t)) problems.push(`its type ${t} is live swarm ${taken.get(t)}'s too; rename the node, or end ${taken.get(t)} first`)

  const repo = repoOf(litterDir)
  const runCheckout = policy?.run?.checkout ?? null
  const ctx: ValidateCtx = {
    repo,
    litterDir,
    limits: await p.limits(),
    briefText: async node => saved.briefs[node] ?? null,
    activeRunCheckout: runCheckout,
  }
  const check = await deps.validateSpec(p, spec, ctx)
  for (const e of check.errors) problems.push(`${e.field}: ${e.error}`)
  const health = await deps.checkHealth(p, { spec, litterDir })
  for (const row of health.rows) if (row.severity === 'error') problems.push(`${row.title}: ${row.detail}`)
  const warnings = [
    ...check.warnings.map(w => `${w.field}: ${w.error}`),
    ...health.rows.filter(r => r.severity === 'warning').map(r => `${r.title}: ${r.detail}`),
  ]
  // A spec that failed validation isn't read any further.
  if (problems.length > 0) return refused(name, problems)

  // The directories each node works in, as Launch will bind them.
  const sessionCwd = await realOf(p, await p.cwd())
  const root = await litterWorktreeRoot(p, litterDir)
  const worktrees = await listWorktrees(p, repo)
  const dirs: Record<string, NodeDir> = {}
  const made: NewWorktree[] = []
  for (const n of spec.nodes) {
    const w = worktreeOf(n)
    if (w === 'none' || (w === 'inherit' && n.kind === 'orchestrator')) {
      // An orchestrator's parent is the lead, so `inherit` is the session's directory too.
      dirs[n.id] = { dir: sessionCwd, branch: null, created: false }
    } else if (typeof w === 'object' && 'existing' in w) {
      // Relative to the primary checkout, the one every session of the repository shares.
      const abs = w.existing.startsWith('/') ? w.existing : `${repo}/${w.existing}`
      const at = worktrees ? await listedAt(p, worktrees, abs) : undefined
      if (!at) problems.push(`nodes.${n.id}.worktree.existing: ${oneLine(w.existing)} isn't a worktree of this repository (git worktree list)`)
      else dirs[n.id] = { dir: await realOf(p, at.path), branch: null, created: false }
    } else if (typeof w === 'object' && 'new' in w) {
      const path = `${root}/${swarmNewWorktreeName(name, n.id)}`
      const { from, branch } = w.new
      if (await p.fs.exists(path)) problems.push(`nodes.${n.id}.worktree.new: ${path} already exists (a worktree an earlier launch kept?); remove it, or use it as existing`)
      if (!BRANCH.test(branch)) problems.push(`nodes.${n.id}.worktree.new.branch: '${oneLine(branch)}' isn't a branch name litter makes`)
      else if ((await gitOut(p, repo, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])).code === 0) {
        problems.push(`nodes.${n.id}.worktree.new.branch: ${branch} already exists; name a new branch, or use its worktree as existing`)
      }
      if ((await gitOut(p, repo, ['rev-parse', '--verify', '--end-of-options', `${from}^{commit}`])).code !== 0) {
        problems.push(`nodes.${n.id}.worktree.new.from: '${oneLine(from)}' doesn't name a commit`)
      }
      dirs[n.id] = { dir: path, branch: null, created: true }
      made.push({ node: n.id, path, branch, from })
    }
    // `inherit` workers and `own` instances get their directory at spawn (L).
  }
  // A committing node, or an inherit worker committing below it, needs a branch in that directory (step 5).
  // It's the branch you confirm: a `new` worktree's own, or the one checked out now.
  for (const [id, d] of Object.entries(dirs)) {
    const who = committersIn(spec, id)
    if (who.length === 0) continue
    const mk = made.find(m => m.node === id)
    const ref = mk ? `refs/heads/${mk.branch}` : await boundBranch(p, d.dir)
    if (ref) d.branch = ref
    else problems.push(`nodes.${id}: ${d.dir} is on a detached HEAD, so ${who.join(' and ')} can't commit there; check out a branch first`)
  }
  // 15.4, "Coexisting with runs": no node works in the active run's checkout, but the run's own repair swarm (decision 10).
  const ownRepair =
    runCheckout !== null &&
    opts.grants &&
    opts.forRun !== undefined &&
    policy?.run?.run === opts.forRun &&
    (await activeRunsRepair(p, litterDir, runCheckout, name))
  if (runCheckout && !ownRepair) {
    const co = await realOf(p, runCheckout)
    for (const [id, d] of Object.entries(dirs)) {
      if (!d.created && (await toplevel(p, d.dir)) === co) problems.push(`nodes.${id}: it would work in ${co}, the active litter run's checkout; give it a worktree of its own, or wait for the run to end`)
    }
  }
  const commonOut = await gitOut(p, repo, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  if (commonOut.code !== 0 || commonOut.out === '') problems.push(`git can't name the repository's common directory from ${repo}`)
  if (problems.length > 0) return refused(name, problems)
  const commonDir = await realOf(p, commonOut.out)
  const authority = Object.fromEntries(spec.nodes.map(n => [n.id, authorityLine(name, n, dirs)]))
  return { ok: true, plan: { name, litterDir, saved, types, dirs, made, warnings, authority, repo, root, sessionCwd, commonDir } }
}

/**
 * What going live records beside the plan. A repair swarm (2b-2, X) carries
 * its run and budget, and `launch` when its id was taken first (the run's
 * `run.repair` names it). `confirmedBy` says whose message the authority
 * comes from: your answer to an ask, or the run's own launch confirmation.
 */
export type GoLive = { launch?: string; run?: RunLink; budget?: RepairBudget; confirmedBy: { run: string } | { ask: true } }

/**
 * Steps 3 to 6 of a plan you confirmed (or a repair's run confirmed):
 * ownership and the `new` worktrees, every type, the bound branches as
 * confirmed, swarm.start, the LiveSwarm and the policy entry. A failure after
 * the ref ends the launch as launch_failed and releases the ref.
 */
export async function goLive(p: Ports, plan: LaunchPlan, live: GoLive): Promise<LaunchResult> {
  const { name, litterDir, saved, types, dirs, made, authority, repo, root, sessionCwd, commonDir } = plan
  const spec = saved.spec
  const options = getOptions()

  // Step 3: ownership, then the `new` worktrees. From here a failure ends the launch as launch_failed.
  const launchId = live.launch ?? (await newLaunchId(p, litterDir, name))
  let own: Awaited<ReturnType<typeof acquireOwnership>>
  try {
    own = await acquireOwnership(p, litterDir, name, launchId)
  } catch (err) {
    // Lost the race for the ref: the launch folder is empty, and goes with the refusal.
    await remove(p, launchDir(litterDir, name, launchId)).catch(() => {})
    return refused(name, [errText(err)])
  }
  startOwnerBeat(p, litterDir, name)
  let isLive = false
  const failed = async (reason: string): Promise<LaunchResult> => {
    stopOwnerBeat(name)
    if (isLive) {
      dropLiveSwarm(name)
      const mine = heldBy({ launch: launchId, generation: own.generation, oids: [own.oid] })
      await deps.writeSwarmPolicy(p, litterDir, name, null, mine).catch((err: unknown) => p.log(`swarm ${name}: its policy entry wasn't removed: ${errText(err)}`))
    }
    await endFailedLaunch(p, litterDir, name, launchId, reason, () => releaseOwnership(p, litterDir, name))
    return refused(name, [`the launch failed: ${reason}`])
  }

  try {
    for (const w of made) {
      const r = await addSwarmWorktree(p, litterDir, options, {
        swarm: name,
        launch: launchId,
        node: w.node,
        path: w.path,
        branch: w.branch,
        from: w.from,
        repo,
        setup: options.setup ? [...options.setup] : null,
        linkDirs: [...options.linkDirs],
      })
      if (!r.ok) return await failed(r.reason)
      dirs[w.node] = { ...dirs[w.node]!, dir: r.path }
    }

    // Step 4: every node's type, workers included, before anything spawns (spike 3).
    const results = await Promise.allSettled(spec.nodes.map(async n => p.registerAgent(nodeTypeSpec(spec, n.id, { brief: saved.briefs[n.id] ?? null }))))
    const typeFailures = results.flatMap((r, i) => (r.status === 'rejected' ? [`${spec.nodes[i]!.id}: ${errText(r.reason)}`] : []))
    if (typeFailures.length > 0) return await failed(`the engine refused the types of ${typeFailures.join('; ')}`)

    // Step 5: the bound branches, as you confirmed them, then every local branch's tip.
    for (const [id, d] of Object.entries(dirs)) {
      if (!d.branch) continue
      const ref = await boundBranch(p, d.dir)
      if (ref !== d.branch) {
        return await failed(`${d.dir}, where ${committersIn(spec, id).join(' and ')} commit, is on ${ref ? short(ref) : 'a detached HEAD'} now, not ${short(d.branch)} as you confirmed`)
      }
    }
    const tips = await branchTips(p, repo)
    if (!tips) return await failed("git couldn't list the branches")

    // Step 6: live. The ref first: a launch that lost it writes nothing more.
    const still = await readOwnerRef(p, litterDir, name)
    if (still?.oid !== own.oid) return await failed(`refs/litter-swarm/${name} changed during the launch`)
    const sessionId = await p.sessionId()
    const body: SwarmStartBody = {
      swarm: name,
      launch: launchId,
      revision: saved.revision,
      specHash: await specHash(spec),
      nonce: crypto.randomUUID().replaceAll('-', ''),
      types,
      nodes: dirs,
      authority,
      tips,
      owner: { ref: own.ref, oid: own.oid, generation: own.generation },
      sessionCwd,
      worktreeRoot: root,
      commonDir,
      roots: await rootsOf(p, litterDir, [sessionCwd, ...Object.values(dirs).map(d => d.dir)]),
      ...(live.run ? { run: live.run } : {}),
      ...(live.budget ? { budget: live.budget } : {}),
      confirmedBy: live.confirmedBy,
    }
    const start = await appendLaunchRecord(p, litterDir, name, launchId, 'swarm.start', body)
    const s: LiveSwarm = {
      name,
      launch: launchId,
      revision: saved.revision,
      spec,
      nonce: body.nonce,
      types,
      typesReady: true,
      dirs,
      sessionCwd,
      worktreeRoot: root,
      commonDir,
      roots: body.roots,
      tips,
      owner: { ref: own.ref, oid: own.oid, generation: own.generation, session: sessionId },
      state: 'live',
      readOnly: false,
      lost: false,
      flags: { isolationLost: false },
      startedAt: start.at,
      ...(live.run ? { run: live.run } : {}),
      ...(live.budget ? { budget: live.budget } : {}),
    }
    putLiveSwarm(s)
    isLive = true
    // Its spend counts from the session's total now (WP-DH).
    await measureSpend(p)
    const entry: SwarmEntry = {
      launch: launchId,
      state: 'live',
      commonDir,
      owner: { ...s.owner, checkedAt: Math.floor((await p.now()) / 1000) },
      nodeTypes: Object.values(types),
    }
    await deps.writeSwarmPolicy(p, litterDir, name, entry)
    return { ok: true, launch: launchId }
  } catch (err) {
    return await failed(errText(err))
  }
}

/**
 * Step 7: the start line and the confirmed authority, one line per node, in
 * your prompt box, so the start is your own message. A box that doesn't take
 * it leaves the swarm live, with a toast saying what to send. Answers whether
 * it took it.
 */
export async function fillStart(p: Ports, plan: Pick<LaunchPlan, 'name' | 'saved' | 'authority'>): Promise<boolean> {
  const { name, authority } = plan
  const text = [`/litter:swarm start ${name}`, ...plan.saved.spec.nodes.map(n => authority[n.id]!)].join('\n')
  const filled = await p.fillPrompt(text).catch(() => false)
  if (!filled) {
    p.log(`swarm ${name}: the prompt box didn't take the start line`)
    p.toast(`swarm ${name} is live; send /litter:swarm start ${name} to start it`)
  }
  return filled
}

// ---------------------------------------------------------------------------
// mcp__litter__swarm_read

const no = (error: string): SwarmReadReply => ({ ok: false, error: `litter: ${error}` })

/** A preview of a queued message: the lead needs its id, and enough to know which it is. */
const PREVIEW_CHARS = 1000
const preview = (text: string) => (text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS)}…` : text)

async function readDraftOf(p: Ports, litterDir: string, name: string): Promise<SwarmReadReply> {
  const draft = await deps.readDraft(p, litterDir, name)
  if (draft) return { ok: true, swarm: name, draft: true, revision: draft.base, spec: draft.spec, briefs: draft.briefs }
  const saved = await deps.readSaved(p, litterDir, name)
  if (saved) return { ok: true, swarm: name, draft: false, revision: saved.revision, spec: saved.spec, briefs: saved.briefs }
  return no(`swarm ${name} has no draft and was never saved; propose it with mcp__litter__swarm_propose at baseRevision 0`)
}

/**
 * The list's words that would read as litter's own (admission's, `stopped`, the read-only `idle`, `gone`), as the
 * browser words them: 2.1.289's `waiting` is mid-turn on child agents alone, or ended but holding work that wakes it.
 */
const ENGINE_WORDS: Partial<Record<AgentStatus, string>> = { waiting: 'held', idle: 'between turns', pending: 'starting' }

async function launchRead(p: Ports, litterDir: string, s: LiveSwarm): Promise<SwarmReadLaunch> {
  const facts = await readLaunchFacts(p, litterDir, s.name, s.launch)
  // Another session's agents aren't in this one's list: its read shows the owner's last state.
  const list = s.readOnly ? null : new Map((await p.listAgents()).map(a => [a.id, a.status]))
  const statusOf = (agentId: string): string => {
    if (isStopped(agentId)) return 'stopped'
    const st = status(agentId)
    if (st !== 'idle') return st
    if (!list) return 'idle'
    const listed = list.get(agentId)
    return listed === undefined ? 'gone' : (ENGINE_WORDS[listed] ?? listed)
  }
  const instanceOf = (agentId: string, n: number): SwarmReadInstance => ({
    n,
    agentId,
    status: statusOf(agentId),
    lastReport: lastReport(agentId)?.text ?? null,
    openQuestions: openQuestions(s.name).filter(q => q.agentId === agentId).map(q => q.text),
    queued: queued(s.name, agentId).map(q => ({ id: q.id, text: preview(q.text) })),
  })
  // An orchestrator that has an instance already (spawned, bound or reserved) isn't spawned again by `start`.
  const started = new Set([
    ...facts.instances.map(i => i.node),
    ...bindings(s.name).map(b => b.node),
    ...reservations(s.name).map(r => r.node),
  ])
  const orchestrators: SwarmReadOrchestrator[] = s.readOnly
    ? []
    : s.spec.nodes
        .filter(n => n.kind === 'orchestrator' && !started.has(n.id))
        .map(n => ({
          node: n.id,
          subagent_type: s.types[n.id] ?? servedType(s.name, n.id),
          description: `swarm ${s.name}: ${n.id}`,
          task: n.task ?? 'Work on your part of the goal, as your brief describes.',
        }))
  return {
    ok: true,
    swarm: s.name,
    launch: s.launch,
    revision: s.revision,
    readOnly: s.readOnly,
    authority: authorityLines(s, facts.start?.body ?? null),
    orchestrators,
    nodes: s.spec.nodes.map(n => ({
      node: n.id,
      kind: n.kind,
      instances: bindings(s.name)
        .filter(b => b.node === n.id && b.kind !== 'child')
        .sort((x, y) => x.n - y.n)
        .map(b => instanceOf(b.agentId, b.n)),
    })),
  }
}

async function continuationRead(p: Ports, s: LiveSwarm, node: string, how: 'resume' | 'respawn'): Promise<SwarmReadReply> {
  if (s.readOnly) return no(`swarm ${s.name} is owned by session ${s.owner.session}; nothing is resumed or re-spawned from here`)
  if (s.state === 'stopping') return no(`swarm ${s.name} is stopping: nothing is resumed or re-spawned`)
  const n = s.spec.nodes.find(x => x.id === node)
  if (!n) return no(`node '${node}' isn't in swarm ${s.name}'s revision ${s.revision}`)
  if (how === 'respawn' && n.kind === 'worker') {
    return no(`${node} is a worker, which its orchestrator re-spawns: resume or re-spawn its orchestrator, whose message names it`)
  }
  const targets = resumeTargets(s, node)
  if (how === 'resume' && targets.length === 0) {
    return no(`${node} has no instance this session can resume (it was bound under another owner, or stopped); re-spawn it with for: respawn`)
  }
  const text = await continuationText(p, s.name, node, how)
  return how === 'resume'
    ? { ok: true, swarm: s.name, node, for: how, text, agentIds: targets.map(t => t.agentId) }
    : { ok: true, swarm: s.name, node, for: how, text, subagent_type: s.types[node] ?? servedType(s.name, node), description: `${node} re-spawned` }
}

async function readSwarm(p: Ports, e: Parameters<SwarmReadHook>[1], budget: WaitBudget): Promise<SwarmReadReply> {
  if (e.agentId !== undefined) return no("mcp__litter__swarm_read is the lead's; a swarm node asks its parent instead")
  const input = decodeSwarmInput(SWARM_READ, e as unknown as Readonly<Record<string, unknown>>)
  const name = input.swarm
  if (typeof name !== 'string' || !SWARM_NAME.test(name)) return no("'swarm' must be a swarm name: lowercase letters, digits and -, up to 24")
  if (input.draft !== undefined && typeof input.draft !== 'boolean') return no("'draft' must be true or false")
  const node = input.node
  const how = input.for
  if (node !== undefined && (typeof node !== 'string' || !NODE_ID.test(node))) return no("'node' must be a node id")
  if (how !== undefined && how !== 'resume' && how !== 'respawn') return no("'for' must be resume or respawn")
  if (node !== undefined && how === undefined) return no("'node' goes with 'for': resume or respawn")
  if (how !== undefined && node === undefined) return no("'for' needs the 'node' to resume or re-spawn")
  if (input.draft === true && how !== undefined) return no("'draft' and 'for' don't go together")
  const litterDir = session().litterDir
  if (!litterDir) return no(`this session has no litter directory (${session().litterDirError ?? "session.start hasn't resolved it"})`)
  // A closed gate is waited on only for what the hook has left (FIX-U, U5).
  await ready(p, await budget.left())
  if (input.draft === true) return readDraftOf(p, litterDir, name)
  const s = liveSwarm(name)
  if (!s) return no(`swarm ${name} isn't live; launch it from the swarm builder (/litter swarms ${name}), or read its draft with draft: true`)
  if (s.lost) return no(`swarm ${name} was handed to another session; this session no longer acts on it`)
  if (how !== undefined) return continuationRead(p, s, node as string, how)
  return launchRead(p, litterDir, s)
}

/** tool.call on `mcp__litter__swarm_read`, after register.tsx's drain: answered here, never passed on. It writes nothing. */
export const swarmReadTool: PortHook<SwarmReadHook> = async (p, e, next) => {
  return { result: JSON.stringify(await readSwarm(p, e, await waitBudget(p, next))) }
}
