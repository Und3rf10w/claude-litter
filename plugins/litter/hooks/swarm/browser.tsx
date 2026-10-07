// WP-N: the Swarms section's draw (the `litter` pane, phase 5b), every view
// (start, builder, proposal, browser, goal history, recovery card, unsettled
// report, read-only): a pure body renderer of the view in $.state, the hub's
// element table, and the body's context (ui/chrome.tsx). It never sees `$`
// or the ports.
//
// This file draws the live views (15.6's mockup): the browser and its
// read-only form (with a repair swarm's budget row, 2b-2), the goal history,
// the recovery card and the unsettled report; builder.tsx draws the start
// screen, the builder and a proposal.
//
// Contract owner: phase 2b-1, package N.

import type { RenderElement } from 'claude-code'
import type { PaneElements } from '../hooktypes'
import type { SwarmPaneView } from '../ports'
import type { SwarmBrowserView, SwarmBudgetRow, SwarmHistoryView, SwarmNodeRow, SwarmRecoveryView, SwarmUnsettledView } from '../../types/index'
import type { BodyContext, SectionMeta } from '../ui/chrome'
import { STYLE } from '../ui/style'
import { button, buttons, header, input, line, renderBuilder, renderProposal, renderStart, section, select, tableFor } from './builder'

/** Swarms to the hub (chrome.tsx's SectionMeta): drawn whole for now, no keys of its own. */
export const swarmsSection: SectionMeta<SwarmPaneView> = { fits: false, keys: () => [] }

/** Swarms' body renderer (ui/pane.tsx calls it with the swarmPane atom under the hub's chrome). */
export function renderSwarmPane(view: SwarmPaneView | null, resolved: PaneElements, e: BodyContext): RenderElement {
  const el = tableFor(resolved, e.surface)
  const { Box, Text } = el
  if (!view) {
    return (
      <Box flexDirection="column">
        <Text bold>litter · swarm</Text>
        <Text dimColor>nothing to show yet: /litter swarms opens the builder or a live swarm</Text>
      </Box>
    )
  }
  switch (view.view) {
    case 'start':
      return renderStart(view, el, e)
    case 'builder':
      return renderBuilder(view, el, e)
    case 'proposal':
      return renderProposal(view, el, e)
    case 'browser':
      return renderBrowser(view, el, e)
    case 'history':
      return renderHistory(view, el)
    case 'recovery':
      return renderRecovery(view, el)
    case 'unsettled':
      return renderUnsettled(view, el)
  }
}

const indent = (depth: number) => '  '.repeat(Math.max(0, depth))

function nodeRow(el: PaneElements, view: SwarmBrowserView, r: SwarmNodeRow): RenderElement {
  const { Box, Button, Text } = el
  const selected = r.agentId !== null && r.agentId === view.selected
  const stats = [r.tool && `▸ ${r.tool}`, r.turns !== null && `${r.turns} turn${r.turns === 1 ? '' : 's'}`, r.tokens && `${r.tokens} tok`]
    .filter((x): x is string => typeof x === 'string' && x !== '')
    .join(' · ')
  const status = `${r.statusGlyph ? `${r.statusGlyph} ` : ''}${r.status}`
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1}>
        <Text>{`${selected ? '›' : ' '}${indent(r.depth)}`}</Text>
        {r.agentId === null ? (
          <Text bold>{r.name}</Text>
        ) : (
          <Button
            key={`swarm:browser:select:${view.swarm}/${r.agentId}`}
            label={r.name}
            plain
            {...(r.dim ? { dimColor: true } : {})}
            onPress={() => {}}
          />
        )}
        {r.color && <Text color={r.color}>●</Text>}
        <Text color={r.statusColor}>{status}</Text>
        {stats !== '' && <Text dimColor>{stats}</Text>}
        {r.flagged && <Text color={STYLE.warning}>! flagged</Text>}
      </Box>
      {r.question !== null && (
        <Text color={STYLE.needsYou} wrap="wrap">{`${indent(r.depth + 1)} ⚑ waiting on you: ${r.question}`}</Text>
      )}
      {r.report !== '' && <Text dimColor wrap="truncate-end">{`${indent(r.depth + 1)} last report: ${r.report}`}</Text>}
      {r.queued.map(q => (
        <Box flexDirection="row" columnGap={1}>
          <Text color={STYLE.warning} wrap="truncate-end">{`${indent(r.depth + 1)} queued: ${q.text}`}</Text>
          {!view.readOnly && button(el, { key: `swarm:browser:cancel:${view.swarm}/${q.id}`, label: 'Cancel' })}
        </Box>
      ))}
    </Box>
  )
}

