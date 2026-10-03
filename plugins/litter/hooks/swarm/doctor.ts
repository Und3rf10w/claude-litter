// WP-J: the health check the builder, Launch and /litter-doctor share (15.7):
// one row per check, each value's process and settings sources apart, and the
// snippet for what falls short. It writes no file.
//
// Stub (phase 2b-1, package C): the signature is the contract; the body is J's.

import type { Ports } from '../ports'
import type { HealthInput, HealthReport } from './types'

export async function checkHealth(p: Ports, input: HealthInput): Promise<HealthReport> {
  throw new Error('litter: checkHealth is not built yet (WP-J)')
}
