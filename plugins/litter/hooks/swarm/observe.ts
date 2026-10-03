// WP-P: what the mod learns from the hooks about running nodes: the spool
// consumer (in-flight calls, shells, reports, holds, denials), a node's
// turn.complete (tokens, reports, the branch checks), and [That was me].
//
// Facts come from what the mod observes (plan 15.6): the command hooks' spool
// for calls, denials, hand-backs and holds, turn.complete for tokens and for
// the answer outside auto mode, and git for the branches. A spool line is a
// report, never authority (15.8): nothing here grants anything, and git runs
// only with the module's own argv, its refs from `for-each-ref`.
//
// A read-only swarm (another session's) and a lost one (handed over) are
// never acted on: their lines change nothing here, and nothing is recorded.

import type { Ports } from '../ports'
import type { SpoolConsumer, SpoolLine } from '../hookfiles'
import type { TurnCompleteHook } from '../hooktypes'
import type { SwarmEventBody } from '../records/swarm'
import type { LiveSwarm, NodeBinding } from './types'
import { appendLaunchRecord, readLaunchLedger } from '../records/swarm'
import { modePath, SWARM_NAME } from '../layout'
import { serial } from '../fsx'
import { roleOf } from '../policy'
import { session } from '../session'
import { errText, git, OID } from '../worktrees'
import * as state from './state'
import { others } from './end'

type Line<E extends SpoolLine['ev']> = Extract<SpoolLine, { ev: E }>

/** An event's text, and a denial's reason: cut to these many UTF-8 bytes (a report is 4 KiB in state.ts too). */
const TEXT_MAX_BYTES = state.REPORT_MAX_BYTES
const REASON_MAX_BYTES = 1024
/** At most this many files or children named in one event. */
const LIST_MAX = 100
/** A background shell's id as the engine mints it: it only ever reaches TaskStop's input. */
const SHELL_ID = /^[A-Za-z0-9_-]{1,128}$/
/** The four rule folders under a checkout (plan 16.1, 16.7), as git pathspecs. */
export const RULE_PATHS = ['.litter', '.litter.local', '.claude/rules/litter', '.claude/rules/litter-local'] as const
/** A report-to-lead check that found nothing at the hand-back looks once more after this. */
const LEAD_RECHECK_MS = 30_000

/** Cut to at most `max` UTF-8 bytes, on a character boundary. */
function cutBytes(text: string, max: number): string {
  if (text.length * 3 <= max) return text
  let bytes = 0
  let end = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0)!
    const n = cp < 0x80 ? 1 : cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    if (bytes + n > max) break
    bytes += n
    end += ch.length
  }
  return text.slice(0, end)
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, LIST_MAX) : [])

/** A live swarm this session acts on: not another session's, not handed over. */
export function actsOn(name: string): LiveSwarm | null {
  const s = state.liveSwarm(name)
  return s && !s.readOnly && !s.lost ? s : null
}

/** The binding and its swarm, when the agent is bound in a swarm this session acts on. */
function boundIn(agentId: string): { b: NodeBinding; s: LiveSwarm } | null {
  const b = state.binding(agentId)
  const s = b ? actsOn(b.swarm) : null
  return b && s ? { b, s } : null
}

/**
 * Who a line's agent is, for the in-flight table: a bound node or child of a
 * swarm this session acts on, or a run agent (`litter:<role>`, calls only).
 * Null for anyone else: an agent nobody knows, an agent-summary fork (an
 * empty `agent_type`, 15.9 item 18), and an agent of a swarm not acted on here.
 */
function whoIs(agentId: string | null, agentType: string | null): { bound: { b: NodeBinding; s: LiveSwarm } | null } | null {
  if (agentId === null || agentId === '' || agentType === '') return null
  if (state.binding(agentId) !== null) {
    const bound = boundIn(agentId)
    return bound ? { bound } : null
  }
  return agentType !== null && roleOf(agentType) !== null ? { bound: null } : null
}