function composer(el: PaneElements, view: SwarmBrowserView): RenderElement | null {
  const { Box, Text } = el
  const c = view.composer
  if (!c) return null
  const s = view.swarm
  return (
    <Box flexDirection="column">
      {section(el, 'Message')}
      {c.targets.length === 0 ? (
        <Text dimColor>no node to send to yet</Text>
      ) : (
        <Box flexDirection="column">
          {select(el, { key: `swarm:browser:to:${s}`, label: 'To', value: c.to ?? '', options: c.to === null ? [{ value: '', label: 'pick a node' }, ...c.targets] : c.targets })}
          {input(el, { key: `swarm:browser:text:${s}`, label: '', value: c.text, placeholder: 'your message', submitLabel: 'send' })}
          <Box flexDirection="row" columnGap={2} flexWrap="wrap">
            {select(el, {
              key: `swarm:browser:when:${s}`,
              label: 'When',
              value: c.when,
              options: [
                { value: 'interject', label: 'Interject' },
                { value: 'queue', label: 'Queue' },
              ],
            })}
            {select(el, { key: `swarm:browser:route:${s}`, label: 'Route', value: c.route, options: c.routes })}
          </Box>
          {buttons(el, [
            { key: `swarm:browser:send:${s}${c.address ? `/${c.address}` : ''}`, label: 'Send', primary: true },
            c.offerQueue && { key: `swarm:browser:queue-instead:${s}${c.address ? `/${c.address}` : ''}`, label: 'Queue instead' },
          ])}
        </Box>
      )}
    </Box>
  )
}

/** A repair swarm's budget row (2b-2): rounds and agents used of what you approved, a used-up part with `!` and its words. */
function budgetRow(el: PaneElements, b: SwarmBudgetRow): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      <Box flexDirection="row" columnGap={1} flexWrap="wrap">
        <Text bold>Repair budget</Text>
        {[b.rounds, b.agents].map(x => (
          <Text color={x.color ?? undefined}>{`${x.glyph ? `${x.glyph} ` : ''}${x.text}`}</Text>
        ))}
      </Box>
      {b.note !== null && (
        <Text color={STYLE.warning} wrap="wrap">
          {`! ${b.note}`}
        </Text>
      )}
    </Box>
  )
}

function renderBrowser(view: SwarmBrowserView, el: PaneElements, e: BodyContext): RenderElement {
  const { Box, Text } = el
  const s = view.swarm
  const sel = view.rows.find(r => r.agentId !== null && r.agentId === view.selected) ?? null
  const live = !view.readOnly && !view.lost
  const sum = view.summary
  return (
    <Box flexDirection="column">
      {header(el, view.title, view.notice)}
      {view.owner && (
        <Box flexDirection="column">
          <Text color={view.lost ? STYLE.failed : STYLE.muted} wrap="wrap">
            {view.lost ? `this session lost it: ${view.owner.text}` : `read-only: ${view.owner.text}`}
          </Text>
          {view.owner.why !== null && <Text dimColor wrap="wrap">{view.owner.why}</Text>}
          {view.owner.canTakeOver && buttons(el, [{ key: `swarm:browser:takeover:${s}`, label: 'Take over', primary: true }])}
        </Box>
      )}
      {view.budget && budgetRow(el, view.budget)}
      {section(el, 'Summary', sum ? { text: `generated ${sum.age}${sum.stale ? ', older than the latest event' : ''}`, color: sum.stale ? STYLE.warning : STYLE.muted } : undefined)}
      {sum ? (
        <Box flexDirection="column">
          <Text wrap="wrap">{`Goal now: ${sum.goal}`}</Text>
          {sum.progress.map(x => (
            <Text wrap="wrap">{`· ${x}`}</Text>
          ))}
          {sum.waiting.length > 0 && <Text color={STYLE.needsYou}>Waiting on you</Text>}
          {sum.waiting.map(x => (
            <Text color={STYLE.needsYou} wrap="wrap">{`⚑ ${x}`}</Text>
          ))}
        </Box>
      ) : (
        <Text dimColor>no summary yet</Text>
      )}
      {view.flags.map(f => (
        <Box flexDirection="column">
          <Text color={STYLE.warning} wrap="wrap">{`! ${f.text}`}</Text>
          {live &&
            buttons(el, [
              { key: `swarm:browser:ack:${s}/${f.seq}`, label: 'That was me' },
              f.running.length > 0 && { key: `swarm:browser:stop-them:${s}/${f.seq}`, label: 'Stop them' },
            ])}
        </Box>
      ))}
      {section(el, 'Agents')}
      {view.rows.map(r => nodeRow(el, view, r))}
      {sel &&
        sel.agentId !== null &&
        buttons(el, [
          live && { key: `swarm:browser:stop:${s}/${sel.agentId}`, label: 'Stop node' },
          live && { key: `swarm:browser:hard-stop:${s}/${sel.agentId}`, label: 'Hard stop' },
          { key: `swarm:browser:transcript:${s}/${sel.agentId}`, label: view.transcript?.agentId === sel.agentId ? 'Hide transcript' : 'Transcript' },
        ])}
      {view.transcript && (
        <Box flexDirection="column" borderStyle="round" paddingX={1}>
          <Text bold>{`Transcript · ${view.transcript.name} (read-only)`}</Text>
          {!view.transcript.readable && <Text dimColor>this agent's transcript can't be read here</Text>}
          {view.transcript.readable && view.transcript.lines.length === 0 && <Text dimColor>nothing yet</Text>}
          {view.transcript.lines.map(l => line(el, [l]))}
          {buttons(el, [{ key: `swarm:browser:close-transcript:${s}`, label: 'Close' }])}
        </Box>
      )}
      {section(el, 'Events')}
      {view.events.length === 0 && <Text dimColor>none yet</Text>}
      {view.events.map(ev => (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>{ev.at}</Text>
          <Text bold>{ev.who}</Text>
          <Text color={ev.color ?? undefined} wrap="truncate-end">
            {ev.text}
          </Text>
        </Box>
      ))}
      {composer(el, view)}
      <Box marginTop={1}>
        {buttons(el, [
          { key: `swarm:browser:history:${s}`, label: 'History' },
          { key: `swarm:browser:builder:${s}`, label: 'Builder' },
          live && view.state === 'live' && { key: `swarm:browser:end:${s}`, label: 'End swarm' },
        ])}
      </Box>
    </Box>
  )
}

