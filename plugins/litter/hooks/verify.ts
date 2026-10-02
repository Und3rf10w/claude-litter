// The `verify` record: snapshot, run the verify argv streamed, log in parts,
// keep the tail, enforce the timeout, snapshot again, record (plan section 9,
// "verify and land records"). Owner: phase 1b, work package C.

import type { RecordHandler } from './records/core'
import { notYet } from './records/core'

export const recordVerify: RecordHandler = async () => notYet('verify', '1b')