/** A spool line's time in ms (`ts` is `date +%s`), or now when it has none. */
async function lineAt(p: Ports, line: { ts: number }): Promise<number> {
  return typeof line.ts === 'number' && Number.isFinite(line.ts) && line.ts > 0 ? Math.round(line.ts * 1000) : p.now()
}

/** One `swarm.event` in the swarm's launch ledger; a failure is logged, since one bad record never stops the drain. */
async function recordEvent(p: Ports, litterDir: string, s: LiveSwarm, body: SwarmEventBody): Promise<number | null> {
  try {
    return (await appendLaunchRecord(p, litterDir, s.name, s.launch, 'swarm.event', body)).seq
  } catch (err) {
    p.log(`swarm ${s.name}: the ${body.kind} event wasn't recorded: ${errText(err)}`)
    return null
  }
}

// ---------------------------------------------------------------------------
// The spool consumer

/** Agents whose lost isolation context was recorded already: once per agent, the swarm flagged once. */
const isolationNoted = new Set<string>()
/** Hand-backs already recorded as `report-to-lead`, by agent and call. */
const toLeadNoted = new Set<string>()

/**
 * In registry.ts's SPOOL_CONSUMERS, right after consumeAgents. For a line
 * whose agent is bound (or a run agent, for the in-flight table only):
 *  - `call` start opens the call; its end closes it, and names a background
 *    shell when the line carries one (a node's only);
 *  - `deny` closes its call, and a node's is a `denied` event;
 *  - `stop` (SubagentStop) closes every call the agent left open, and a
 *    node's stop is noted for the settle wait;
 *  - `handback` is the node's report: a `report` event, and `report-to-lead`
 *    when the lead got a worker's or a child's;
 *  - `hold`: a timeout is `worker-ended-early` when a child still runs, a release `held`;
 *  - `isolation-lost` flags the swarm, and L refuses new spawns from then on.
 * A line about an agent nobody knows changes nothing. Each line changes the
 * state idempotently; an event can be recorded twice only after a crash
 * between a line's delivery and its removal (policy.ts, drainAside).
 */
export const consumeSwarm: SpoolConsumer = async (ctx, line) => {
  switch (line.ev) {
    case 'call':
      return onCall(ctx.p, line)
    case 'deny':
      return onDeny(ctx.p, ctx.litterDir, line)
    case 'stop':
      return onStop(line)
    case 'handback':
      return onHandback(ctx.p, ctx.litterDir, line)
    case 'hold':
      return onHold(ctx.p, ctx.litterDir, line)
    case 'isolation-lost':
      return onIsolationLost(ctx.p, ctx.litterDir, line)
    default:
      return
  }
}

async function onCall(p: Ports, line: Line<'call'>): Promise<void> {
  const who = whoIs(line.agent_id, line.agent_type)
  if (!who || typeof line.tool_use_id !== 'string' || line.tool_use_id === '') return
  const at = await lineAt(p, line)
  if (line.phase === 'start') {
    state.callStart(line.agent_id, line.tool_use_id, String(line.tool), at, typeof line.detail === 'string' ? line.detail : '')
    return
  }
  if (line.phase !== 'end') return
  state.callEnd(line.agent_id, line.tool_use_id)
  // A Bash run in the background goes on after its call ends: the settle wait stops it (15.4, "Settling").
  if (who.bound && typeof line.shell === 'string' && SHELL_ID.test(line.shell)) state.shellStarted(line.agent_id, line.shell, at)
}

async function onDeny(p: Ports, litterDir: string, line: Line<'deny'>): Promise<void> {
  const who = whoIs(line.agent_id, line.agent_type)
  if (!who || line.agent_id === null) return
  if (typeof line.tool_use_id === 'string') state.callEnd(line.agent_id, line.tool_use_id)
  if (!who.bound) return
  const { b, s } = who.bound
  const reason = cutBytes(String(line.reason), REASON_MAX_BYTES)
  await recordEvent(p, litterDir, s, { kind: 'denied', node: b.node, agentId: b.agentId, tool: String(line.tool), reason })
  others.noteSummaryTrigger(s.name, 'denied')
}

