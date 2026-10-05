// /litter-agents and the agents pane (phase 5; COMMON step 6, decisions 5, 6,
// 16): this session's agents and the picked team's members, with status and
// unread counts; the selected agent's pending inbox and transcript tail; a
// composer, a broadcast to the team, and [Stop] with a confirm. Rebuilt on
// the ui tick while the pane is open. Keys are `agents:<action>[:<arg>]`.
// Inboxes go through hooks/team/store.ts. Owner: WP-CG.
//
// The render is a pure function of the view in $.state (view.ts builds it).
// Every press reads the rows again (view.ts, gather) and acts only on a row
// still listed in the scope the press was drawn for; one that's gone is
// ignored with a toast. A message goes through `p.send` to this session's
// agent or teammate (`{ agentId }`), by name to an unlisted member of a team
// this session leads, and through the store's locked append to another
// team's member (decision 5): "queued" is all a send can say. [Stop] is
// TaskStop through `p.callTool` on a second press within 5 s (decision 6),
// which litter's own TaskStop hook sees as it sees the model's.

import type { RenderElement } from 'claude-code'
import type { Ports, ToolCallResult } from '../ports'
import type { CommandRunHook, PaneElements, PaneRender, PaneUiHandlers, PortHook } from '../hooktypes'
import type { AgentsBody, AgentsPaneView, AgentsRow, AgentsSelected, SwarmNotice, SwarmOption } from '../../types/index'
import type { TeamInfo } from '../uitypes'
import type { AgentsFacts, RowFacts } from './view'
import { button, buttons, header, input, line, section, select, tableFor } from '../swarm/builder'
import { clean, oneLine } from '../swarm/view'
import {
  SESSION_SCOPE,
  agentsNavOf,
  agentsNavRev,
  agentsTextDirty,
  agentsView,
  armedLive,
  blankAgentsNav,
  deps,
  factsStamp,
  gather,
  parseRowArg,
  putText,
  resetAgentsNavForTests,
  restoreAgentsNav,
  rowArg,
  saveAgentsNav,
  scopeOf,
  scopeWords,
  setAgentsNav,
  teamOfScope,
} from './view'

export const AGENTS_PANE = 'litter-agents'

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err))
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`
const noop = (): void => {}

// ---------------------------------------------------------------------------
// The command, and drawing

let viewSeq = 0
/** What the last written view was built from: a rebuild that matches it writes nothing (decision 16). */
let lastKey: string | null = null
let savedRev = -1

/**
 * Reads the rows again and writes the view when what it's built from moved
 * (the reads' stamp, the navigation, the armed stop's expiry), or always with
 * `force` ($.state was wiped); then saves the navigation if it changed.
 */
async function drawAgents(p: Ports, force = false): Promise<AgentsFacts | null> {
  const n = agentsNavOf()
  if (!n) return null
  const facts = await gather(p, n)
  const now = await p.now()
  const key = `${factsStamp(facts)}|${agentsNavRev()}|${armedLive(n, now)}`
  if (force || key !== lastKey) {
    await p.setView('agents', agentsView(facts, n, now, ++viewSeq))
    lastKey = key
  }
  if (savedRev !== agentsNavRev() || agentsTextDirty()) {
    savedRev = agentsNavRev()
    await saveAgentsNav(p)
  }
  return facts
}

/** command.run on `litter-agents`: opens the pane on the team named, else this session's agents; answers a one-line `text`. */
export const agentsCommand: PortHook<CommandRunHook> = async (p, e, next) => {
  await restoreAgentsNav(p)
  const arg = clean(e.args ?? '', 200).trim()
  let team: string | null = null
  let notice: SwarmNotice | null = null
  if (arg !== '') {
    let list: TeamInfo[] = []
    let why = ''
    try {
      list = await deps.teams(p)
    } catch (err) {
      why = ` (the teams couldn't be read: ${oneLine(errText(err), 160)})`
    }
    const found = list.find(t => t.name === arg) ?? list.find(t => t.dir === arg) ?? null
    if (found) team = found.name
    else notice = { level: 'warning', text: `there's no team named ${oneLine(arg, 60)}${why}, so this session's agents are shown: the picker lists the teams` }
  }
  // What was typed before stays, in a field drawn afresh.
  const prev = agentsNavOf()
  const text = prev?.text ?? ''
  setAgentsNav({ ...blankAgentsNav(team), text, gen: (prev?.gen ?? 0) + 1, field: text, notice })
  const facts = await drawAgents(p, true)
  const placed = await p.openPane(AGENTS_PANE, 'litter agents')
  const count = facts?.rows.length ?? 0
  const what = team === null ? `this session's ${plural(count, 'agent')}` : `team ${oneLine(team, 60)}'s ${plural(count, 'member')}`
  return { text: `litter: the agents pane shows ${what}${placed ? '' : " (open, but this screen can't draw it now)"}` }
}

