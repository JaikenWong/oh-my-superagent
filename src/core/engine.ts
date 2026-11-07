/**
 * The Engine is the only writer of Triggers, Threads, Decisions, Tickets and Assignments. Every command runs in one
 * transaction; ports queue external work inside it and adapters perform that work after commit. Methods are synchronous.
 */
import { UserError } from './errors.ts'
import { key, slug } from './ids.ts'
import {
  followsDone, isoTime, latestAssignment, liveTicket, threadKey, waitsForPerson,
  type Artifact, type Assignment, type Decision, type Evaluation, type Execution, type Mandate, type PolicyEffect, type ReportState,
  type Strength, type Thread, type ThreadRef, type Ticket, type TicketEndBy, type TicketInput, type TicketOutcome, type Trigger,
} from './model.ts'
import type { AssessmentOutcome, Assessor, Candidate, Executor, Outbox, Policy, Repositories, ReplyRequest, SourceScope, TicketCard } from './ports.ts'
import { said, type Reason } from './reasons.ts'
import { stageLabel, ticketStage, canRetry } from './stage.ts'

export interface EngineDeps {
  repo: Repositories
  policy: () => Policy
  scope: SourceScope
  assessor: Assessor
  executor: Executor
  outbox: Outbox & { withdrawDrafts(ticketId: string, reason: string): void }
  now?: () => string
  /** Called after commit for each domain event, which the event log already holds. */
  emit?: (type: string, data: Record<string, unknown>) => void
}

/** What a worker says at the end of a turn. Only structured fields drive the host; free text is never parsed for intent. */
export interface WorkerReport {
  state: ReportState
  summary: string
  /** A message for the conversation: an answer to `replyTo`, or the result. */
  reply?: string
  replyTo?: string
  /** One concrete question for a person, asked where `questionTo` was written, or in the original conversation. */
  question?: string
  questionTo?: string
  /** A pull request to propose; only a `write` Mandate with a `ready` report may. */
  pullRequest?: { title: string; body: string }
  /** Messages beyond this Ticket's scope, handed back once for routing. */
  handbacks?: { triggerId: string; reason: string }[]
  /** Messages taken up as within scope. */
  acked?: string[]
}
export interface TurnResult {
  report?: WorkerReport
  error?: string
  /** The worker never saw the Inputs the turn took, such as when its directory could not be prepared. */
  unread?: true
  artifacts?: Pick<Artifact, 'kind' | 'path' | 'summary'>[]
}

export type ReceiveResult = 'stored' | 'duplicate' | 'filtered'
type Outcome = AssessmentOutcome & { evalId?: string }

/** How many times in a row an expired Eval queues its Triggers again before it is recorded unavailable. */
const REQUEUES = 2
const RECOVERY = 'The host restarted while your previous turn ran. Check your directory, git history and the conversation before repeating any outside action.'
const reasonOf = (reason: string | Reason): Reason[] => [typeof reason === 'string' ? said(reason) : reason]
const stronger = (a: Strength, b: Strength): boolean => a === 'explicit' && b !== 'explicit'

export class Engine {
  readonly #d: EngineDeps
  #last = 0

