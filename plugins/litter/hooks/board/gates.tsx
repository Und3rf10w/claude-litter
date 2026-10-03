// The board's gate table as a Client surface module (plan section 11): ↑↓
// select a row and Enter shows its detail, posted to the hooks module
// (surface.post, a ui.message there); a click on a row does the same. It runs
// on the drawing thread, imports types only, and keeps local state only; no
// right-click menu (phase 5). pane.tsx draws it with `module="./gates.tsx"`
// (relative to that file). Owner: phase 3, package AF.
//
// Each post is `{ run, action: 'select', gate }`: pane.tsx ignores one whose
// run isn't the one the board shows.

import type { ClientModule } from 'claude-code'
import type { BoardGateRow, BoardGatesProps } from '../../types/index'

/** The highlighted row, moved by ↑↓ and the pointer; the selection itself is the hooks module's (`props.selected`). */
type State = { hover: number | null }

/** The column header's rows above the first gate. */
const HEADER_ROWS = 1
const IDLE: State = { hover: null }

const DIM_SHORT: Record<string, string> = { plan_adherence: 'PA', tests_green: 'TG', no_regressions: 'NR', rules: 'RU' }

const pad = (s: string, n: number) => (s.length >= n ? `${s.slice(0, n - 1)} ` : s.padEnd(n))

const Gates: ClientModule<BoardGatesProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const rows: BoardGateRow[] = Array.isArray(props?.rows) ? props.rows : []

  const current = () => surface.state ?? IDLE
  const put = (next: State) => {
    if (JSON.stringify(next) !== JSON.stringify(current())) surface.setState(next)
  }
  const selectedAt = () => Math.max(0, rows.findIndex(r => r.id === props.selected))
  const rowAt = (y: number) => {
    const i = y - HEADER_ROWS
    return i >= 0 && i < rows.length ? i : null
  }
  const post = (r: BoardGateRow) => surface.post({ run: props.run, action: 'select', gate: r.id })

  surface.onPointer(e => {
    if (e.type === 'leave') return put({ hover: null })
    if (e.type === 'move' && e.button === undefined) return put({ hover: rowAt(e.y) })
    if (e.type !== 'down' || e.button !== 'left') return
    const i = rowAt(e.y)
    if (i === null) return
    put({ hover: i })
    const r = rows[i]
    if (r) post(r)
  })

  // Reached once a click has focused the table; Escape returns the focus.
  surface.onKey(k => {
    const at = current().hover ?? selectedAt()
    if (k.key === 'down') return put({ hover: Math.min(at + 1, rows.length - 1) })
    if (k.key === 'up') return put({ hover: Math.max(at - 1, 0) })
    if (k.key === 'return') {
      const r = rows[at]
      if (r) post(r)
    }
  })

  const lit = current().hover
  return (
    <Box flexDirection="column">
      <Text bold>{'  gate  state         try   commit   failing      title'}</Text>
      {rows.length === 0 && <Text dimColor>no gates</Text>}
      {rows.map((r, i) => {
        const isSelected = r.id === props.selected
        const isLit = i === lit
        const tries = r.attempt === 0 ? '·' : `${r.attempt}/${r.maxAttempts}`
        const failing = r.failing.length > 0 ? `✕ ${r.failing.map(d => DIM_SHORT[d] ?? d).join(' ')}` : ''
        return (
          <Box flexDirection="row">
            <Text color="claude">{isSelected ? '› ' : isLit ? '· ' : '  '}</Text>
            <Text bold={isSelected} inverse={isLit && !isSelected}>
              {pad(r.id, 6)}
            </Text>
            <Text color={r.color}>{pad(`${r.glyph} ${r.state}`, 14)}</Text>
            <Text dimColor={r.attempt === 0}>{pad(tries, 6)}</Text>
            <Text color={r.commit ? 'yellow' : undefined} dimColor={!r.commit}>
              {pad(r.commit ?? '·', 9)}
            </Text>
            <Text color={failing ? 'error' : undefined}>{pad(failing, 13)}</Text>
            <Text dimColor={r.state === 'waiting'} wrap="truncate-end">
              {r.earlier ? `${r.title} (landed in ${r.earlier})` : r.title}
            </Text>
          </Box>
        )
      })}
      <Text dimColor>{'  click a gate, then ↑↓ ⏎ for its detail · PA plan adherence · TG tests green · NR no regressions · RU rules'}</Text>
    </Box>
  )
}

export default Gates