// ---------------------------------------------------------------------------
// The render

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter-agents' }` calls it with the agentsPane atom. A pure renderer. */
export function renderAgentsPane(view: AgentsPaneView | null, resolved: PaneElements, e: PaneRender): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  const body = view?.body
  if (!body) {
    return (
      <Box flexDirection="column">
        <Text bold>litter · agents</Text>
        <Text dimColor>nothing to show yet: /litter-agents opens this session's agents</Text>
      </Box>
    )
  }
  const scope = typeof body.scope === 'string' ? body.scope : SESSION_SCOPE
  const rows = body.rows ?? []
  const sel = body.selected ?? null
  const session = scope === SESSION_SCOPE
  return (
    <Box flexDirection="column">
      {header(el, body.title, body.notice ?? null)}
      {pickerPart(el, scope, body.options ?? [])}
      {section(el, session ? 'Agents' : 'Members')}
      {rows.length === 0 && <Text dimColor>{session ? 'no agent in this session yet' : 'no member to show'}</Text>}
      {rows.map(r => rowPart(el, scope, r, sel?.key === r.key))}
      {(body.hiddenRows ?? 0) > 0 && <Text dimColor>{`${body.hiddenRows} more not shown`}</Text>}
      {(body.problems ?? []).map(x => (
        <Text color="warning" wrap="wrap">{`! ${x}`}</Text>
      ))}
      {sel === null && rows.length > 0 && <Text dimColor>press a row for its inbox, its transcript and the composer</Text>}
      {sel && inboxPart(el, sel)}
      {sel && transcriptPart(el, scope, sel)}
      {sel && stopPart(el, scope, sel)}
      {composerPart(el, body, scope)}
    </Box>
  )
}

/** A heading, with the agent's name in cyan (the user's convention for names). */
function heading(el: PaneElements, label: string, name: string | null, aside?: string): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="row" marginTop={1}>
      <Text bold>{label}</Text>
      {name !== null && <Text bold>{' · '}</Text>}
      {name !== null && (
        <Text bold color="cyan">
          {name}
        </Text>
      )}
      {aside !== undefined && <Text dimColor>{`  ${aside}`}</Text>}
    </Box>
  )
}

/** The picker: a Select where the surface draws one, else a button per choice. */
function pickerPart(el: PaneElements, scope: string, options: readonly SwarmOption[]): RenderElement | null {
  if (options.length === 0) return null
  if ('Select' in el) return select(el, { key: 'agents:scope', label: 'Show', value: scope, options })
  const { Box, Text } = el
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
      <Text>Show</Text>
      {options.map(o => button(el, { key: `agents:scope:${o.value}`, label: o.label, ...(o.value === scope ? { primary: true } : {}) }))}
    </Box>
  )
}

/** One row: its name (a plain Button: a press selects it), its type, its status as glyph and word, and its unread count. */
function rowPart(el: PaneElements, scope: string, r: AgentsRow, selected: boolean): RenderElement {
  const { Box, Button, Text } = el
  const st = r.status
  return (
    <Box flexDirection="row" columnGap={1}>
      <Text>{selected ? '›' : ' '}</Text>
      <Button key={`agents:select:${rowArg(scope, r.key)}`} label={r.name} plain onPress={noop} />
      {r.type !== '' && <Text dimColor>{r.type}</Text>}
      <Text color={st.color} dimColor={st.dim === true} wrap="truncate-end">
        {st.glyph ? `${st.glyph} ${st.text}` : st.text}
      </Text>
      {r.unread !== null && r.unread > 0 && <Text color="warning">{`✉ ${r.unread}`}</Text>}
    </Box>
  )
}

