// The board's gate table as a Client surface module (plan section 11): ↑↓
// select a row and Enter shows its detail, posted to the hooks module
// (surface.post, a ui.message there). It runs on the drawing thread, imports
// types only, and keeps local state only; no right-click menu (phase 5).
// pane.tsx draws it with `module="./gates.tsx"` (relative to that file).
// Owner: phase 3, package AF.
//
// AA's stub: the rows as text, with no keys and no posts.

import type { ClientModule } from 'claude-code'
import type { BoardGatesProps } from '../../types/index'

const Gates: ClientModule<BoardGatesProps> = (props, surface) => {
  const { Box, Text } = surface.elements
  return (
    <Box flexDirection="column">
      {props.rows.map(r => (
        <Text>{`${r.id}  ${r.state}  ${r.title}`}</Text>
      ))}
    </Box>
  )
}

export default Gates
