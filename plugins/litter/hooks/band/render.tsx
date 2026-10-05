// The band's render (phase 5; COMMON decisions 7, 11, 12): litter's rows above
// the tree of the plugins beneath (`below`, what next(e) drew), at most
// `e.props.maxRows` rows, each one line fitting `e.props.bodyColumns`: the
// spans are cut, never the buttons. A pure function of its arguments.
// Owner: WP-CB.
//
// Every Text truncates at its end, the backstop where a surface counts cells
// differently from view.ts's fitSpans. No Button has a hotkey: a bare digit in
// an empty composer would press it instead of typing (2.1.289). Each Button's
// handler is a no-op: the band's ui.press hook answers litter's keys (view.ts).

import type { RenderElement } from 'claude-code'
import type { BandElements, BandRender } from '../hooktypes'
import type { BandRow, BandView } from '../../types/index'
import { fitRows, fitSpans, roomFor } from './view'

const noop = (): void => {}

/**
 * Whether the plugins beneath drew nothing: next(e) answers the engine's own
 * band then (`{ type: 'engine' }`), which draws nothing above the prompt. It's
 * left out, since an engine node is refused under some of a Box's props.
 */
const drewNothing = (below: RenderElement | null | undefined): boolean =>
  below === null || below === undefined || (below as { type?: unknown }).type === 'engine'

/** One row: its spans in one Text that truncates, then its buttons, which never shrink. */
function rowOf(el: BandElements, r: BandRow, columns: number): RenderElement {
  const { Box, Text, Button } = el
  const spans = fitSpans(r.spans, roomFor(r.buttons, columns))
  return (
    <Box flexDirection="row" columnGap={1}>
      {spans.length > 0 && (
        <Box flexShrink={1}>
          <Text wrap="truncate-end">
            {spans.map(s => (
              <Text color={s.color} dimColor={s.dim} bold={s.bold} wrap="truncate-end">
                {s.text}
              </Text>
            ))}
          </Text>
        </Box>
      )}
      {r.buttons.length > 0 && (
        <Box flexDirection="row" flexShrink={0} columnGap={1}>
          {r.buttons.map(b => (
            <Button key={b.key} label={b.label} onPress={noop} />
          ))}
        </Box>
      )}
    </Box>
  )
}

/** register.tsx's ui.render hook on `{ component: 'AbovePrompt' }` calls it once bandShows is true. */
export function renderBand(view: BandView, resolved: BandElements, e: BandRender, below: RenderElement): RenderElement {
  const { Box } = resolved
  const rows = fitRows(view, e.props.maxRows)
  return (
    <Box flexDirection="column">
      {rows.map(r => rowOf(resolved, r, e.props.bodyColumns))}
      {drewNothing(below) ? null : below}
    </Box>
  )
}