function inboxPart(el: PaneElements, sel: AgentsSelected): RenderElement {
  const { Box, Text } = el
  const inbox = sel.inbox
  if (inbox === null) {
    return (
      <Box flexDirection="column">
        {heading(el, 'Inbox', sel.name)}
        <Text dimColor>no inbox: only a team's members have one</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {heading(el, 'Inbox', sel.name)}
      {/* The inbox is an unread queue: an empty one isn't "nothing was ever sent". */}
      <Text dimColor wrap="wrap">
        only what's unread: the engine drops a message once it's delivered
      </Text>
      {inbox.error !== null && <Text color="error" wrap="wrap">{`✕ it couldn't be read: ${inbox.error}`}</Text>}
      {inbox.error === null && inbox.entries.length === 0 && <Text dimColor>nothing pending</Text>}
      {inbox.hidden > 0 && <Text dimColor>{`${inbox.hidden} earlier not shown`}</Text>}
      {inbox.entries.map(x => (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            <Text color="cyan">{x.from}</Text>
            <Text dimColor>{`· ${x.at} ·`}</Text>
            <Text wrap="truncate-end">{x.lines[0] ?? ''}</Text>
          </Box>
          {x.lines.slice(1).map(l => (
            <Text wrap="truncate-end">{`    ${l}`}</Text>
          ))}
        </Box>
      ))}
    </Box>
  )
}

function transcriptPart(el: PaneElements, scope: string, sel: AgentsSelected): RenderElement {
  const { Box, Text } = el
  const t = sel.transcript
  if (t === null) {
    return (
      <Box flexDirection="column">
        {heading(el, 'Transcript', sel.name)}
        <Text dimColor>not in this session: its transcript is its own session's</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      {heading(el, 'Transcript', sel.name, t.readable && t.total > 0 ? `last ${t.lines.length} of ${t.total}` : undefined)}
      {!t.readable && <Text dimColor>its transcript can't be read here</Text>}
      {t.readable && t.total === 0 && <Text dimColor>nothing yet</Text>}
      {t.lines.map(l => line(el, [l]))}
      {(t.more || t.total > t.lines.length) && buttons(el, [{ key: `agents:more:${rowArg(scope, sel.key)}`, label: t.more ? 'Less' : 'More' }])}
    </Box>
  )
}

/** [Stop], with its confirm: the first press arms it for 5 s (decision 6). */
function stopPart(el: PaneElements, scope: string, sel: AgentsSelected): RenderElement | null {
  if (!sel.stop) return null
  const { Box, Text } = el
  return (
    <Box flexDirection="row" columnGap={1} marginTop={1}>
      {button(el, { key: `agents:stop:${rowArg(scope, sel.key)}`, label: 'Stop', ...(sel.stop.armed ? { primary: true } : {}) })}
      {sel.stop.armed && <Text color="warning" wrap="truncate-end">{`[Stop] again to stop ${sel.name}`}</Text>}
    </Box>
  )
}

/** The composer: [Send] to the selected row, and [Broadcast to <team>] in a team's view, over one field. */
function composerPart(el: PaneElements, body: AgentsBody, scope: string): RenderElement | null {
  const c = body.composer
  if (!c) return null
  const { Box, Text } = el
  const sel = body.selected ?? null
  const team = body.broadcast ?? null
  return (
    <Box flexDirection="column">
      {heading(el, 'Message', c.to)}
      {c.to !== null && sel?.sendNote && <Text dimColor wrap="wrap">{sel.sendNote}</Text>}
      {c.to === null && team !== null && <Text dimColor wrap="wrap">{`press a member to message it, or send the same text to every member of ${team}`}</Text>}
      {'Input' in el ? (
        input(el, { key: c.key, label: '', value: c.text, placeholder: c.to !== null ? `a message for ${c.to}` : `a message for every member of ${team}`, submitLabel: 'send' })
      ) : (
        <Text dimColor>messages are typed on the terminal or the desktop</Text>
      )}
      {buttons(el, [
        c.to !== null && sel !== null && { key: `agents:send:${rowArg(scope, sel.key)}`, label: 'Send', primary: true },
        team !== null && { key: `agents:broadcast:${scope}`, label: `Broadcast to ${team}` },
      ])}
    </Box>
  )
}

// ---------------------------------------------------------------------------
// The events

type AgentsKey = { action: string; arg: string }

const parseKey = (key: string): AgentsKey | null => {
  if (!key.startsWith('agents:')) return null
  const [, action, ...rest] = key.split(':')
  return action ? { action, arg: rest.join(':') } : null
}

/** The last action's outcome, on the pane. */
function say(level: SwarmNotice['level'], text: string): void {
  const n = agentsNavOf()
  if (n) setAgentsNav({ ...n, notice: { level, text: oneLine(text, 600) } })
}

const staleToast = (p: Ports, was: string, now: string): void =>
  p.toast(`litter: that was for ${scopeWords(was)}, and the agents pane shows ${scopeWords(now)} now, so it was ignored`)

/**
 * The row a press names, read again: only while the pane still shows the
 * scope it was drawn for and still lists the row. Otherwise the press is
 * stale: a toast, and null.
 */
async function rowFor(p: Ports, arg: string): Promise<RowFacts | null> {
  const n = agentsNavOf()!
  const a = parseRowArg(arg)
  if (!a) return null
  const scope = scopeOf(n.team)
  if (a.scope !== scope) {
    staleToast(p, a.scope, scope)
    return null
  }
  const facts = await gather(p, n)
  const row = facts.rows.find(r => r.key === a.key) ?? null
  if (!row) {
    p.toast(`litter: ${oneLine(a.key, 40)} isn't listed any more, so that was ignored`)
    const cur = agentsNavOf()!
    if (cur.selected === a.key) setAgentsNav({ ...cur, selected: null, more: false, armed: null })
  }
  return row
}

/** The composer's text as it's sent: no control characters; '' when it's only space. */
const outgoing = (text: string): string => clean(text, 100_000).trim()

type Sent = { ok: true } | { ok: false; reason: string }

/** One message to one row, the way decision 5 says for it; a throw is a refusal with its words. */
async function deliver(p: Ports, row: RowFacts, text: string): Promise<Sent> {
  const via = row.via
  if (!via) return { ok: false, reason: 'nothing here sends to it' }
  p.log(`agents pane: a message for ${row.name} (${via.kind === 'inbox' ? `appended to its inbox in team ${via.team}` : via.kind === 'name' ? 'sent by name' : `sent to agent ${via.agentId}`})`)
  try {
    if (via.kind === 'inbox') {
      const r = await deps.appendInbox(p, via.team, via.agent, { from: 'user', text })
      return r.ok ? { ok: true } : { ok: false, reason: oneLine(r.error, 200) || 'refused' }
    }
    const r = await p.send(via.kind === 'agent' ? { agentId: via.agentId } : via.name, text)
    return r.isDelivered ? { ok: true } : { ok: false, reason: oneLine(r.reason, 200) || 'refused' }
  } catch (err) {
    return { ok: false, reason: oneLine(errText(err), 200) }
  }
}

/**
 * [Send] (`button`) or Enter in the field (`enter`) to one row. Queued, the
 * text goes: a button's press draws a new, empty field; Enter's field the
 * engine empties itself once the hook answers.
 */
async function send(p: Ports, row: RowFacts, typed: string, from: 'button' | 'enter'): Promise<void> {
  const text = outgoing(typed)
  if (text === '') return say('warning', 'type a message first: an empty one is never sent')
  if (!row.via) return say('info', `${row.name} is this session, so there's nothing to send it`)
  const r = await deliver(p, row, text)
  const n = agentsNavOf()!
  if (!r.ok) return say('error', `not sent to ${row.name}: ${r.reason}`)
  const where = row.via.kind === 'inbox' ? ` in its inbox (team ${oneLine(row.via.team, 40)})` : ''
  setAgentsNav({
    ...n,
    text: '',
    field: '',
    gen: from === 'button' ? n.gen + 1 : n.gen,
    notice: { level: 'ok', text: `queued for ${row.name}${where}: it reads it at its next turn` },
  })
}

/** [Broadcast to <team>]: the composer's text to every member it can reach, one send or append each, and one notice for them all. */
async function broadcast(p: Ports, scopeArg: string): Promise<void> {
  const n = agentsNavOf()!
  const scope = scopeOf(n.team)
  if (scopeArg !== scope || n.team === null) return staleToast(p, scopeArg, scope)
  const text = outgoing(n.text)
  if (text === '') return say('warning', 'type a message first: an empty one is never sent')
  const facts = await gather(p, n)
  const name = oneLine(n.team, 40)
  if (!facts.team) return say('error', `there's no team named ${name} any more, so nothing was sent`)
  const targets = facts.rows.filter(r => r.via !== null)
  if (targets.length === 0) return say('info', `team ${name} has no member to send to`)
  const queued: string[] = []
  const refused: string[] = []
  for (const r of targets) {
    const got = await deliver(p, r, text)
    if (got.ok) queued.push(r.name)
    else refused.push(`${r.name} (${got.reason})`)
  }
  const cur = agentsNavOf()!
  const words = [queued.length > 0 ? `queued for ${queued.join(', ')}` : '', refused.length > 0 ? `refused: ${refused.join('; ')}` : ''].filter(x => x !== '').join('; ')
  const level: SwarmNotice['level'] = refused.length === 0 ? 'ok' : queued.length === 0 ? 'error' : 'warning'
  setAgentsNav({
    ...cur,
    // Once any member has it, sending it again would repeat it to them, so the field empties.
    ...(queued.length > 0 ? { text: '', field: '', gen: cur.gen + 1 } : {}),
    notice: { level, text: oneLine(`broadcast to ${name}: ${words}`, 600) },
  })
}

/** [Stop]: the first press arms it; a second on the same row within 5 s calls TaskStop (decision 6). */
async function stop(p: Ports, arg: string): Promise<void> {
  const row = await rowFor(p, arg)
  if (!row) return
  if (!row.stopId) {
    return say(
      'info',
      row.listed ? `${row.name} is ${row.status.text}, not running or waiting, so there's nothing to stop` : `${row.name} isn't this session's agent, so it can't be stopped here`,
    )
  }
  const n = agentsNavOf()!
  const now = await p.now()
  if (n.armed?.arg !== arg || !armedLive(n, now)) {
    setAgentsNav({ ...n, armed: { arg, at: now }, notice: { level: 'warning', text: `[Stop] again within 5 s to stop ${row.name}` } })
    return
  }
  setAgentsNav({ ...n, armed: null })
  p.log(`agents pane: TaskStop ${row.stopId} (${row.name})`)
  let r: ToolCallResult
  try {
    r = await p.callTool('TaskStop', { task_id: row.stopId })
  } catch (err) {
    return say('error', `${row.name} wasn't stopped: ${errText(err)}`)
  }
  const deny = (r as { deny?: unknown }).deny
  if (typeof deny === 'string') return say('error', `${row.name} wasn't stopped: ${deny}`)
  const text = typeof r.text === 'string' ? r.text : ''
  if (r.isError === true) return say('error', `${row.name} wasn't stopped: ${text || 'TaskStop reported an error'}`)
  const message = (r.result as { message?: unknown } | null | undefined)?.message
  say('ok', `stopped ${row.name}: ${typeof message === 'string' && message !== '' ? message : text || 'TaskStop answered with no message'}`)
}

/** A scope picked: the Select's value, or a button's where there's no Select. Selection, [More] and an armed stop go with the old scope. */
function pickScope(token: string): void {
  const t = teamOfScope(token)
  const n = agentsNavOf()
  if (!t || !n || t.team === n.team) return
  setAgentsNav({ ...n, team: t.team, selected: null, more: false, armed: null })
}

/** One press: the action on rows read again, then the redraw. */
export async function pressAgents(p: Ports, key: string): Promise<void> {
  const k = parseKey(key)
  if (!k) return
  await restoreAgentsNav(p)
  const cur = agentsNavOf()
  if (!cur) {
    p.toast("litter: the agents pane isn't open in this session, so that was ignored: /litter-agents opens it")
    return
  }
  // A new action's outcome replaces the last one's.
  setAgentsNav({ ...cur, notice: null })
  try {
    switch (k.action) {
      case 'scope':
        pickScope(k.arg)
        break
      case 'select': {
        const row = await rowFor(p, k.arg)
        const n = agentsNavOf()!
        if (row && n.selected !== row.key) setAgentsNav({ ...n, selected: row.key, more: false, armed: null })
        break
      }
      case 'more': {
        const row = await rowFor(p, k.arg)
        const n = agentsNavOf()!
        if (row) setAgentsNav({ ...n, selected: row.key, more: !(n.more && n.selected === row.key) })
        break
      }
      case 'send': {
        const row = await rowFor(p, k.arg)
        if (row) await send(p, row, agentsNavOf()!.text, 'button')
        break
      }
      case 'broadcast':
        await broadcast(p, k.arg)
        break
      case 'stop':
        await stop(p, k.arg)
        break
      default:
        break
    }
  } catch (err) {
    p.log(`agents pane: ${key} failed: ${errText(err)}`)
    say('error', `that failed: ${errText(err)}`)
  }
  await drawAgents(p)
}

/** The composer's field: a change is kept without a redraw; Enter sends to the selected row. */
async function inputAgents(p: Ports, key: string, value: string, kind: 'change' | 'submit'): Promise<void> {
  const k = parseKey(key)
  if (!k || k.action !== 'text') return
  await restoreAgentsNav(p)
  const n = agentsNavOf()
  if (!n) return
  if (kind !== 'submit') {
    putText(value)
    return
  }
  setAgentsNav({ ...n, text: value, notice: null })
  try {
    if (n.selected === null) {
      say('info', n.team === null ? 'press an agent first: Enter sends to the one selected' : `press a member first, or [Broadcast to ${oneLine(n.team, 40)}]`)
    } else {
      const row = await rowFor(p, rowArg(scopeOf(n.team), n.selected))
      if (row) await send(p, row, value, 'enter')
    }
  } catch (err) {
    p.log(`agents pane: ${key} failed: ${errText(err)}`)
    say('error', `that failed: ${errText(err)}`)
  }
  // The engine empties a submitted field once the hook answers: text that wasn't sent comes back in a new field.
  const after = agentsNavOf()!
  if (after.text !== '') setAgentsNav({ ...after, gen: after.gen + 1, field: after.text })
  await drawAgents(p)
}

async function selectAgents(p: Ports, key: string, value: string): Promise<void> {
  const k = parseKey(key)
  if (!k || k.action !== 'scope') return
  await restoreAgentsNav(p)
  if (!agentsNavOf()) return
  pickScope(value)
  await drawAgents(p)
}

/** The pane's ui.message, ui.press, ui.input and ui.select; anything not keyed `agents:` passes on. */
export const onAgentsUi: PaneUiHandlers = {
  // The pane draws no Client, so nothing of its own posts.
  message: async (p, e, next) => next(e),
  press: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await pressAgents(p, e.element)
    return { element: e.element }
  },
  input: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await inputAgents(p, e.element, e.value, e.kind)
    return { element: e.element, value: e.value }
  },
  select: async (p, e, next) => {
    if (!parseKey(e.element)) return next(e)
    await selectAgents(p, e.element, e.value)
    return { element: e.element, value: e.value }
  },
}

// ---------------------------------------------------------------------------
// The tick

/** The ui tick's fourth step (uitick.ts): the pane's view again while it's open, written only when its stamp moved. */
export async function agentsTick(p: Ports): Promise<void> {
  await restoreAgentsNav(p)
  if (!agentsNavOf()) return
  await drawAgents(p)
}

/** After a /clear wiped $.state (clear.ts): the pane's view again, if it's open. */
export async function refreshAgents(p: Ports): Promise<void> {
  await restoreAgentsNav(p)
  if (agentsNavOf()) await drawAgents(p, true)
}

/** A fresh module's memory, as after a hot reload: no navigation (it comes back from $.store), nothing written yet. */
export function resetAgentsPaneForTests(): void {
  viewSeq = 0
  lastKey = null
  savedRev = -1
  resetAgentsNavForTests()
}