function onStop(line: Line<'stop'>): void {
  const who = whoIs(line.agent_id, line.agent_type)
  if (!who) return
  // A call another hook denied, or one the stop cut short, never gets its end (15.9, item 13).
  state.closeCalls(line.agent_id)
  if (who.bound) state.noteAgentStopped(line.agent_id)
}

async function onHandback(p: Ports, litterDir: string, line: Line<'handback'>): Promise<void> {
  const who = whoIs(line.agent_id, line.agent_type)
  if (!who?.bound) return
  const { b, s } = who.bound
  const text = typeof line.message === 'string' ? line.message : ''
  if (text.trim() === '') return
  // The same report again is a line delivered twice (a crash mid-drain): it's recorded once.
  const last = state.lastReport(b.agentId)
  if (last?.via === 'handback' && last.text === cutBytes(text, TEXT_MAX_BYTES)) return
  state.noteReport(b.agentId, text, 'handback', await p.now())
  await recordEvent(p, litterDir, s, { kind: 'report', node: b.node, agentId: b.agentId, via: 'handback', text: cutBytes(text, TEXT_MAX_BYTES) })
  // A worker's or child's report belongs to its parent; the engine gives it to the lead once the
  // worker's record is evicted (15.4, option B). The spool line can't say which, so the lead's
  // transcript is checked for the hand-back frame from this agent.
  if (b.parent !== null) {
    const key = `${b.agentId}\u0000${String(line.tool_use_id)}`
    if (!(await reportToLead(p, litterDir, s.name, b, text, key))) {
      // The engine doesn't await a timer's callback; the promise is handed back for a test's runAfters.
      p.after(LEAD_RECHECK_MS, () =>
        reportToLead(p, litterDir, s.name, b, text, key).then(
          () => undefined,
          err => p.log(`swarm ${s.name}: the report-to-lead check failed: ${errText(err)}`),
        ),
      )
    }
  }
  others.noteSummaryTrigger(s.name, 'report')
}

/** The engine's frame around a subagent's report in its recipient's conversation (2.1.288 `:354174`). */
const HANDBACK_FRAME = '[Subagent hand-back]'

/**
 * Records `report-to-lead` when the lead's conversation holds this agent's
 * hand-back: a peer message `from` its agentId (nodes have no name, 15.2)
 * with the engine's frame and the report's first line, which the frame
 * indents. True when it found it (or had already); false otherwise.
 */
async function reportToLead(p: Ports, litterDir: string, name: string, b: NodeBinding, text: string, key: string): Promise<boolean> {
  if (toLeadNoted.has(key)) return true
  const s = actsOn(name)
  if (!s) return true
  const first = text.split(/\r\n?|\n/).map(l => l.trim()).find(l => l !== '')?.slice(0, 200) ?? ''
  const rows = (await p.messages().catch(() => null)) ?? []
  const found = rows.some(
    m => m.role === 'user' && m.text.includes(HANDBACK_FRAME) && m.text.includes(`from="${b.agentId}"`) && (first === '' || m.text.includes(first)),
  )
  if (!found) return false
  toLeadNoted.add(key)
  await recordEvent(p, litterDir, s, { kind: 'report-to-lead', node: b.node, agentId: b.agentId })
  return true
}

