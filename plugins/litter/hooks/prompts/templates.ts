// The author's section templates, one per deliverable (COMMON decision 13),
// ported from deepwork's templates/synthesis/. Owner: phase 4, WP-BF.
// run.start passes the deliverable's as args.template, and design.js gives it
// to the author as its template tag, leaving the tag out when it's empty. A
// prompt file: no backtick and no dollar-brace in any text here.

import type { Deliverable } from '../records/run'

// deepwork's impl-plan.md. Its execution manifest becomes the record's gates:
// renderProposal appends them under a Gates heading, so the prose has none,
// and each gate's plan_section names one of these headings (decision 6).
const PLAN = `Sections for a plan. Write your text under one level-1 title naming what the plan changes, with these level-2 sections in this order. Keep a section that has nothing to hold, saying so in one line, so the reader knows it was considered.

## Problem
What changes and why, and what holds once it's done.

## Context
The system as it is today, with evidence: what exists, what the design builds on, and the constraints that bound it.

## Design
The mechanism, concrete enough to implement from: data structures, interfaces, control flow, and every file it touches, as links, with new files marked new. Give each part that a gate implements its own level-3 heading.

## Decisions and alternatives
Each choice made, the alternative weighed and why it lost, each report you overruled with the reason, and each choice left to the user with the option this plan is written on.

## Failure modes
A table of trigger, consequence, how the design handles it, and evidence, for the cases that apply.

## Rollout
The order the gates land in, what keeps working between them, and what ships default-off.

## Residual unknowns
Each open question: why it's still open, how to resolve it, and whether what depends on it ships default-off.

The gates aren't part of your text. Don't write a Gates section or a gate heading such as ### G1: Title anywhere in it. Give the gates in the record's gates field: the plugin appends them after your text, under a Gates heading, in the format the execute run reads. Each gate's plan_section is the heading it implements, written as the heading's text without the # marks, such as Design or one of its level-3 headings; a plan_section that names no heading of your text is refused.`

// deepwork's research.md.
const RESEARCH = `Sections for research. Write your text under one level-1 title naming the question, with these level-2 sections in this order. Keep a section that has nothing to hold, saying so in one line, so the reader knows it was considered.

## Question
The question investigated, why it matters, and what decision or action depends on the answer.

## Method
Where the run looked and why: the starting points, the sources read, the commands run, and what was out of scope.

## Findings
One level-3 heading per finding, then the claim in one checkable sentence, its evidence, and its confidence (high, medium or low) with what it rests on; a null gives the inventory of where it was looked for.

## How the findings relate
Where findings confirm, contradict or extend each other, with the evidence; a contradiction stays visible rather than being settled quietly.

## Open questions
Each question the investigation opened and didn't close: why it matters, and what would close it.

Research delivers findings, not an implementation plan. Give no gates, since the record refuses them for this kind, and put a change the findings call for in one line under Open questions, as a follow-up.`

// deepwork's audit.md.
const AUDIT = `Sections for an audit. Write your text under one level-1 title naming what was audited, with these level-2 sections in this order. Keep a section that has nothing to hold, saying so in one line, so the reader knows it was considered.

## Scope and constraints
What was audited and what wasn't, the constraints on the audit (read-only access, no live testing, a time limit), and why they matter for reading the findings.

## Summary
Three to five sentences: the overall security posture, the most serious findings, and the order to fix them in.

## Findings
One level-3 heading per finding, an id and a short title, then: severity (critical, high, medium, low or informational); a CVSS score and a CWE id, or not applicable with the reason; the location, as a link with its line; the affected component; how it's triggered and what an attacker gains; the evidence; the mitigation, concrete, and whether it changes code, configuration, process or architecture; and the risk left after it, reasoned rather than unverified.

## Attack surface
A table of each component, its entry points, the trust boundary crossed, and the findings that touch it.

## Remediation order
The findings in the order to fix them, each with why it comes there.

## Open questions
What the audit couldn't settle within its constraints, and what would settle it.

An audit delivers findings, not an implementation plan. Give no gates, since the record refuses them for this kind; fixing the findings is a later run that starts from this audit.`

// deepwork's review.md. Its disposition is about the reviewed work, so it
// keeps clear of the critic's APPROVED and HOLDING.
const REVIEW = `Sections for a review. Write your text under one level-1 title naming what was reviewed, with these level-2 sections in this order. Keep a section that has nothing to hold, saying so in one line, except Strengths, which you leave out rather than pad.

## Scope
What was reviewed (a change, a module, an interface or a design document), what was out of scope, and the questions the review set out to answer.

## Disposition
Approve, approve with changes, or request changes, with two or three sentences on the main concern behind it and what would change it.

## Findings
One level-3 heading per finding, an id and a short title, then: severity (blocking, non-blocking or informational); kind (correctness, design, maintainability, performance, test coverage or style); the location, as a link with its line; what was observed, as fact; why it matters; and the change you recommend, specific enough to act on, with the options and their trade-offs when there are several.

## Strengths
Specific things done well that are worth repeating elsewhere.

## What would change the disposition
For approve with changes or request changes: each condition that would make it approve, with the blocking findings it addresses.

A review delivers findings on what it reviewed, not an implementation plan. Give no gates, since the record refuses them for this kind, and label a finding outside the scope as out of scope rather than folding it in.`

/** Each deliverable's section template, given to the author as its template tag (decision 13). */
export const TEMPLATES: Readonly<Record<Deliverable, string>> = {
  plan: PLAN,
  research: RESEARCH,
  audit: AUDIT,
  review: REVIEW,
}
