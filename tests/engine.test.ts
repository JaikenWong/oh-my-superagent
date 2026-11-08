/** Domain rules on a real Store in memory, with recording ports instead of adapters. */
import assert from 'node:assert/strict'
import { beforeEach, describe, test } from 'node:test'
import { Engine } from '../src/core/engine.ts'
import type { Ticket, Trigger } from '../src/core/model.ts'
import type { OutgoingMessage } from '../src/core/ports.ts'
import { stageLabel, ticketStage } from '../src/core/stage.ts'
import { assessmentOutcome, normalizeSettings, settingsPolicy, type Settings } from '../src/policy.ts'
import { Store } from '../src/store/store.ts'

let seq = 0
let clock = Date.parse('2026-11-07T00:00:00Z')
const tick = () => new Date(clock += 1000).toISOString()

function harness(patch: Partial<Settings['policy']> = {}, timeoutSeconds = 120) {
  const store = new Store(':memory:')
  const state = {
    settings: normalizeSettings({ policy: { mode: 'observe', sources: { github: { allowed: [{ id: 'alice' }] } }, ...patch }, eval: { timeoutSeconds, assessor: 'heuristic' } }),
    started: [] as string[], woken: [] as string[], stopped: [] as string[], assessed: [] as string[], sent: [] as OutgoingMessage[], withdrawn: [] as string[],
  }
  const scope = { scope: (trigger: { source: string }) => ({ listened: trigger.source === 'github', observed: true }) }
  const engine = new Engine({
    repo: store, now: tick, scope,
    policy: () => settingsPolicy(state.settings, scope),
    assessor: { request: id => { state.assessed.push(id) } },
    executor: { start: id => { state.started.push(id) }, wake: id => { state.woken.push(id) }, stop: id => { state.stopped.push(id) } },
    outbox: { send: message => { state.sent.push(message) }, withdrawDrafts: id => { state.withdrawn.push(id) } },
  })
  return { store, engine, state }
}

function trigger(patch: Partial<Trigger> = {}): Trigger {
  const id = `github:comment:${++seq}`
  return {
    id, source: 'github', threads: [{ source: 'github', id: 'issue:1' }], actor: { source: 'github', id: 'alice' }, human: true, addressed: 'mention',
    at: tick(), text: '/agent summarize the login crash', channel: { source: 'github', thread: 'issue:1', address: { number: '1' } }, meta: {}, ...patch,
  }
}

const readAccept = { kind: 'accept' as const, title: 'Summarize', scope: 'summarize the crash', capability: 'read' as const, reason: 'explicit', acknowledgement: '收到' }

/** Receives an explicit request and accepts it; returns the Ticket. */
function accepted(h: ReturnType<typeof harness>, patch: Partial<Trigger> = {}): Ticket {
  const request = trigger(patch)
  h.engine.receive(request)
  h.engine.evaluateDue()
  const evalId = h.state.assessed.at(-1)!
  const decision = h.engine.decide(request.id, { ...readAccept, evalId })
  return h.store.tickets.get(decision.ticketId!)!
}

/** Starts the Ticket's Assignment and ends its first turn with `report`. */
function runTurn(h: ReturnType<typeof harness>, ticket: Ticket, report: Parameters<Engine['turnEnded']>[2]) {
  const assignment = h.store.tickets.get(ticket.id)!.assignments.at(-1)!
  if (assignment.state === 'pending') h.engine.assignmentStarted(ticket.id, assignment.id, { directory: '/tmp/x', branch: 'superagent/x', base: 'main', session: 's', backend: 'mock' })
  else h.engine.takeInputs(ticket.id, assignment.id)
  h.engine.turnEnded(ticket.id, assignment.id, report)
  return h.store.tickets.get(ticket.id)!
}

let h: ReturnType<typeof harness>
beforeEach(() => { h = harness() })

describe('intake', () => {
  test('a Trigger is stored once', () => {
    const request = trigger()
    assert.equal(h.engine.receive(request), 'stored')
    assert.equal(h.engine.receive(request), 'duplicate')
    assert.deepEqual(h.store.threads.get('github:issue:1')!.pending, [request.id])
  })

  test('a Source that does not listen filters it before the domain', () => {
    assert.equal(h.engine.receive(trigger({ source: 'gitlab' })), 'filtered')
  })
})

