// WP-N: the swarm tree as a Client surface module (15.5): click to select,
// right-click for add child, add worker, duplicate, delete and move, keys
// ↑↓ ⏎ a d x, each pick posted to ui.message (surface.post). Referenced by
// path, `module="./swarm/tree.tsx"`, relative to register.tsx; it runs on
// the drawing thread and imports types only.
//
// Stub (phase 2b-1, package C): the smallest valid Client module; the body is N's.

import type { ClientModule } from 'claude-code'

const Tree: ClientModule = (props, surface) => {
  const { Text } = surface.elements
  return <Text>litter: not built yet</Text>
}

export default Tree
