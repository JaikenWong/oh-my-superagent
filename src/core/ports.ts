/** The Engine's ports: what it reads and what it asks adapters to do. Adapters do external work only after commit. */
import type {
  ActorRef, Capability, ChannelRef, Decision, Disposition, Evaluation, Mandate, MandateBasis, Strength, Thread, Ticket, Trigger,
} from './model.ts'
import type { Reason } from './reasons.ts'

export interface Repositories {
  /** Runs `fn` in one transaction; nested calls are savepoints. */
  atomic<T>(fn: () => T): T
  /** Runs `fn` once the outermost transaction commits, never after a rollback. */
  afterCommit(fn: () => void): void
  triggers: {
    get(id: string): Trigger | undefined
    save(trigger: Trigger): void
    disposition(id: string): Disposition | undefined
    saveDisposition(id: string, disposition: Disposition): void
    onThread(key: string, limit?: number): Trigger[]
  }
  threads: { get(key: string): Thread | undefined; save(thread: Thread): void; active(): Thread[] }
  tickets: { get(id: string): Ticket | undefined; save(ticket: Ticket): void; open(): Ticket[] }
  decisions: { get(id: string): Decision | undefined; save(decision: Decision): void; onThread(key: string): Decision[] }
  /** The append-only event log. */
  events: { append(type: string, data: Record<string, unknown>): void }
}

export type GateResult = { admissible: true; strength: Strength; basis: MandateBasis } | { admissible: false; reason: string }

/** The current Policy: a fresh, stateless view of the settings that authorize work. */
export interface Policy {
  version: string
  paused: boolean
  evalTimeoutMs: number
  gate(trigger: Trigger, thread: Thread, tickets: Ticket[]): GateResult
  /** Whether a Mandate still holds before its ended Ticket resumes. */
  revalidate(mandate: Mandate): boolean
  /** Inferred work is accepted only in `auto` mode, on enabled rules. */
  admitsInferred(rules: string[]): boolean
}

/** Whether a Source still listens where a Trigger was received, and whether it receives every message there. */
export interface SourceScope { scope(trigger: Pick<Trigger, 'source' | 'meta'>): { listened: boolean; observed: boolean } }

export interface TicketCard { id: string; title: string; stage: string; scope: string; capability: Capability }
/** What the Router reads to judge one Eval. */
export interface Candidate {
  evalId: string
  thread: Pick<Thread, 'key' | 'meta'>
  triggers: Trigger[]
  primary: string
  strength: Strength
  actor: ActorRef
  tickets: TicketCard[]
  handbacks: { triggerId: string; ticketId: string; reason: string }[]
  policyVersion: string
}

export type AssessmentOutcome =
  | { kind: 'accept'; title: string; scope: string; capability: Capability; reason: string | Reason; acknowledgement?: string; rules?: string[]; name?: string; audit?: Record<string, unknown> }
  | { kind: 'ignore'; reason: string | Reason; audit?: Record<string, unknown> }
  | { kind: 'stop'; ticketId?: string; reason: string | Reason }
  | { kind: 'unavailable'; reason: string | Reason; audit?: Record<string, unknown> }

/**
 * The Main Session (Router) port. Asked inside the transaction; work runs after commit.
 * Candidates, worker reports and owned follow-ups are injected into the Router Session; it answers through Engine tools.
 */
export interface Assessor {
  request(evalId: string): void
  /** A worker reported; the Router should speak (or stay quiet) from the structured report. */
  relayReport?(ticketId: string, assignmentId: string): void
  /** A person's follow-up a Ticket owns; the Router may only stop. */
  relayFollowup?(triggerId: string): void
}

/** What the Main Session queues when it speaks for a Ticket. */
export interface ReplyRequest {
  id: string
  ticketId: string
  purpose: Exclude<Purpose, 'pull_request'>
  text: string
  replyTo?: string
  channel?: ChannelRef
}

/** The Executor's port: each call queues durable work that runs after commit. */
export interface Executor {
  start(ticketId: string): void
  wake(ticketId: string): void
  stop(ticketId: string): void
}

export type Purpose = 'acknowledgement' | 'answer' | 'result' | 'attention' | 'pull_request'
export interface OutgoingMessage {
  id: string
  ticketId?: string
  purpose: Purpose
  channel: ChannelRef
  text: string
  /** The Trigger it answers, whose message it replies under. */
  replyTo?: string
  /** Platform idempotency; defaults to `id` when omitted. */
  idempotencyKey?: string
  /** For `pull_request`: the branch and texts the host opens it with once a person approves. */
  pullRequest?: { branch: string; base: string; title: string; body: string; directory: string }
}
/** Every external write goes through the Outbox: stored first, sent afterwards, in order per Ticket and conversation. */
export interface Outbox { send(message: OutgoingMessage): void }