describe('gate', () => {
  test('a person not on the list who addresses the agent is not admitted', () => {
    const request = trigger({ actor: { source: 'github', id: 'mallory' } })
    h.engine.receive(request)
    h.engine.evaluateDue()
    assert.equal(h.state.assessed.length, 0)
    const [decision] = h.store.decisions.onThread('github:issue:1')
    assert.equal(decision!.kind, 'ignore')
    assert.equal(decision!.reason[0]!.code, 'not_a_member')
  })

  test('a listed person who does not address the agent is an inferred candidate where every message is received', () => {
    h.engine.receive(trigger({ addressed: undefined, text: 'the login page crashes' }))
    h.engine.evaluateDue()
    const candidate = h.engine.candidate(h.state.assessed[0]!)!
    assert.equal(candidate.strength, 'inferred')
  })

  test('only a listed bot can make a candidate, and never an explicit one', () => {
    const settings = h.state.settings
    h.state.settings = { ...settings, policy: { ...settings.policy, sources: { github: { allowed: [{ id: 'alice' }], bots: [{ id: 'dependabot[bot]' }] } } } }
    h.engine.receive(trigger({ human: false, actor: { source: 'github', id: 'ci[bot]' }, threads: [{ source: 'github', id: 'issue:2' }] }))
    h.engine.receive(trigger({ human: false, actor: { source: 'github', id: 'dependabot[bot]' } }))
    h.engine.evaluateDue()
    assert.equal(h.store.decisions.onThread('github:issue:2')[0]!.reason[0]!.code, 'not_human')
    assert.equal(h.engine.candidate(h.state.assessed[0]!)!.strength, 'inferred')
  })
})

describe('eval', () => {
  test('accept creates Ticket, Mandate, Subscription and Assignment; Main Session speaks via reply', () => {
    const ticket = accepted(h)
    assert.equal(ticket.mandate.strength, 'explicit')
    assert.equal(ticket.mandate.capability, 'read')
    assert.deepEqual(h.store.threads.get('github:issue:1')!.subscriptions, [ticket.id])
    assert.equal(ticket.assignments[0]!.state, 'pending')
    assert.deepEqual(h.state.started, [ticket.id])
    assert.equal(h.state.sent.length, 0, 'accept does not speak; Router reply does')
    h.engine.reply({ id: 'ack1', ticketId: ticket.id, purpose: 'acknowledgement', text: '收到', replyTo: ticket.origin.triggerId })
    assert.equal(h.state.sent[0]!.purpose, 'acknowledgement')
    const again = h.engine.decide(ticket.origin.triggerId, readAccept)
    assert.equal(again.ticketId, ticket.id)
    assert.equal(h.store.tickets.open().length, 1)
  })

  test('Triggers that arrive during an Eval form the next batch', () => {
    const first = trigger({ threads: [{ source: 'github', id: 'issue:9' }] })
    h.engine.receive(first)
    h.engine.evaluateDue()
    const second = trigger({ threads: [{ source: 'github', id: 'issue:9' }] })
    const third = trigger({ threads: [{ source: 'github', id: 'issue:9' }] })
    h.engine.receive(second)
    h.engine.receive(third)
    h.engine.evaluateDue()
    assert.equal(h.state.assessed.length, 1, 'one Eval at a time per Thread')
    h.engine.decide(first.id, { kind: 'ignore', reason: 'chatter', evalId: h.state.assessed[0]! })
    h.engine.evaluateDue()
    assert.deepEqual(h.engine.candidate(h.state.assessed[1]!)!.triggers.map(item => item.id), [second.id, third.id])
  })

  test('an expired Eval is queued again twice, then recorded unavailable', () => {
    h = harness({}, 0)
    h.engine.receive(trigger())
    for (let i = 0; i < 3; i++) { h.engine.evaluateDue(); h.engine.evaluateDue() }
    const decisions = h.store.decisions.onThread('github:issue:1')
    assert.equal(decisions.length, 1)
    assert.equal(decisions[0]!.kind, 'unavailable')
    assert.equal(decisions[0]!.reason[0]!.code, 'timeout')
    assert.equal(h.state.assessed.length, 3)
  })

  test('a decision made against an outdated Policy is unavailable and its Triggers are judged again', () => {
    const request = trigger()
    h.engine.receive(request)
    h.engine.evaluateDue()
    h.state.settings = { ...h.state.settings, policy: { ...h.state.settings.policy, mode: 'auto' } }
    const decision = h.engine.decide(request.id, { ...readAccept, evalId: h.state.assessed[0]! })
    assert.equal(decision.kind, 'unavailable')
    assert.deepEqual(h.store.threads.get('github:issue:1')!.pending, [request.id])
  })
})