async function onHold(p: Ports, litterDir: string, line: Line<'hold'>): Promise<void> {
  const bound = typeof line.agent_id === 'string' ? boundIn(line.agent_id) : null
  if (!bound) return
  const { b, s } = bound
  const named = strings(line.children)
  if (line.phase === 'timeout') {
    // The worker ends its turn while children run: only those still running count, since a hold
    // that missed a child's done/ waited on nothing. A listing hold.sh couldn't read until the cap
    // names none; the worker's own bound children stand in.
    const ids = named.length > 0 ? named : state.childrenOf(b.agentId).map(c => c.agentId).slice(0, LIST_MAX)
    const children = ids.filter(id => state.binding(id) !== null && state.status(id) === 'running' && !state.agentStopped(id))
    if (children.length > 0) await recordEvent(p, litterDir, s, { kind: 'worker-ended-early', node: b.node, agentId: b.agentId, children })
  } else if (line.phase === 'released') await recordEvent(p, litterDir, s, { kind: 'held', node: b.node, agentId: b.agentId, children: named })
}

async function onIsolationLost(p: Ports, litterDir: string, line: Line<'isolation-lost'>): Promise<void> {
  const who = whoIs(line.agent_id, line.agent_type)
  if (!who?.bound) return
  const { b, s } = who.bound
  // 15.9's risk "Another plugin can break every node's directory": the browser names the likely
  // cause, and L refuses new spawns while the flag is set.
  if (!s.flags.isolationLost) state.patchLiveSwarm(s.name, { flags: { ...s.flags, isolationLost: true } })
  if (isolationNoted.has(b.agentId)) return
  isolationNoted.add(b.agentId)
  p.log(
    `swarm ${s.name}: ${b.node} (${b.agentId}) lost its isolation context on ${String(line.tool)} (cwd ${String(line.cwd)}); ` +
      "a plugin with a broad tool.call hook is the likely cause; new spawns are refused",
  )
  await recordEvent(p, litterDir, s, {
    kind: 'isolation-lost',
    node: b.node,
    agentId: b.agentId,
    tool: String(line.tool),
    cwd: String(line.cwd),
    expected: typeof line.expected === 'string' ? line.expected : null,
  })
}

// ---------------------------------------------------------------------------
// A node's turn.complete

/** The main thread's permission mode, as watch.sh last wrote it; null when it can't be read. */
async function sessionMode(p: Ports, litterDir: string): Promise<string | null> {
  try {
    const path = modePath(litterDir)
    if (!(await p.fs.exists(path))) return null
    return (await p.fs.read(path)).trim() || null
  } catch {
    return null
  }
}

/**
 * turn.complete for a bound node, after L's settleNode (register.tsx calls it
 * for any agent with a binding):
 *  - its tokens, from `e.usage` (none for an interrupted turn, which still counts);
 *  - every call it left open is closed: a turn ends with none running, and an
 *    interrupted one (TaskStop) gets no SubagentStop and no Post event (15.9,
 *    item 13). register.tsx drains the spool before an aborted turn's stop;
 *  - outside auto mode, its answer is its report, unless a hand-back came in
 *    this turn (15.6: in auto mode a node reports through SubagentHandback,
 *    and its final text isn't delivered);
 *  - the branch checks (15.4, "checked again afterwards").
 */
export async function observeNodeTurn(p: Ports, e: Parameters<TurnCompleteHook>[1]): Promise<void> {
  const agentId = e.agentId
  const litterDir = session().litterDir
  if (agentId === undefined || !litterDir) return
  const bound = boundIn(agentId)
  if (!bound) return
  const { b, s } = bound
  state.addTokens(agentId, e.usage)
  state.closeCalls(agentId)
  if (b.kind !== 'child') {
    const now = await p.now()
    const answer = typeof e.answer === 'string' ? e.answer : ''
    const last = state.lastReport(agentId)
    const handedBack = last?.via === 'handback' && last.at >= now - Math.max(0, e.durationMs ?? 0)
    if (!e.isAborted && answer.trim() !== '' && !handedBack && (await sessionMode(p, litterDir)) !== 'auto') {
      state.noteReport(agentId, answer, 'answer', now)
      await recordEvent(p, litterDir, s, { kind: 'report', node: b.node, agentId, via: 'answer', text: cutBytes(answer, TEXT_MAX_BYTES) })
    }
    others.noteSummaryTrigger(s.name, 'finished')
  }
  try {
    await branchChecks(p, litterDir, s.name, b)
  } catch (err) {
    p.log(`swarm ${s.name}: the branch checks after ${b.node} (${agentId}) failed: ${errText(err)}`)
  }
}