  constructor(deps: EngineDeps) { this.#d = deps }

  get #repo(): Repositories { return this.#d.repo }

  /** Strictly increasing time, so that "after the report" comparisons hold within one millisecond. */
  #now(): string {
    if (this.#d.now) return this.#d.now()
    this.#last = Math.max(Date.now(), this.#last + 1)
    return new Date(this.#last).toISOString()
  }
  #emit(type: string, data: Record<string, unknown>): void {
    this.#repo.events.append(type, data)
    const emit = this.#d.emit
    if (emit) this.#repo.afterCommit(() => emit(type, data))
  }
  #thread(ref: ThreadRef): Thread {
    const k = threadKey(ref)
    return this.#repo.threads.get(k) ?? { key: k, ref, createdAt: this.#now(), subscriptions: [], correlated: [], pending: [], meta: {} }
  }
  #ticket(id: string): Ticket {
    const ticket = this.#repo.tickets.get(id)
    if (!ticket) throw new UserError('missing', { ticket: id })
    return ticket
  }
  #save(ticket: Ticket): void {
    ticket.updatedAt = this.#now()
    this.#repo.tickets.save(ticket)
  }

  // ── Sources ────────────────────────────────────────────────────────────────

  /**
   * Stores a Trigger once. It fans out to the Tickets subscribed to its Threads; a person's message resumes an ended Ticket
   * unless a person stopped it. A person's message that reached a Ticket is that Ticket's to decide and takes no Eval;
   * everything else queues for Eval on its primary Thread.
   */
  receive(input: Trigger): ReceiveResult {
    return this.#repo.atomic(() => {
      const trigger = { ...input, at: isoTime(input.at) }
      if (!trigger.threads.length) throw new Error('A Trigger belongs to at least one Thread')
      if (this.#repo.triggers.get(trigger.id)) return 'duplicate'
      const at = this.#now()
      this.#repo.triggers.save(trigger)
      if (!this.#d.scope.scope(trigger).listened) {
        this.#repo.triggers.saveDisposition(trigger.id, { filtered: { code: 'source_off' }, fanout: [], at })
        return 'filtered'
      }
      const keys = trigger.threads.map(threadKey)
      const reached = new Map<string, Ticket>()
      for (const ref of trigger.threads) {
        const thread = this.#thread(ref)
        if (!thread.lastAt || trigger.at > thread.lastAt) thread.lastAt = trigger.at
        thread.correlated = [...new Set([...thread.correlated, ...keys.filter(other => other !== thread.key)])]
        for (const id of thread.subscriptions) {
          const ticket = this.#repo.tickets.get(id)
          // Bots and CI do not wake an ended Ticket, and one a person stopped receives nothing.
          if (ticket && (liveTicket(ticket) || (trigger.human && ticket.ended?.by !== 'human'))) reached.set(id, ticket)
        }
        this.#repo.threads.save(thread)
      }
      const fanout: string[] = []
      for (const ticket of reached.values()) {
        if (ticket.ended && !this.#resume(ticket, trigger)) continue
        this.#addInput(ticket, { id: key('input', ticket.id, trigger.id), kind: 'trigger', triggerId: trigger.id, at, ...trigger.human ? { human: true } : {} })
        fanout.push(ticket.id)
      }
      this.#repo.triggers.saveDisposition(trigger.id, { fanout, at })
      this.#emit('trigger.received', { triggerId: trigger.id, threads: keys, human: trigger.human, fanout })
      if (this.#owners(trigger).length) {
        this.#emit('trigger.followup', { triggerId: trigger.id, tickets: fanout })
        this.#d.assessor.relayFollowup?.(trigger.id)
      } else this.#queueForEval(trigger)
      for (const id of fanout) this.#d.executor.wake(id)
      return 'stored'
    })
  }

  /** Source-owned Thread facts, such as its label and URL. */
  describeThread(ref: ThreadRef, meta: Record<string, unknown>): void {
    this.#repo.atomic(() => {
      const thread = this.#thread(ref)
      thread.meta = { ...thread.meta, ...meta }
      this.#repo.threads.save(thread)
    })
  }

  /** Makes a Ticket follow a Thread, such as the pull request it opened (`own`); its close, not a report, ends the Ticket. */
  bindThread(ticketId: string, ref: ThreadRef, own: boolean, url?: string): void {
    this.#repo.atomic(() => {
      const ticket = this.#ticket(ticketId)
      const k = threadKey(ref)
      const follow = ticket.follows.find(item => item.thread === k)
      if (follow) delete follow.closed
      else ticket.follows.push({ thread: k, own, ...url ? { url } : {} })
      if (own) delete ticket.proposal
      this.#subscribe(ticket.id, ref)
      this.#save(ticket)
      this.#emit('thread.bound', { ticketId, thread: k, own })
    })
  }

  /** A followed Thread closed. A Ticket done with its Threads ends as the close did, unless a turn is still running. */
  threadClosed(ref: ThreadRef, outcome: 'merged' | 'closed'): void {
    this.#repo.atomic(() => {
      const k = threadKey(ref)
      const at = this.#now()
      for (const ticket of this.#repo.tickets.open()) {
        const follow = ticket.follows.find(item => item.thread === k)
        if (!follow || follow.closed) continue
        follow.closed = { at, outcome }
        this.#save(ticket)
        if (followsDone(ticket) && !latestAssignment(ticket)?.taking && !ticket.undelivered.length) this.#end(ticket, 'executor', outcome)
      }
    })
  }

  // ── Eval ───────────────────────────────────────────────────────────────────

  /**
   * One pass: expires Evals past their deadline (twice requeued, the third time unavailable) and starts an Eval on each
   * Thread whose Triggers wait, with every Trigger queued meanwhile as one batch.
   */
  evaluateDue(): void {
    const policy = this.#d.policy()
    for (const { key: k } of this.#repo.threads.active()) {
      this.#repo.atomic(() => {
        const thread = this.#repo.threads.get(k)
        if (!thread) return
        if (thread.evaluating) this.#due(thread, policy)
        else if (thread.pending.length && !policy.paused) this.#start(thread, policy)
      })
    }
  }

  /** The Eval `evalId` as the Router sees it, or undefined once it ended. */
  candidate(evalId: string): Candidate | undefined {
    const thread = this.#repo.threads.active().find(item => item.evaluating?.id === evalId)
    const evaluation = thread?.evaluating
    if (!thread || !evaluation) return
    const triggers = evaluation.triggerIds.flatMap(id => this.#repo.triggers.get(id) ?? [])
    return {
      evalId, thread: { key: thread.key, meta: thread.meta }, triggers, primary: evaluation.primary, strength: evaluation.strength,
      actor: evaluation.actor, tickets: this.#ticketsOnThread(thread).map(ticketCard), policyVersion: evaluation.policyVersion,
      handbacks: triggers.flatMap(trigger => (this.#repo.triggers.disposition(trigger.id)?.handbacks ?? [])
        .map(item => ({ triggerId: trigger.id, ticketId: item.ticketId, reason: item.reason }))),
    }
  }

  /**
   * Records the Decision on the Eval that holds a Trigger, or a direct one when none does, which only a stop of an owned
   * follow-up needs. Accept creates the Ticket, Mandate, Subscriptions and Assignment; the Main Session speaks afterwards.
   */
  decide(triggerId: string, outcome: Outcome): Decision {
    return this.#repo.atomic(() => {
      const trigger = this.#repo.triggers.get(triggerId)
      if (!trigger) throw new UserError('missing', { trigger: triggerId })
      const held = this.#holding(trigger)
      if (outcome.evalId && held?.evaluating?.id !== outcome.evalId) throw new UserError('evalFinished', { eval: outcome.evalId })
      // A follow-up a Ticket owns is its worker's to judge: the Router may only stop the work.
      if (outcome.kind !== 'stop' && this.#owners(trigger).length) throw new UserError('ownedByTicket', { trigger: triggerId })
      const policy = this.#d.policy()
      const thread = held ?? this.#thread(trigger.threads[0]!)
      const evaluation = held?.evaluating ?? this.#directEval(thread, trigger, policy)
      if (evaluation.policyVersion !== policy.version) {
        const decision = this.#finish(thread, evaluation, { kind: 'unavailable', reason: { code: 'policyChanged' } })
        this.#requeue(evaluation.threadKey, evaluation.triggerIds)
        return decision
      }
      if (outcome.kind === 'accept') {
        const earlier = this.#accepted(thread.key).get(evaluation.primary)
        if (earlier) {
          if (held) this.#finish(thread, evaluation, { kind: 'ignore', reason: { code: 'startedTicket', values: { ticket: earlier.ticketId! } } })
          return earlier
        }
        if (evaluation.strength !== 'explicit' && !policy.admitsInferred(outcome.rules ?? [])) throw new UserError('notExplicit')
      }
      return this.#finish(thread, evaluation, outcome)
    })
  }

  #due(thread: Thread, policy: Policy): void {
    const evaluation = thread.evaluating!
    const now = this.#now()
    if (evaluation.policyVersion !== policy.version) {
      delete thread.evaluating
      this.#repo.threads.save(thread)
      this.#requeue(thread.key, evaluation.triggerIds)
      this.#emit('eval.discarded', { evalId: evaluation.id, threadKey: thread.key })
    } else if (policy.paused) {
      if (!evaluation.pausedAt) { evaluation.pausedAt = now; this.#repo.threads.save(thread) }
    } else if (evaluation.pausedAt) {
      evaluation.deadline = new Date(Date.parse(evaluation.deadline) + Date.parse(now) - Date.parse(evaluation.pausedAt)).toISOString()
      delete evaluation.pausedAt
      this.#repo.threads.save(thread)
    } else if (evaluation.deadline <= now) {
      const expired = (thread.expired ?? 0) + 1
      if (expired > REQUEUES) { this.#finish(thread, evaluation, { kind: 'unavailable', reason: { code: 'timeout' } }); return }
      delete thread.evaluating
      thread.expired = expired
      thread.pending = [...evaluation.triggerIds, ...thread.pending.filter(id => !evaluation.triggerIds.includes(id))]
      this.#repo.threads.save(thread)
      this.#emit('eval.expired', { evalId: evaluation.id, threadKey: thread.key, expired })
    }
  }

  #start(thread: Thread, policy: Policy): void {
    const at = this.#now()
    // A follow-up a Ticket decides leaves the queue; a Trigger that already started a Ticket cannot start another.
    thread.pending = thread.pending.filter(id => { const trigger = this.#repo.triggers.get(id); return !!trigger && !this.#owners(trigger).length })
    const accepted = this.#accepted(thread.key)
    const started = thread.pending.filter(id => accepted.has(id))
    if (started.length) {
      thread.pending = thread.pending.filter(id => !accepted.has(id))
      this.#record(thread, this.#batch(thread, started, policy, at), 'ignore',
        started.map(id => ({ code: 'startedTicket', triggerId: id, values: { ticket: accepted.get(id)!.ticketId! } })))
    }
    if (!thread.pending.length) { this.#repo.threads.save(thread); return }
    const triggers = thread.pending.flatMap(id => this.#repo.triggers.get(id) ?? [])
    const tickets = this.#ticketsOnThread(thread)
    const reasons: Reason[] = []
    let strongest: { trigger: Trigger; strength: Strength; basis: Evaluation['basis'] } | undefined
    for (const trigger of triggers) {
      const gate = policy.gate(trigger, thread, tickets)
      if (!gate.admissible) { reasons.push({ code: gate.reason, triggerId: trigger.id }); continue }
      // The strongest admissible Trigger gives the batch its strength; among equals, the latest.
      if (!strongest || stronger(gate.strength, strongest.strength) || (gate.strength === strongest.strength && trigger.at >= strongest.trigger.at)) {
        strongest = { trigger, strength: gate.strength, basis: gate.basis }
      }
    }
    const triggerIds = thread.pending
    thread.pending = []
    if (!strongest) {
      this.#record(thread, this.#batch(thread, triggerIds, policy, at), 'ignore', reasons.length ? reasons : [{ code: 'noAdmissible' }])
      this.#repo.threads.save(thread)
      return
    }
    const evaluation: Evaluation = {
      id: key('eval', thread.key, policy.version, at, triggerIds), threadKey: thread.key, triggerIds, primary: strongest.trigger.id,
      strength: strongest.strength, actor: strongest.trigger.actor, basis: strongest.basis, policyVersion: policy.version, startedAt: at,
      deadline: new Date(Date.parse(at) + policy.evalTimeoutMs).toISOString(),
    }
    thread.evaluating = evaluation
    this.#repo.threads.save(thread)
    for (const id of triggerIds) this.#dispose(id, { evalId: evaluation.id })
    this.#emit('eval.started', { evalId: evaluation.id, threadKey: thread.key, triggerIds, strength: evaluation.strength })
    this.#d.assessor.request(evaluation.id)
  }

  /** A transient Eval of Triggers no assessor judges, so their Decision has the same shape as every other. */
  #batch(thread: Thread, triggerIds: string[], policy: Policy, at: string): Evaluation {
    const first = this.#repo.triggers.get(triggerIds[0]!)!
    return {
      id: key('eval', thread.key, policy.version, at, triggerIds, 'gate'), threadKey: thread.key, triggerIds, primary: first.id,
      strength: 'inferred', actor: first.actor, basis: { source: first.source, via: 'followup' }, policyVersion: policy.version, startedAt: at, deadline: at,
    }
  }
  #directEval(thread: Thread, trigger: Trigger, policy: Policy): Evaluation {
    const gate = policy.gate(trigger, thread, this.#ticketsOnThread(thread))
    if (!gate.admissible) throw new UserError('notAdmissible', { reason: gate.reason })
    const at = this.#now()
    return {
      id: key('eval', thread.key, 'direct', trigger.id, at), threadKey: thread.key, triggerIds: [trigger.id], primary: trigger.id,
      strength: gate.strength, actor: trigger.actor, basis: gate.basis, policyVersion: policy.version, startedAt: at, deadline: at,
    }
  }
  #record(thread: Thread, evaluation: Evaluation, kind: Decision['kind'], reason: Reason[], extra: Partial<Decision> = {}): Decision {
    const decision: Decision = {
      id: key('decision', evaluation.id), evalId: evaluation.id, threadKey: thread.key, triggerIds: evaluation.triggerIds,
      policyVersion: evaluation.policyVersion, at: this.#now(), kind, reason, strength: evaluation.strength, ...extra,
    }
    this.#repo.decisions.save(decision)
    for (const id of evaluation.triggerIds) this.#dispose(id, { decisionId: decision.id })
    this.#emit('decision.recorded', { decisionId: decision.id, kind, threadKey: thread.key, ticketId: decision.ticketId, triggerIds: evaluation.triggerIds })
    return decision
  }
  #finish(thread: Thread, evaluation: Evaluation, outcome: AssessmentOutcome): Decision {
    if (thread.evaluating?.id === evaluation.id) delete thread.evaluating
    delete thread.expired
    this.#repo.threads.save(thread)
    const audit = 'audit' in outcome && outcome.audit ? { audit: outcome.audit } : {}
    let reason = reasonOf(outcome.reason)
    const extra: Partial<Decision> = { ...audit }
    if (outcome.kind === 'accept') {
      const ticket = this.#createTicket(evaluation, outcome)
      Object.assign(extra, { ticketId: ticket.id, mandate: ticket.mandate })
    } else if (outcome.kind === 'stop') {
      if (evaluation.strength !== 'explicit') reason = [{ code: 'stopNotExplicit' }]
      else {
        const targets = outcome.ticketId ? [this.#ticket(outcome.ticketId)].filter(liveTicket)
          : this.#ticketsOnThread(this.#repo.threads.get(thread.key) ?? thread).filter(liveTicket)
        if (!targets.length) reason = [...reason, { code: 'nothingToStop' }]
        for (const ticket of targets) {
          this.#end(ticket, 'human', 'stopped', reasonText(reason), evaluation.primary)
          this.#d.outbox.withdrawDrafts(ticket.id, 'ticketStopped')
        }
        if (targets[0]) extra.ticketId = targets[0].id
      }
    }
    return this.#record(thread, evaluation, outcome.kind, reason, extra)
  }

  #createTicket(evaluation: Evaluation, outcome: Extract<AssessmentOutcome, { kind: 'accept' }>): Ticket {
    const at = this.#now()
    const primary = this.#repo.triggers.get(evaluation.primary)!
    const id = key('t', primary.id)
    const mandate: Mandate = {
      strength: evaluation.strength, policyVersion: evaluation.policyVersion,
      basis: outcome.rules?.length ? { ...evaluation.basis, rules: outcome.rules } : evaluation.basis,
      actor: evaluation.actor, scope: outcome.scope, capability: outcome.capability,
    }
    const ticket: Ticket = {
      id, name: `${slug(outcome.name ?? outcome.title)}-${id.slice(-4)}`, title: outcome.title, decisionId: key('decision', evaluation.id), mandate,
      channels: primary.channel ? [primary.channel] : [], assignments: [newAssignment(id, 0, at)], inputs: [], undelivered: [],
      follows: [], artifacts: [], origin: { triggerId: primary.id, triggerIds: evaluation.triggerIds }, createdAt: at, updatedAt: at,
    }
    this.#repo.tickets.save(ticket)
    const refs = new Map<string, ThreadRef>()
    for (const triggerId of evaluation.triggerIds) for (const ref of this.#repo.triggers.get(triggerId)?.threads ?? []) refs.set(threadKey(ref), ref)
    for (const ref of refs.values()) this.#subscribe(id, ref)
    this.#emit('ticket.created', { ticketId: id, title: ticket.title, capability: mandate.capability, strength: mandate.strength, acknowledgement: outcome.acknowledgement ?? '' })
    this.#d.executor.start(id)
    return ticket
  }

  /**
   * The Main Session speaks for a Ticket. Worker reports never write the Channel themselves; only this path and a pull
   * request proposal (host-owned) go through the Outbox.
   */
  reply(request: ReplyRequest): void {
    this.#repo.atomic(() => {
      const ticket = this.#ticket(request.ticketId)
      const channel = request.channel ?? this.#channelFor(ticket, request.replyTo)
      if (!channel) throw new UserError('missing', { channel: request.ticketId })
      this.#d.outbox.send({
        id: request.id, ticketId: ticket.id, purpose: request.purpose, channel, text: request.text,
        ...request.replyTo ? { replyTo: request.replyTo } : {},
      })
      const assignment = latestAssignment(ticket)
      if (assignment?.report && (request.purpose === 'answer' || request.purpose === 'result' || request.purpose === 'attention')) {
        assignment.report.spoken = true
        this.#save(ticket)
      }
      this.#emit('router.replied', { ticketId: ticket.id, purpose: request.purpose, messageId: request.id })
    })
  }

  /** A fact from the Main Session or Watchdog for a Ticket's worker; grants no authority. */
  note(ticketId: string, text: string): void {
    this.#repo.atomic(() => {
      const ticket = this.#ticket(ticketId)
      if (ticket.ended) throw new UserError('ended', { ticket: ticketId })
      const at = this.#now()
      this.#addInput(ticket, { id: key('input', ticketId, 'note', at), kind: 'note', text: text.slice(0, 4000), at })
      this.#d.executor.wake(ticketId)
    })
  }

  // ── Executor ───────────────────────────────────────────────────────────────

  /** An Assignment starts: its first turn takes the waiting Inputs. Undefined when the Assignment is no longer pending. */
  assignmentStarted(ticketId: string, assignmentId: string, execution: Execution): TicketInput[] | undefined {
    return this.#repo.atomic(() => {
      const ticket = this.#ticket(ticketId)
      const assignment = ticket.assignments.find(item => item.id === assignmentId)
      if (ticket.ended || assignment?.state !== 'pending') return undefined
      assignment.state = 'running'
      assignment.startedAt = this.#now()
      ticket.execution = execution
      const inputs = this.#take(ticket, assignment)
      this.#save(ticket)
      this.#emit('assignment.started', { ticketId, assignmentId, directory: execution.directory })
      return inputs
    })
  }

  /** The next turn of an idle running Assignment takes the waiting Inputs; undefined when nothing may be delivered now. */
  takeInputs(ticketId: string, assignmentId: string): TicketInput[] | undefined {
    return this.#repo.atomic(() => {
      const ticket = this.#ticket(ticketId)
      const assignment = ticket.assignments.find(item => item.id === assignmentId)
      if (ticket.ended || assignment?.state !== 'running' || assignment.taking || !ticket.undelivered.length || waitsForPerson(ticket)) return undefined
      const inputs = this.#take(ticket, assignment)
      delete ticket.delivery
      this.#save(ticket)
      return inputs
    })
  }

  /** Delivering Inputs failed; the Ticket shows it until a delivery succeeds, a retry, or its end. */
  deliveryFailed(ticketId: string, assignmentId: string, error: string): void {
    this.#repo.atomic(() => {
      const ticket = this.#ticket(ticketId)
      const assignment = ticket.assignments.find(item => item.id === assignmentId)
      if (ticket.ended || !assignment) return
      if (assignment.taking) { ticket.undelivered = [...assignment.taking, ...ticket.undelivered]; delete assignment.taking }
      ticket.delivery = { error: error.slice(0, 1000), at: this.#now() }
      this.#save(ticket)
      this.#emit('delivery.failed', { ticketId, assignmentId, error: ticket.delivery.error })
    })
  }

  /**
   * A worker's turn ended. Its Report drives the Ticket: `dropped` ends it silently, `ready` completes one with nothing
   * left to follow, a question becomes Attention for the Main Session, and a pull request proposal goes to the Outbox.
   * Ordinary replies are relayed to the Main Session; it alone speaks to people.
   * A turn that ends without a Report failed: a missing result is never read as success.
   */
  turnEnded(ticketId: string, assignmentId: string, result: TurnResult): void {
    this.#repo.atomic(() => {
      const ticket = this.#repo.tickets.get(ticketId)
      const assignment = ticket?.assignments.find(item => item.id === assignmentId)
      if (!ticket || !assignment) return
      const at = this.#now()
      const turn = assignment.turns + 1
      for (const artifact of result.artifacts ?? []) {
        ticket.artifacts.push({ ...artifact, id: key('art', ticketId, assignmentId, turn, artifact.kind), assignmentId, turn, at })
      }
      if (assignment.state !== 'running' || ticket.ended) { this.#save(ticket); return }
      assignment.turns = turn
      if (result.unread && assignment.taking) ticket.undelivered = [...assignment.taking, ...ticket.undelivered]
      delete assignment.taking
      const report: WorkerReport = result.error ? { state: 'failed', summary: result.error }
        : result.report ?? { state: 'failed', summary: 'The worker ended its turn without a report.' }
      this.#report(ticket, assignment, report)
    })
  }

  #take(ticket: Ticket, assignment: Assignment): TicketInput[] {
    const ids = ticket.undelivered
    ticket.undelivered = []
    assignment.taking = ids
    return ids.flatMap(id => ticket.inputs.find(input => input.id === id) ?? [])
  }

  #report(ticket: Ticket, assignment: Assignment, report: WorkerReport): void {
    const at = this.#now()
    assignment.report = {
      state: report.state, summary: report.summary.slice(0, 4000), at,
      ...report.reply ? { reply: report.reply.slice(0, 8000) } : {},
      ...report.replyTo ? { replyTo: report.replyTo } : {},
      ...report.question ? { question: report.question.slice(0, 2000) } : {},
      ...report.questionTo ? { questionTo: report.questionTo } : {},
    }
    for (const triggerId of report.acked ?? []) {
      const disposition = this.#repo.triggers.disposition(triggerId)
      if (disposition?.fanout.includes(ticket.id) && !disposition.acked?.includes(ticket.id)) {
        this.#repo.triggers.saveDisposition(triggerId, { ...disposition, acked: [...disposition.acked ?? [], ticket.id] })
      }
    }
    if (report.question) {
      ticket.attention = { id: key('att', ticket.id, at), question: report.question, ...report.questionTo ? { triggerId: report.questionTo } : {}, at }
    } else delete ticket.attention
    const openPull = ticket.follows.some(follow => follow.own && !follow.closed)
    if (report.state === 'ready' && report.pullRequest && ticket.mandate.capability === 'write' && ticket.execution && !openPull && !ticket.proposal) {
      const id = key('msg', ticket.id, assignment.id, assignment.turns, 'pull')
      const { branch, base, directory } = ticket.execution
      const channel = ticket.channels[0] ?? { source: 'repository', thread: '', address: {} }
      this.#d.outbox.send({ id, ticketId: ticket.id, purpose: 'pull_request', channel, text: report.pullRequest.title,
        pullRequest: { branch, base, directory, title: report.pullRequest.title, body: report.pullRequest.body } })
      ticket.proposal = { messageId: id, branch, title: report.pullRequest.title }
    }
    this.#save(ticket)
    // Hand-backs go after the save: a handed-back message may start a fresh Eval on a Thread this Ticket subscribes to.
    for (const item of report.handbacks ?? []) this.#handBack(ticket, item.triggerId, item.reason)
    this.#emit('assignment.reported', { ticketId: ticket.id, assignmentId: assignment.id, state: report.state, summary: assignment.report.summary.slice(0, 200) })
    const speak = !!(report.reply || report.question) || report.state === 'ready' || report.state === 'blocked' || report.state === 'failed'
    if (speak) this.#d.assessor.relayReport?.(ticket.id, assignment.id)
    if (report.state === 'dropped') this.#end(ticket, 'executor', 'dropped', report.summary)
    else if (report.state === 'ready' && !ticket.proposal && (!ticket.follows.length || followsDone(ticket))) {
      const last = ticket.follows.map(follow => follow.closed).filter(item => !!item).sort((a, b) => a.at.localeCompare(b.at)).at(-1)
      this.#end(ticket, 'executor', last?.outcome ?? 'completed')
    } else if (ticket.undelivered.length && !waitsForPerson(ticket)) this.#d.executor.wake(ticket.id)
  }

  #channelFor(ticket: Ticket, triggerId?: string) {
    return (triggerId ? this.#repo.triggers.get(triggerId)?.channel : undefined) ?? ticket.channels[0]
  }

  /** Hands a message back once; it goes to a fresh Eval when no other Ticket still owns it. */
  #handBack(ticket: Ticket, triggerId: string, reason: string): boolean {
    const disposition = this.#repo.triggers.disposition(triggerId)
    const trigger = this.#repo.triggers.get(triggerId)
    if (!trigger || !disposition?.fanout.includes(ticket.id) || disposition.handbacks?.some(item => item.ticketId === ticket.id)) return false
    this.#repo.triggers.saveDisposition(triggerId, { ...disposition, handbacks: [...disposition.handbacks ?? [], { ticketId: ticket.id, reason, at: this.#now() }] })
    this.#emit('trigger.handedBack', { triggerId, ticketId: ticket.id, reason })
    if (this.#owners(trigger).length) return false
    this.#queueForEval(trigger)
    return true
  }

  // ── People ─────────────────────────────────────────────────────────────────

  /** A person's stop from the panel: withdraws the Mandate. */
  stopTicket(ticketId: string, reason = 'stopped in the panel'): void {
    this.#repo.atomic(() => {
      const ticket = this.#ticket(ticketId)
      if (ticket.ended) throw new UserError('ended', { ticket: ticketId })
      this.#end(ticket, 'human', 'stopped', reason)
      this.#d.outbox.withdrawDrafts(ticketId, 'ticketStopped')
    })
  }

  /** Ends the stalled Assignment and starts a new one in the same directory, branch and session. */
  retryTicket(ticketId: string): void {
    this.#repo.atomic(() => {
      const ticket = this.#ticket(ticketId)
      if (!canRetry(ticket)) throw new UserError('cannotRetry', { ticket: ticketId })
      this.#replaceAssignment(ticket, 'retried', 'A person retried this Ticket after the previous attempt stalled. Read the previous report in your notes, then continue.')
      delete ticket.delivery
      this.#save(ticket)
      this.#emit('ticket.retried', { ticketId })
      this.#d.executor.start(ticketId)
    })
  }

  /** A person takes over from the panel: their text reaches the worker as a person's message and resumes an ended Ticket. */
  sendText(ticketId: string, text: string): void {
    this.#repo.atomic(() => {
      const ticket = this.#ticket(ticketId)
      if (ticket.ended?.by === 'human') throw new UserError('stoppedByPerson', { ticket: ticketId })
      if (ticket.ended) this.#reopen(ticket)
      const at = this.#now()
      this.#addInput(ticket, { id: key('input', ticketId, 'text', at), kind: 'text', text, at, human: true })
      this.#d.executor.wake(ticketId)
    })
  }

  /** Queues a stored Trigger for a fresh Eval, also a follow-up a Ticket owns; false while an Eval holds it. */
  reevaluate(triggerId: string): boolean {
    return this.#repo.atomic(() => {
      const trigger = this.#repo.triggers.get(triggerId)
      if (!trigger) throw new UserError('missing', { trigger: triggerId })
      if (this.#holding(trigger)) return false
      this.#dispose(triggerId, { requeued: true })
      this.#queueForEval(trigger)
      this.#emit('trigger.requeued', { triggerId })
      return true
    })
  }

  dismiss(decisionId: string): void {
    this.#repo.atomic(() => {
      const decision = this.#repo.decisions.get(decisionId)
      if (decision?.kind !== 'unavailable') throw new UserError('missing', { decision: decisionId })
      decision.dismissed = true
      this.#repo.decisions.save(decision)
    })
  }

  /** A person declined the proposed pull request: the Ticket keeps waiting for them, now without a proposal. */
  proposalDeclined(ticketId: string): void {
    this.#repo.atomic(() => {
      const ticket = this.#ticket(ticketId)
      if (!ticket.proposal) return
      delete ticket.proposal
      this.#save(ticket)
      this.#emit('proposal.declined', { ticketId })
    })
  }

  // ── Settings and restart ───────────────────────────────────────────────────

  /** A new Policy version: running Evals start again under it, and each live Ticket it bears on is told how. */
  policyChanged(from: string, to: string, effects: Map<string, PolicyEffect>): void {
    this.#repo.atomic(() => {
      for (const thread of this.#repo.threads.active()) {
        if (!thread.evaluating || thread.evaluating.policyVersion === to) continue
        const { triggerIds, id } = thread.evaluating
        delete thread.evaluating
        this.#repo.threads.save(thread)
        this.#requeue(thread.key, triggerIds)
        this.#emit('eval.discarded', { evalId: id, threadKey: thread.key })
      }
      const at = this.#now()
      for (const [ticketId, effect] of effects) {
        const ticket = this.#repo.tickets.get(ticketId)
        if (!ticket || ticket.ended) continue
        this.#addInput(ticket, { id: key('input', ticketId, 'policy', to), kind: 'policy-changed', from, to, at, effect })
        this.#d.executor.wake(ticketId)
      }
      this.#emit('policy.changed', { from, to, tickets: [...effects.keys()] })
    })
  }

  /**
   * At startup: an Assignment cut off mid-turn ends with "host restarted" and a new one starts with a recovery note and
   * the Inputs that turn had taken; pending ones launch again; idle ones with waiting Inputs wake.
   */
  recover(): void {
    for (const { id } of this.#repo.tickets.open()) {
      this.#repo.atomic(() => {
        const ticket = this.#ticket(id)
        const assignment = latestAssignment(ticket)
        if (!assignment || assignment.state === 'ended') return
        if (assignment.state === 'pending') { this.#d.executor.start(id); return }
        if (assignment.taking) {
          this.#replaceAssignment(ticket, 'host restarted', RECOVERY)
          this.#save(ticket)
          this.#emit('assignment.interrupted', { ticketId: id, assignmentId: assignment.id })
          this.#d.executor.start(id)
        } else if (ticket.undelivered.length && !waitsForPerson(ticket)) this.#d.executor.wake(id)
      })
    }
  }

  // ── Shared rules ───────────────────────────────────────────────────────────

  /**
   * The Tickets whose worker decides a person's follow-up: live ones it reached that did not hand it back. None once a
   * person sent it to Eval, or while an Eval holds it.
   */
  #owners(trigger: Trigger): string[] {
    if (!trigger.human) return []
    const disposition = this.#repo.triggers.disposition(trigger.id)
    if (!disposition || disposition.requeued || this.#holding(trigger)) return []
    const back = new Set(disposition.handbacks?.map(item => item.ticketId))
    return disposition.fanout.filter(id => {
      const ticket = this.#repo.tickets.get(id)
      return !back.has(id) && !!ticket && liveTicket(ticket)
    })
  }
  #holding(trigger: Trigger): Thread | undefined {
    const thread = this.#repo.threads.get(threadKey(trigger.threads[0]!))
    return thread?.evaluating?.triggerIds.includes(trigger.id) ? thread : undefined
  }
  #queueForEval(trigger: Trigger): void {
    const thread = this.#thread(trigger.threads[0]!)
    if (!thread.pending.includes(trigger.id) && !thread.evaluating?.triggerIds.includes(trigger.id)) thread.pending.push(trigger.id)
    this.#repo.threads.save(thread)
  }
  #requeue(threadKeyValue: string, triggerIds: string[]): void {
    const thread = this.#repo.threads.get(threadKeyValue)
    if (!thread) return
    thread.pending = [...triggerIds, ...thread.pending.filter(id => !triggerIds.includes(id))]
    this.#repo.threads.save(thread)
  }
  #accepted(threadKeyValue: string): Map<string, Decision> {
    const map = new Map<string, Decision>()
    for (const decision of this.#repo.decisions.onThread(threadKeyValue)) {
      if (decision.kind === 'accept' && decision.ticketId) {
        const ticket = this.#repo.tickets.get(decision.ticketId)
        if (ticket) map.set(ticket.origin.triggerId, decision)
      }
    }
    return map
  }
  #ticketsOnThread(thread: Thread): Ticket[] {
    const ids = new Set([...thread.subscriptions, ...this.#repo.decisions.onThread(thread.key).flatMap(item => item.kind === 'accept' && item.ticketId ? [item.ticketId] : [])])
    return [...ids].flatMap(id => this.#repo.tickets.get(id) ?? [])
  }
  #subscribe(ticketId: string, ref: ThreadRef): void {
    const thread = this.#thread(ref)
    if (!thread.subscriptions.includes(ticketId)) thread.subscriptions.push(ticketId)
    this.#repo.threads.save(thread)
  }
  #dispose(triggerId: string, patch: Partial<NonNullable<ReturnType<Repositories['triggers']['disposition']>>>): void {
    const current = this.#repo.triggers.disposition(triggerId) ?? { fanout: [], at: this.#now() }
    this.#repo.triggers.saveDisposition(triggerId, { ...current, ...patch })
  }
  #addInput(ticket: Ticket, input: TicketInput): void {
    if (ticket.inputs.some(item => item.id === input.id)) return
    ticket.inputs.push(input)
    ticket.undelivered.push(input.id)
    this.#save(ticket)
  }
  /** A person's message resumes an ended Ticket under its unchanged Mandate, once revalidated against today's Policy. */
  #resume(ticket: Ticket, trigger: Trigger): boolean {
    const origin = this.#repo.triggers.get(ticket.origin.triggerId) ?? trigger
    if (!this.#d.scope.scope(origin).listened || !this.#d.policy().revalidate(ticket.mandate)) {
      this.#emit('ticket.resumeRefused', { ticketId: ticket.id, triggerId: trigger.id })
      return false
    }
    this.#reopen(ticket)
    this.#addInput(ticket, { id: key('input', ticket.id, 'resumed', trigger.id), kind: 'resumed', triggerId: trigger.id, at: this.#now() })
    return true
  }
  #reopen(ticket: Ticket): void {
    delete ticket.ended
    ticket.assignments.push(newAssignment(ticket.id, ticket.assignments.length, this.#now()))
    this.#save(ticket)
    this.#emit('ticket.resumed', { ticketId: ticket.id })
    this.#d.executor.start(ticket.id)
  }
  #replaceAssignment(ticket: Ticket, reason: string, recovery: string): void {
    const at = this.#now()
    const current = latestAssignment(ticket)
    if (current && current.state !== 'ended') {
      if (current.taking) { ticket.undelivered = [...current.taking, ...ticket.undelivered]; delete current.taking }
      Object.assign(current, { state: 'ended', endedAt: at, endedReason: reason })
    }
    ticket.assignments.push({ ...newAssignment(ticket.id, ticket.assignments.length, at), recovery })
  }
  /**
   * Ends a Ticket. Its unread follow-ups, which its worker neither took up nor handed back, return to Eval when no other
   * Ticket owns them; the message that stopped it does not.
   */
  #end(ticket: Ticket, by: TicketEndBy, outcome: TicketOutcome, reason?: string, except?: string): void {
    const at = this.#now()
    ticket.ended = { at, by, outcome, ...reason ? { reason: reason.slice(0, 500) } : {} }
    for (const assignment of ticket.assignments) {
      if (assignment.state === 'ended') continue
      Object.assign(assignment, { state: 'ended', endedAt: at, endedReason: outcome })
      delete assignment.taking
    }
    delete ticket.attention
    delete ticket.delivery
    const unread = ticket.undelivered.flatMap(id => {
      const input = ticket.inputs.find(item => item.id === id)
      return input?.kind === 'trigger' && input.human ? [input.triggerId] : []
    })
    ticket.undelivered = []
    this.#save(ticket)
    this.#d.executor.stop(ticket.id)
    this.#emit('ticket.ended', { ticketId: ticket.id, by, outcome, reason })
    for (const triggerId of unread) {
      const trigger = this.#repo.triggers.get(triggerId)
      if (!trigger || triggerId === except || this.#repo.triggers.disposition(triggerId)?.decisionId) continue
      if (!this.#owners(trigger).length) this.#queueForEval(trigger)
    }
  }
}

function newAssignment(ticketId: string, index: number, at: string): Assignment {
  return { id: key('a', ticketId, index), state: 'pending', createdAt: at, turns: 0 }
}

export function ticketCard(ticket: Ticket): TicketCard {
  return { id: ticket.id, title: ticket.title, stage: stageLabel(ticketStage(ticket)), scope: ticket.mandate.scope.slice(0, 200), capability: ticket.mandate.capability }
}

function reasonText(reasons: Reason[]): string {
  return reasons.map(reason => reason.values?.text ?? reason.code).join('; ')
}