describe('observe mode', () => {
  const assessment = {
    decision: 'accept' as const, reason: 'typo fix requested', title: 'Fix typo', scope: 'fix the typo', intent_evidence: '"Helo" should be "Hello"',
    rule_assessments: [{ rule_id: 'typo', matched: true, reason: 'typo' }, { rule_id: 'repro', matched: false, reason: 'no crash' }],
    direction: { implementation_requested: true, target_basis: 'specified' as const, requires_design_decision: false, evidence: 'quote' },
  }
  test('a positive assessment only records "would accept"', () => {
    const outcome = assessmentOutcome(assessment, h.state.settings)
    assert.equal(outcome.kind, 'ignore')
    assert.equal((outcome as { audit: Record<string, unknown> }).audit.would_accept, true)
  })
  test('auto mode accepts on a matched rule; every enabled rule must be judged once', () => {
    const auto = { ...h.state.settings, policy: { ...h.state.settings.policy, mode: 'auto' as const } }
    assert.equal(assessmentOutcome(assessment, auto).kind, 'accept')
    assert.throws(() => assessmentOutcome({ ...assessment, rule_assessments: assessment.rule_assessments.slice(0, 1) }, auto))
    const unsettled = { ...assessment, direction: { ...assessment.direction, requires_design_decision: true } }
    assert.equal(assessmentOutcome(unsettled, auto).kind, 'ignore')
  })
  test('an inferred candidate cannot be accepted outside auto mode', () => {
    const request = trigger({ addressed: undefined, text: 'typo: Helo' })
    h.engine.receive(request)
    h.engine.evaluateDue()
    assert.throws(() => h.engine.decide(request.id, { ...readAccept, rules: ['typo'], evalId: h.state.assessed[0]! }), /notExplicit/)
  })
})

describe('subscriptions', () => {
  test("a person's follow-up goes straight to the Ticket and takes no Eval; a bot's also goes to Eval", () => {
    const ticket = accepted(h)
    const followup = trigger({ text: 'also check the signup page', addressed: undefined })
    h.engine.receive(followup)
    const after = h.store.tickets.get(ticket.id)!
    assert.equal(after.inputs.at(-1)!.kind, 'trigger')
    assert.deepEqual(h.store.threads.get('github:issue:1')!.pending, [])
    assert.ok(h.state.woken.includes(ticket.id))
    const bot = trigger({ human: false, actor: { source: 'github', id: 'ci[bot]' }, addressed: undefined, text: 'CI failed' })
    h.engine.receive(bot)
    assert.equal(h.store.tickets.get(ticket.id)!.inputs.length, 2)
    assert.deepEqual(h.store.threads.get('github:issue:1')!.pending, [bot.id])
  })

  test('the Router may not route a follow-up a Ticket owns, only stop it', () => {
    const ticket = accepted(h)
    const followup = trigger({ text: '/agent stop' })
    h.engine.receive(followup)
    assert.throws(() => h.engine.decide(followup.id, readAccept), /ownedByTicket/)
    const decision = h.engine.decide(followup.id, { kind: 'stop', reason: 'asked' })
    assert.equal(decision.kind, 'stop')
    const stopped = h.store.tickets.get(ticket.id)!
    assert.equal(stopped.ended!.by, 'human')
    assert.deepEqual(h.state.withdrawn, [ticket.id])
  })

  test("a stranger's stop is not explicit and stops nothing", () => {
    const ticket = accepted(h)
    const stop = trigger({ actor: { source: 'github', id: 'mallory' }, text: '/agent stop' })
    h.engine.receive(stop)
    const decision = h.engine.decide(stop.id, { kind: 'stop', reason: 'asked' })
    assert.equal(decision.reason[0]!.code, 'stopNotExplicit')
    assert.ok(!h.store.tickets.get(ticket.id)!.ended)
  })

  test('a hand-back queues the message for a fresh Eval with the reason', () => {
    const ticket = accepted(h)
    runTurn(h, ticket, { report: { state: 'waiting', summary: 'answered' } })
    const fix = trigger({ text: '/agent fix it' })
    h.engine.receive(fix)
    runTurn(h, ticket, { report: { state: 'waiting', summary: 'beyond scope', handbacks: [{ triggerId: fix.id, reason: 'read-only Ticket' }] } })
    h.engine.evaluateDue()
    const candidate = h.engine.candidate(h.state.assessed.at(-1)!)!
    assert.deepEqual(candidate.triggers.map(item => item.id), [fix.id])
    assert.equal(candidate.handbacks[0]!.reason, 'read-only Ticket')
    assert.equal(candidate.strength, 'explicit')
  })
})