/** HEAD moves already recorded, by agent: a HEAD that stays off its branch is recorded once, not at every turn. */
const headNoted = new Map<string, string | null>()

/** Every local branch's tip, `refs/heads/<name>` → oid; null when git can't list them. */
export async function branchTips(p: Ports, commonDir: string): Promise<Record<string, string> | null> {
  const r = await git(p, commonDir, ['for-each-ref', '--format=%(refname)%00%(objectname)', 'refs/heads'])
  if (r.code !== 0) return null
  const out: Record<string, string> = {}
  for (const row of r.stdout.split('\n')) {
    const [ref, oid] = row.split('\0')
    if (ref && oid && ref.startsWith('refs/heads/') && OID.test(oid)) out[ref] = oid
  }
  return out
}

/** A run's own branches (`litter/<run>`, its integration and writer branches): moved by runs, whose land checks them (section 9). */
const RUN_BRANCH = /^refs\/heads\/litter\/[0-9]{8}-[a-z0-9]/

/**
 * A move litter made itself and expects: a run's branch, or a new branch
 * under `sw/<swarm>/`, an `own` worker's, which the spawn check creates
 * before its instance runs (15.4).
 */
function expectedMove(ref: string, from: string | null): boolean {
  if (RUN_BRANCH.test(ref)) return true
  if (from !== null) return false
  const m = /^refs\/heads\/sw\/([^/]+)\//.exec(ref)
  return m !== null && SWARM_NAME.test(m[1]!) && state.liveSwarm(m[1]!) !== null
}

