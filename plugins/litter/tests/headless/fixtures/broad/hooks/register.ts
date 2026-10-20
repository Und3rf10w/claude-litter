import type { Register } from 'claude-code'

// Matches every tool and changes nothing: enough to hop each call through the
// hooks worker and lose an isolated agent's working directory (plan section 14).
export const register: Register = on => {
  on('tool.call', ($, e, next) => next(e))
}
