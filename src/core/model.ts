/**
 * Domain model, after docs/001: the concepts and the rules each keeps, independent of any Source, Policy or Executor.
 * Nothing here does I/O.
 */
import type { Reason } from './reasons.ts'

/** An actor in its Source's own identities; identities on different Sources are never mapped to each other. */
export interface ActorRef { source: string; id: string; name?: string }
/** Thread identity; which events form one Thread is the Source's rule. */
export interface ThreadRef { source: string; id: string }
/** The write side of a Thread; the address format belongs to the Source. */
export interface ChannelRef { source: string; thread: string; address: Record<string, string> }

export const threadKey = (ref: ThreadRef): string => `${ref.source}:${ref.id}`
export function parseThreadKey(key: string): ThreadRef {
  const at = key.indexOf(':')
  return { source: key.slice(0, at), id: key.slice(at + 1) }
}
/** Normalizes timestamps so they compare as text. */
export function isoTime(value: string): string {
  const time = Date.parse(value)
  return Number.isFinite(time) ? new Date(time).toISOString() : value
}

export type Addressed = 'mention' | 'direct'

/** One immutable event from a Source. `text` and `meta` are untrusted data. */
export interface Trigger {
  id: string
  source: string
  /** Every Thread it belongs to; `threads[0]` is the primary one, which hosts its Eval. */
  threads: ThreadRef[]
  actor: ActorRef
  /** Written by a person, not a bot, CI or this agent. */
  human: boolean
  /** The sender addressed the agent: by mention or command, or in a direct message. */
  addressed?: Addressed
  at: string
  text: string
  channel?: ChannelRef
  url?: string
  meta: Record<string, unknown>
}

/** Where a Trigger went. It grants nothing, but decides who decides a person's follow-up. */
export interface Disposition {
  filtered?: Reason
  evalId?: string
  decisionId?: string
  /** Tickets it reached by Subscription fan-out. */
  fanout: string[]
  requeued?: true
  handbacks?: { ticketId: string; reason: string; at: string }[]
  /** Tickets whose worker took it up as within scope. */
  acked?: string[]
  at: string
}

export type Strength = 'explicit' | 'inferred'
export type AcceptMode = 'off' | 'observe' | 'auto'
export type AdmissionCell = 'listedUnaddressed' | 'unlistedAddressed' | 'unlistedUnaddressed'
/** How the gate admitted the Trigger a Mandate came from; `revalidate` checks it again before a resume. */
export type MandateBasis = { source: string; sender?: string; rules?: string[] } & (
  | { via: 'addressed'; addressed: Addressed }
  | { via: 'followup' }
  | { via: 'admission'; cell: AdmissionCell; observation?: { mode: AcceptMode } }
  | { via: 'bot'; observation: { mode: AcceptMode } }
)
/** How far the work may go: `read` analyses and answers, `write` may change code and propose a pull request. */
export type Capability = 'read' | 'write'

/** What an accept grants. Immutable: wider scope means a new Ticket. */
export interface Mandate {
  strength: Strength
  policyVersion: string
  basis: MandateBasis
  actor: ActorRef
  scope: string
  capability: Capability
}

/** The Eval running on a Thread; at most one per Thread. */
export interface Evaluation {
  id: string
  threadKey: string
  triggerIds: string[]
  /** The admissible Trigger that gave the batch its strength. */
  primary: string
  strength: Strength
  actor: ActorRef
  basis: MandateBasis
  policyVersion: string
  startedAt: string
  deadline: string
  pausedAt?: string
}

/** Thread aggregate: Eval runs serially on it; it holds its Subscriptions and its queued Triggers. */
export interface Thread {
  key: string
  ref: ThreadRef
  createdAt: string
  lastAt?: string
  subscriptions: string[]
  /** Threads that shared a Trigger with this one: context only, never routes. */
  correlated: string[]
  /** Triggers waiting for the next Eval; those arriving during an Eval form the next batch. */
  pending: string[]
  evaluating?: Evaluation
  /** Evals of its queued Triggers that expired in a row. */
  expired?: number
  /** Source-owned: `label`, `url`, and what its Channel needs. */
  meta: Record<string, unknown>
}

export type DecisionKind = 'accept' | 'ignore' | 'stop' | 'unavailable'
export interface Decision {
  id: string
  evalId: string
  threadKey: string
  triggerIds: string[]
  policyVersion: string
  at: string
  kind: DecisionKind
  reason: Reason[]
  strength: Strength
  ticketId?: string
  mandate?: Mandate
  /** Assessor audit: rule judgements, direction, evidence, `would_accept` in observe mode. */
  audit?: Record<string, unknown>
  dismissed?: true
}

