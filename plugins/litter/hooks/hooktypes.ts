// The hook types for each registration in register.tsx. register.tsx holds
// every hook as an inline literal that builds the ports and calls the module's
// handler, typed here as a PortHook: the engine hook's input, `next` and result,
// with the ports in place of `$` (ports.ts says why). A catch never uses `$`,
// so a module exports it with the engine's own catch type.
//
// Contract owner: phase 1a.

import type { CatchHandler, Hook, MatchedHook } from 'claude-code'
import type { Ports } from './ports'

type AnyHook = (...args: any[]) => any

/** An engine hook with the ports in place of `$`. */
export type PortHook<H extends AnyHook> = (p: Ports, e: Parameters<H>[1], next: Parameters<H>[2]) => ReturnType<H>

export type RecordHook = MatchedHook<'tool.call', { readonly tool: 'mcp__litter__record' }>
export type RecordCatch = CatchHandler<RecordHook>
export type WorkflowHook = MatchedHook<'tool.call', { readonly tool: 'Workflow' }>
export type WorkflowCatch = CatchHandler<WorkflowHook>
export type TaskStopHook = MatchedHook<'tool.call', { readonly tool: 'TaskStop' }>
export type TaskStopCatch = CatchHandler<TaskStopHook>
export type SpawnHook = Hook<'agent.spawn'>
export type SpawnCatch = CatchHandler<SpawnHook>
export type PromptSubmitHook = Hook<'prompt.submit'>
export type TurnCompleteHook = Hook<'turn.complete'>
export type SessionEndHook = Hook<'session.end'>