describe('reports and lifecycle', () => {
  test('ready without a pull request completes the Ticket; Main Session relays the reply', () => {
    const ticket = accepted(h)
    const done = runTurn(h, ticket, { report: { state: 'ready', summary: 'analysis', reply: 'here it is' } })
    assert.equal(done.ended!.outcome, 'completed')
    assert.equal(done.assignments[0]!.report!.reply, 'here it is')
    assert.equal(h.state.sent.length, 0, 'worker does not speak')
    h.engine.reply({ id: 'r1', ticketId: ticket.id, purpose: 'result', text: 'here it is' })
    assert.equal(h.state.sent.at(-1)!.purpose, 'result')
    h.engine.receive(trigger({ text: 'thanks, one more question', addressed: undefined }))
    const resumed = h.store.tickets.get(ticket.id)!
    assert.ok(!resumed.ended)
    assert.equal(resumed.assignments.length, 2)
    assert.deepEqual(resumed.inputs.map(input => input.kind), ['resumed', 'trigger'])
  })

  test('a Ticket a person stopped receives nothing, and the message goes to Eval', () => {
    const ticket = accepted(h)
    h.engine.stopTicket(ticket.id)
    const later = trigger({ text: 'please continue', addressed: undefined })
    h.engine.receive(later)
    assert.equal(h.store.tickets.get(ticket.id)!.inputs.length, 0)
    assert.deepEqual(h.store.threads.get('github:issue:1')!.pending, [later.id])
  })

  test('resuming revalidates the Mandate: a requester no longer listed cannot resume it', () => {
    const ticket = accepted(h)
    runTurn(h, ticket, { report: { state: 'ready', summary: 'done' } })
    h.state.settings = { ...h.state.settings, policy: { ...h.state.settings.policy, sources: { github: { allowed: [] } } } }
    const later = trigger({ text: 'one more thing', addressed: undefined })
    h.engine.receive(later)
    assert.ok(h.store.tickets.get(ticket.id)!.ended)
    assert.deepEqual(h.store.threads.get('github:issue:1')!.pending, [later.id])
  })

  test('a turn without a report failed, and holds automatic Inputs until a person writes', () => {
    const ticket = accepted(h)
    const failed = runTurn(h, ticket, {})
    assert.equal(stageLabel(ticketStage(failed)), 'person/failed')
    assert.match(failed.assignments[0]!.report!.summary, /without a report/)
    h.state.woken.length = 0
    h.engine.receive(trigger({ human: false, actor: { source: 'github', id: 'ci[bot]' }, addressed: undefined, text: 'CI red' }))
    assert.equal(h.engine.takeInputs(ticket.id, failed.assignments[0]!.id), undefined, 'held')
    h.engine.receive(trigger({ text: 'try again with the logs', addressed: undefined }))
    assert.notEqual(stageLabel(ticketStage(h.store.tickets.get(ticket.id)!)), 'person/failed')
    assert.equal(h.engine.takeInputs(ticket.id, failed.assignments[0]!.id)!.length, 2)
  })

  test('a question becomes the Attention; Main Session speaks it', () => {
    const ticket = accepted(h)
    const asked = runTurn(h, ticket, { report: { state: 'waiting', summary: 'need steps', question: '复现步骤？' } })
    assert.equal(stageLabel(ticketStage(asked)), 'person/answer')
    assert.equal(asked.attention!.question, '复现步骤？')
    assert.equal(h.state.sent.length, 0)
    h.engine.reply({ id: 'q1', ticketId: ticket.id, purpose: 'attention', text: '复现步骤？' })
    assert.equal(h.state.sent.at(-1)!.purpose, 'attention')
  })

  test('dropped ends the Ticket silently', () => {
    const ticket = accepted(h)
    const before = h.state.sent.length
    const dropped = runTurn(h, ticket, { report: { state: 'dropped', summary: 'not reproducible' } })
    assert.equal(dropped.ended!.outcome, 'dropped')
    assert.equal(h.state.sent.length, before)
  })

  test("a write Ticket's ready report with a pull request waits for review, then ends as its pull request closes", () => {
    const ticket = accepted(h)
    // Mandates are immutable; a write Ticket comes from a write accept.
    const record = h.store.tickets.get(ticket.id)!
    record.mandate = { ...record.mandate, capability: 'write' }
    h.store.tickets.save(record)
    const ready = runTurn(h, ticket, { report: { state: 'ready', summary: 'fixed', pullRequest: { title: 'fix', body: 'b' } } })
    assert.equal(stageLabel(ticketStage(ready)), 'person/review')
    assert.equal(h.state.sent.at(-1)!.purpose, 'pull_request')
    h.engine.bindThread(ticket.id, { source: 'github', id: 'pull:5' }, true)
    assert.ok(!h.store.tickets.get(ticket.id)!.proposal)
    h.engine.threadClosed({ source: 'github', id: 'pull:5' }, 'merged')
    assert.equal(h.store.tickets.get(ticket.id)!.ended!.outcome, 'merged')
  })

  test("unread follow-ups return to Eval when the Ticket ends", () => {
    const ticket = accepted(h)
    const unread = trigger({ text: 'and the signup page?', addressed: undefined })
    h.engine.receive(unread)
    h.engine.stopTicket(ticket.id)
    assert.deepEqual(h.store.threads.get('github:issue:1')!.pending, [unread.id])
  })

  test('restart: a turn cut off starts again with a recovery note and the Inputs it had taken', () => {
    const ticket = accepted(h)
    const assignment = h.store.tickets.get(ticket.id)!.assignments[0]!
    h.engine.receive(trigger({ text: 'more context', addressed: undefined }))
    h.engine.assignmentStarted(ticket.id, assignment.id, { directory: '/tmp/x', branch: 'b', base: 'main', session: 's', backend: 'mock' })
    h.state.started.length = 0
    h.engine.recover()
    const recovered = h.store.tickets.get(ticket.id)!
    assert.equal(recovered.assignments[0]!.endedReason, 'host restarted')
    assert.match(recovered.assignments[1]!.recovery!, /restarted/)
    assert.equal(recovered.assignments[1]!.generation, 1)
    assert.equal(recovered.undelivered.length, 1)
    assert.deepEqual(h.state.started, [ticket.id])
  })

  test('stale Report from an ended Assignment does not change Ticket state', () => {
    const ticket = accepted(h)
    const first = h.store.tickets.get(ticket.id)!.assignments[0]!
    h.engine.assignmentStarted(ticket.id, first.id, { directory: '/tmp/x', branch: 'b', base: 'main', session: 's', backend: 'mock' })
    h.engine.turnEnded(ticket.id, first.id, { report: { state: 'failed', summary: 'boom' } })
    h.engine.retryTicket(ticket.id)
    const after = h.store.tickets.get(ticket.id)!
    assert.equal(after.assignments.length, 2)
    assert.equal(after.assignments[0]!.state, 'ended')
    assert.equal(after.assignments[1]!.generation, 1)
    h.engine.turnEnded(ticket.id, first.id, { report: { state: 'ready', summary: 'late success from old worker', reply: 'should ignore' } })
    const late = h.store.tickets.get(ticket.id)!
    assert.ok(!late.ended, 'stale ready must not complete the Ticket')
    assert.equal(late.assignments[0]!.report!.state, 'failed')
    assert.ok(!late.assignments[1]!.report)
    assert.ok(h.store.eventsFor('ticket', ticket.id).some(event => event.type === 'assignment.report_stale'))
  })

  test('Stop forbids automatic Retry (INV-7)', () => {
    const ticket = accepted(h)
    const assignment = h.store.tickets.get(ticket.id)!.assignments[0]!
    h.engine.assignmentStarted(ticket.id, assignment.id, { directory: '/tmp/x', branch: 'b', base: 'main', session: 's', backend: 'mock' })
    h.engine.turnEnded(ticket.id, assignment.id, { report: { state: 'failed', summary: 'boom' } })
    h.engine.stopTicket(ticket.id)
    assert.throws(() => h.engine.retryTicket(ticket.id), /cannotRetry/)
  })
})