/** The commit an `own` worker's branch was made from, from its `swarm.worktree` record; null when there's none. */
async function madeFrom(p: Ports, litterDir: string, s: LiveSwarm, ref: string): Promise<string | null> {
  const branch = ref.replace(/^refs\/heads\//, '')
  const { records, tampered } = await readLaunchLedger(p, litterDir, s.name, s.launch)
  if (tampered) return null
  const made = records.filter(r => r.kind === 'swarm.worktree' && r.by.source === 'mod' && r.body.branch === branch).at(-1)
  const from = made?.body.from
  return typeof from === 'string' && OID.test(from) ? from : null
}

/**
 * 15.4, "Commits stay on the bound branch", checked again afterwards; one
 * swarm's checks at a time, so two nodes' turns don't compare against the
 * same tips:
 *  - the node's HEAD is still its bound ref (`head-moved` otherwise);
 *  - every local branch against the tips at the last check: one that moved
 *    and isn't the bound branch of a node that was running is `branch-moved`,
 *    naming those nodes;
 *  - a bound branch that moved is diffed over the rule folders (`rule-commit`);
 *  - then the tips are the swarm's new ones.
 */
async function branchChecks(p: Ports, litterDir: string, name: string, b: NodeBinding): Promise<void> {
  await serial(`swarm-tips:${litterDir}:${name}`, async () => {
    const s = actsOn(name)
    if (!s) return
    if (b.kind !== 'child' && b.branch !== null) {
      const r = await git(p, b.cwd, ['symbolic-ref', '-q', 'HEAD'])
      if (r.code === 0 || r.code === 1) {
        const actual = r.code === 0 ? r.stdout.trim() : null
        if (actual === b.branch) headNoted.delete(b.agentId)
        else if (headNoted.get(b.agentId) !== actual) {
          headNoted.set(b.agentId, actual)
          await recordEvent(p, litterDir, s, { kind: 'head-moved', node: b.node, agentId: b.agentId, expected: b.branch, actual })
        }
      } else p.log(`swarm ${name}: git symbolic-ref failed in ${b.cwd}: ${r.stderr.trim()}`)
    }

    const tips = await branchTips(p, s.commonDir)
    if (!tips) {
      p.log(`swarm ${name}: git for-each-ref failed in ${s.commonDir}; the branches weren't checked`)
      return
    }
    // The nodes that were running: running or settling now, and the one whose turn just ended.
    const running = state.bindings(name).filter(x => x.agentId === b.agentId || state.status(x.agentId) !== 'idle')
    const runningNodes = [...new Set(running.filter(x => x.kind !== 'child').map(x => x.node))].sort()
    const bound = new Map<string, NodeBinding>()
    for (const x of running) if (x.branch !== null && (!bound.has(x.branch) || x.agentId === b.agentId)) bound.set(x.branch, x)
    for (const ref of [...new Set([...Object.keys(s.tips), ...Object.keys(tips)])].sort()) {
      const from = s.tips[ref] ?? null
      const to = tips[ref] ?? null
      if (from === to) continue
      const owner = bound.get(ref)
      if (owner) {
        const base = from ?? (await madeFrom(p, litterDir, s, ref))
        if (base && to) await ruleCommit(p, litterDir, s, owner, base, to)
        continue
      }
      if (expectedMove(ref, from)) continue
      await recordEvent(p, litterDir, s, { kind: 'branch-moved', ref, from, to, running: runningNodes })
    }
    state.patchLiveSwarm(name, { tips })
  })
}

/** A bound branch's new commits that touch the rule folders (15.4): they never count as your acceptance (16.4). */
async function ruleCommit(p: Ports, litterDir: string, s: LiveSwarm, owner: NodeBinding, from: string, to: string): Promise<void> {
  const r = await git(p, s.commonDir, ['diff', '--name-only', '-z', from, to, '--', ...RULE_PATHS])
  if (r.code !== 0) {
    p.log(`swarm ${s.name}: git diff ${from} ${to} failed; the rule folders weren't checked: ${r.stderr.trim()}`)
    return
  }
  const files = r.stdout.split('\0').filter(f => f !== '')
  if (files.length === 0) return
  await recordEvent(p, litterDir, s, { kind: 'rule-commit', node: owner.node, agentId: owner.agentId, from, to, files: files.slice(0, LIST_MAX) })
}

// ---------------------------------------------------------------------------
// [That was me]

/**
 * [That was me] on a branch-moved event: records `branch-moved-ack` for its
 * `seq`, once. Throws, with the reason, for a swarm this session doesn't act
 * on, or a `seq` that isn't one of its launch's branch-moved events.
 */
export async function ackBranchMoved(p: Ports, swarm: string, seq: number): Promise<void> {
  const litterDir = session().litterDir
  if (!litterDir) throw new Error('litter: this session has no litter directory')
  const s = actsOn(swarm)
  if (!s) throw new Error(`litter: ${swarm} isn't a live swarm this session owns`)
  await serial(`swarm-ack:${litterDir}:${swarm}`, async () => {
    const { records, tampered } = await readLaunchLedger(p, litterDir, swarm, s.launch)
    if (tampered) throw new Error(`litter: launch ${s.launch} of ${swarm} has a tampered ledger at record ${tampered.seq}`)
    const moved = records.find(r => r.seq === seq && r.kind === 'swarm.event' && r.body.kind === 'branch-moved')
    if (!moved) throw new Error(`litter: record ${seq} of ${swarm}'s launch ${s.launch} isn't a branch-moved event`)
    if (records.some(r => r.kind === 'swarm.event' && r.body.kind === 'branch-moved-ack' && r.body.seq === seq)) return
    await appendLaunchRecord(p, litterDir, swarm, s.launch, 'swarm.event', { kind: 'branch-moved-ack', seq })
  })
}

/** For tests: forget what this module noted in memory. */
export function resetObserveForTests(): void {
  isolationNoted.clear()
  toLeadNoted.clear()
  headNoted.clear()
}