function renderHistory(view: SwarmHistoryView, el: PaneElements): RenderElement {
  const { Box, Text } = el
  return (
    <Box flexDirection="column">
      {header(el, view.title, view.notice)}
      {view.entries.length === 0 && <Text dimColor>no summary yet</Text>}
      {view.entries.map(x => (
        <Box flexDirection="row" columnGap={1}>
          <Text dimColor>{x.at}</Text>
          <Text wrap="wrap">{x.goal}</Text>
        </Box>
      ))}
      <Box marginTop={1}>{buttons(el, [{ key: `swarm:history:back:${view.swarm}`, label: 'Back to browser' }])}</Box>
    </Box>
  )
}

function renderRecovery(view: SwarmRecoveryView, el: PaneElements): RenderElement {
  const { Box, Text } = el
  const s = view.swarm
  return (
    <Box flexDirection="column">
      {header(el, view.title, view.notice)}
      <Text wrap="wrap">
        {view.stopping
          ? 'It was ending when the session stopped: finish ending it, or leave it stopped.'
          : 'These were running when the session stopped. Resume or re-spawn the orchestrators (their workers come back through them), or leave them stopped.'}
      </Text>
      {view.rows.map(r => (
        <Box flexDirection="column">
          <Box flexDirection="row" columnGap={1}>
            {r.pickable ? button(el, { key: `swarm:recovery:pick:${s}/${r.node}`, label: r.picked ? '[x]' : '[ ]' }) : !view.stopping && <Text>{'   '}</Text>}
            <Text bold={r.kind === 'orchestrator'}>{r.node}</Text>
            <Text dimColor>{r.kind}</Text>
            {r.note !== '' && <Text dimColor>{r.note}</Text>}
          </Box>
          {r.instances.map(x => (
            <Box flexDirection="column">
              <Box flexDirection="row" columnGap={1}>
                <Text>{`    ${x.name}`}</Text>
                <Text color={x.color}>{`${x.glyph ? `${x.glyph} ` : ''}${x.state}`}</Text>
              </Box>
              {x.report !== '' && <Text dimColor wrap="truncate-end">{`      last report: ${x.report}`}</Text>}
            </Box>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        {view.stopping
          ? buttons(el, [
              { key: `swarm:recovery:finish:${s}`, label: 'Finish ending', primary: true },
              { key: `swarm:recovery:leave:${s}`, label: 'Leave stopped' },
            ])
          : buttons(el, [
              { key: `swarm:recovery:resume-all:${s}`, label: 'Resume all', primary: true },
              { key: `swarm:recovery:resume-selected:${s}`, label: 'Resume selected' },
              { key: `swarm:recovery:respawn:${s}`, label: 'Re-spawn …' },
              { key: `swarm:recovery:leave:${s}`, label: 'Leave stopped' },
            ])}
      </Box>
    </Box>
  )
}

function renderUnsettled(view: SwarmUnsettledView, el: PaneElements): RenderElement {
  const { Box, Text } = el
  const s = view.swarm
  return (
    <Box flexDirection="column">
      {header(el, view.title, view.notice)}
      <Text dimColor>{`ending since ${view.since}`}</Text>
      {section(el, 'Still running')}
      {view.nodes.length === 0 && <Text dimColor>no node</Text>}
      {view.nodes.map(x => (
        <Text>{`· ${x.name}  ${x.status}`}</Text>
      ))}
      {view.calls.length > 0 && section(el, 'Open tool calls')}
      {view.calls.map(x => (
        <Text>{`· ${x.name}  ${x.tool}  for ${x.age}`}</Text>
      ))}
      {view.shells.length > 0 && section(el, 'Shells')}
      {view.shells.map(x => (
        <Text>{`· ${x.name}  ${x.shellId}  for ${x.age}`}</Text>
      ))}
      {view.reservations > 0 && <Text dimColor>{`${view.reservations} spawn${view.reservations === 1 ? '' : 's'} still reserved`}</Text>}
      <Box marginTop={1}>
        {buttons(el, [
          { key: `swarm:unsettled:wait:${s}`, label: 'Wait longer', primary: true },
          { key: `swarm:unsettled:hard-stop:${s}`, label: 'Hard stop' },
          { key: `swarm:unsettled:keep:${s}`, label: 'End, keep everything' },
        ])}
      </Box>
    </Box>
  )
}