export type AssignmentState = 'pending' | 'running' | 'ended'
export type ReportState = 'progress' | 'waiting' | 'ready' | 'blocked' | 'failed' | 'dropped'
/** Worker report facts. Outbound text stays here until the Main Session (Router) speaks via `Engine.reply`. */
export interface Report {
  state: ReportState
  summary: string
  at: string
  reply?: string
  replyTo?: string
  question?: string
  questionTo?: string
  /** The Main Session has already drafted outbound for this report. */
  spoken?: true
}
/** Binding of a Ticket to one Executor run; it has its own lifecycle, independent of the Ticket's. */
export interface Assignment {
  id: string
  state: AssignmentState
  createdAt: string
  startedAt?: string
  endedAt?: string
  endedReason?: string
  report?: Report
  turns: number
  /** Inputs the running turn took; a turn the host cut off gives them back. */
  taking?: string[]
  /** Told to the worker first, such as after a host restart. */
  recovery?: string
}

export type TicketInput =
  | { id: string; kind: 'trigger'; triggerId: string; at: string; human?: true }
  /** Text a person wrote in the panel, taking over the work. */
  | { id: string; kind: 'text'; text: string; at: string; human: true }
  | { id: string; kind: 'resumed'; triggerId: string; at: string }
  | { id: string; kind: 'policy-changed'; from: string; to: string; at: string; effect: PolicyEffect }
  | { id: string; kind: 'note'; text: string; at: string }

/** How a Policy change bears on a live Ticket. */
export interface PolicyEffect {
  rules?: { id: string; change: 'changed' | 'disabled'; instruction?: string }[]
  proactive?: false
  requesterAllowed?: false
}

export type TicketEndBy = 'executor' | 'human' | 'host'
export type TicketOutcome = 'completed' | 'merged' | 'closed' | 'dropped' | 'stopped'
/** A question for a person; `triggerId` names the message that raised it, whose conversation it goes back to. */
export interface Attention { id: string; question: string; triggerId?: string; at: string }
/** A Thread a Source made the Ticket follow, such as its pull request; `own` when the Ticket opened it. */
export interface Follow { thread: string; own: boolean; url?: string; closed?: { at: string; outcome: 'merged' | 'closed' } }
export interface Artifact { id: string; kind: 'diff' | 'log' | 'prompt' | 'tests'; assignmentId: string; turn: number; path: string; summary?: string; at: string }
export interface Execution { directory: string; branch: string; base: string; session: string; backend: string }

/** Ticket aggregate: one unit of authorized work. Only Eval creates one. */
export interface Ticket {
  id: string
  /** Short name: its directory and branch. */
  name: string
  title: string
  decisionId: string
  mandate: Mandate
  channels: ChannelRef[]
  ended?: { at: string; by: TicketEndBy; outcome: TicketOutcome; reason?: string }
  attention?: Attention
  assignments: Assignment[]
  inputs: TicketInput[]
  undelivered: string[]
  follows: Follow[]
  artifacts: Artifact[]
  /** A pull request the worker proposed, waiting in the Outbox for a person. */
  proposal?: { messageId: string; branch: string; title: string }
  origin: { triggerId: string; triggerIds: string[] }
  execution?: Execution
  /** The latest failed delivery, until a delivery succeeds. */
  delivery?: { error: string; at: string }
  createdAt: string
  updatedAt: string
}

export const liveTicket = (ticket: Pick<Ticket, 'ended'>): boolean => !ticket.ended
export const latestAssignment = (ticket: Pick<Ticket, 'assignments'>): Assignment | undefined => ticket.assignments.at(-1)
export const runningAssignment = (ticket: Pick<Ticket, 'assignments'>): Assignment | undefined =>
  ticket.assignments.find(assignment => assignment.state === 'running')
export const latestReport = (ticket: Pick<Ticket, 'assignments'>): Report | undefined =>
  ticket.assignments.findLast(assignment => assignment.report)?.report

/**
 * The latest Assignment reported blocked or failed and no person wrote since. Automatic Inputs stay held while it holds;
 * a person's message, a later report, or a retry lifts it.
 */
export function waitsForPerson(ticket: Ticket): boolean {
  const report = latestAssignment(ticket)?.report
  if (report?.state !== 'blocked' && report?.state !== 'failed') return false
  return !ticket.inputs.some(input => (input.kind === 'trigger' || input.kind === 'text') && input.human && input.at > report.at)
}

/** Done with the Threads it follows: none of its own is open, or, owning none, every followed one closed. */
export function followsDone(ticket: Pick<Ticket, 'follows'>): boolean {
  const own = ticket.follows.filter(follow => follow.own)
  if (own.length) return own.every(follow => follow.closed)
  return ticket.follows.length > 0 && ticket.follows.every(follow => follow.closed)
}
