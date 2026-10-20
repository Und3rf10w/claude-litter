// WP-N: the Doctor section's draw (15.7; the `litter` pane, phase 5b): J's
// rows with their severity glyphs, each value's process and sources, the
// snippet, and [Copy], [Ask lead to add it], [Recheck] and [Test]. A pure
// body renderer.
//
// Contract owner: phase 2b-1, package N.
//
// Phase 5b (WP-DD): the first line is the swarm checked (builder.tsx's
// titleRow), then the tally, then one row per check, a failing one first
// (view.ts's failingFirst): its glyph and word in its color, what it found,
// and the values behind it, muted. The snippet that fixes what falls short
// is under its heading, and its fix, [Ask lead to add it], is the primary.

import type { RenderElement } from 'claude-code'
import type { PaneElements } from '../hooktypes'
import type { DoctorPaneView } from '../ports'
import type { DoctorPaneBody, DoctorRowView } from '../../types/index'
import { empty, notice, type Action, type BodyContext, type SectionMeta } from '../ui/chrome'
import { STYLE } from '../ui/style'
import { cells } from '../band/view'
import { actionRow, headed, noticeRow, titleRow } from './builder'

/**
 * Doctor to the hub (chrome.tsx's SectionMeta). `fits` stays false: a
 * check's detail and values, and the snippet, are drawn whole, so the pane's
 * scroll reaches them. No keys of its own.
 */
export const doctorSection: SectionMeta<DoctorPaneView> = { fits: false, keys: () => [] }

/** The tally's level and words: what fails, what warns, or that nothing falls short. Pure. */
export function doctorTally(body: Pick<DoctorPaneBody, 'errors' | 'warnings'>): { level: 'error' | 'warning' | 'ok'; text: string } {
  if (body.errors + body.warnings === 0) return { level: 'ok', text: 'nothing falls short' }
  const parts = [
    body.errors > 0 && `${body.errors} check${body.errors === 1 ? '' : 's'} fail${body.errors === 1 ? 's' : ''}`,
    body.warnings > 0 && `${body.warnings} warning${body.warnings === 1 ? '' : 's'}`,
  ].filter((x): x is string => typeof x === 'string')
  return { level: body.errors > 0 ? 'error' : 'warning', text: parts.join(', ') }
}

/** Doctor's actions, the fix first: [Ask lead to add it] and [Copy] when there's a snippet, then [Recheck] (the primary when there's nothing to fix) and [Test]. Pure. */
export function doctorActions(body: Pick<DoctorPaneBody, 'snippet'>): Action[] {
  const fix = body.snippet !== null
  return [
    ...(fix
      ? [
          { key: 'swarm:doctor:ask-lead', label: 'Ask lead to add it', primary: true, autoFocus: true },
          { key: 'swarm:doctor:copy', label: 'Copy' },
        ]
      : []),
    { key: 'swarm:doctor:recheck', label: 'Recheck', ...(fix ? {} : { primary: true, autoFocus: true }) },
    { key: 'swarm:doctor:test', label: 'Test' },
  ]
}

/** One check: its glyph and word in its color (the words padded to one width), its title bold, what it found wrapped, its values muted. */
function checkRow(el: PaneElements, r: DoctorRowView, wordWidth: number, first: boolean): RenderElement {
  const { Box, Text } = el
  const mark = `${r.glyph} ${r.word}`
  return (
    <Box flexDirection="column" marginTop={first ? 0 : 1}>
      <Box flexDirection="row" columnGap={1}>
        <Box flexShrink={0} minWidth={wordWidth}>
          <Text color={r.color}>{mark + ' '.repeat(Math.max(0, wordWidth - cells(mark)))}</Text>
        </Box>
        <Text bold wrap="wrap">
          {r.title}
        </Text>
      </Box>
      {r.detail !== '' && (
        <Box paddingLeft={2}>
          <Text wrap="wrap">{r.detail}</Text>
        </Box>
      )}
      {r.values.map(v => (
        <Box paddingLeft={2}>
          <Text color={STYLE.muted} wrap="truncate-end">
            {v}
          </Text>
        </Box>
      ))}
    </Box>
  )
}

/** Doctor's body renderer (ui/pane.tsx calls it with the doctorPane atom under the hub's chrome). */
export function renderDoctorPane(view: DoctorPaneView | null, el: PaneElements, ctx: BodyContext): RenderElement {
  const { Box, Code, Text } = el
  const body = view?.body
  if (!body) return empty(el, 'nothing checked yet', { command: '/litter doctor', does: 'runs the check' })
  const columns = ctx.bodyColumns
  const tally = doctorTally(body)
  const wordWidth = Math.max(0, ...body.rows.map(r => cells(`${r.glyph} ${r.word}`)))
  return (
    <Box flexDirection="column">
      {titleRow(el, body.title, columns)}
      {noticeRow(el, body.notice)}
      {notice(el, tally.level, tally.text)}
      {body.tested && <Text color={STYLE.muted}>with [Test]'s summaryModel check</Text>}
      {headed(el, 'Checks', columns, body.rows.length > 0 ? `${body.rows.length}` : null)}
      {body.rows.length === 0 && <Text color={STYLE.muted}>no checks ran</Text>}
      {body.rows.map((r, i) => checkRow(el, r, wordWidth, i === 0))}
      {body.snippet !== null && (
        <Box flexDirection="column">
          {headed(el, 'Add to your user settings', columns)}
          <Text color={STYLE.path} wrap="truncate-start">
            {body.settingsPath}
          </Text>
          <Code source={body.snippet} language="json" />
        </Box>
      )}
      <Box marginTop={1}>{actionRow(el, doctorActions(body), columns)}</Box>
    </Box>
  )
}
