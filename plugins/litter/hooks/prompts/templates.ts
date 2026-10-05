// The author's section templates, one per deliverable (COMMON decision 13),
// ported from deepwork's templates/synthesis/. Owner: phase 4, WP-BF.
// run.start passes the deliverable's as args.template, and design.js gives it
// to the author as its template tag, leaving the tag out when it's empty. A
// prompt file: no backtick and no dollar-brace in any text here.

import type { Deliverable } from '../records/run'

/** Stub (WP-BA): each empty, so the author gets no template until WP-BF writes them. */
export const TEMPLATES: Readonly<Record<Deliverable, string>> = {
  plan: '',
  research: '',
  audit: '',
  review: '',
}
