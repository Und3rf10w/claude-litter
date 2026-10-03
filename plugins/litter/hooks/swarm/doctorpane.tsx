// WP-N: the doctor pane's draw (15.7): J's rows with their severity glyphs,
// each value's process and sources, the snippet, and [Copy], [Ask lead to add
// it], [Recheck] and [Test]. A pure render function.
//
// Contract owner: phase 2b-1, package N.

import type { RenderElement } from 'claude-code'
import type { PaneElements, PaneRender } from '../hooktypes'
import type { DoctorPaneView } from '../ports'
import { buttons, header, section } from './builder'

/** register.tsx's ui.render hook for `{ component: 'Pane', requestId: 'litter-doctor' }` calls it with the doctorPane atom. */
export function renderDoctorPane(view: DoctorPaneView | null, el: PaneElements, e: PaneRender): RenderElement {
  const { Box, Code, Text } = el
  const body = view?.body
  if (!body) {
    return (
      <Box flexDirection="column">
        <Text bold>litter · doctor</Text>
        <Text dimColor>nothing checked yet: /litter-doctor runs the check</Text>
      </Box>
    )
  }
  const tally =
    body.errors + body.warnings === 0
      ? { text: 'nothing falls short', color: 'success' }
      : {
          text: `${body.errors} error${body.errors === 1 ? '' : 's'}, ${body.warnings} warning${body.warnings === 1 ? '' : 's'}`,
          color: body.errors > 0 ? 'error' : 'warning',
        }
  return (
    <Box flexDirection="column">
      {header(el, body.title, body.notice)}
      <Text color={tally.color}>{`${body.errors > 0 ? '✕' : body.warnings > 0 ? '!' : '✓'} ${tally.text}`}</Text>
      {body.tested && <Text dimColor>with the summaryModel test</Text>}
      {body.rows.map(r => (
        <Box flexDirection="column" marginTop={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text color={r.color}>{r.glyph}</Text>
            <Text bold>{r.title}</Text>
          </Box>
          {r.detail !== '' && <Text wrap="wrap">{`  ${r.detail}`}</Text>}
          {r.values.map(v => (
            <Text dimColor wrap="truncate-end">{`  ${v}`}</Text>
          ))}
        </Box>
      ))}
      {body.snippet !== null && (
        <Box flexDirection="column">
          {section(el, 'Add to your user settings', { text: body.settingsPath, color: 'blue' })}
          <Code source={body.snippet} language="json" />
        </Box>
      )}
      <Box marginTop={1}>
        {buttons(el, [
          body.snippet !== null && { key: 'swarm:doctor:copy', label: 'Copy' },
          body.snippet !== null && { key: 'swarm:doctor:ask-lead', label: 'Ask lead to add it' },
          { key: 'swarm:doctor:recheck', label: 'Recheck', primary: body.snippet === null },
          { key: 'swarm:doctor:test', label: 'Test' },
        ])}
      </Box>
    </Box>
  )
}
