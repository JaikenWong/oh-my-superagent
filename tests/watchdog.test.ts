/** Watchdog retries stalled Tickets and notifies the Main Session inbox. */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { after, describe, test } from 'node:test'
import { Engine } from '../src/core/engine.ts'
import { normalizeSettings, settingsPolicy } from '../src/policy.ts'
import { MainSession } from '../src/router/session.ts'
import { Effects } from '../src/store/effects.ts'
import { Store } from '../src/store/store.ts'
import { Watchdog } from '../src/watchdog/watchdog.ts'

const dir = mkdtempSync(join(tmpdir(), 'wd-'))
after(() => { rmSync(dir, { recursive: true, force: true }) })

describe('Watchdog', () => {
  test('retries a failed Ticket and records an action', async () => {
    const store = new Store(':memory:')
    const settings = normalizeSettings({ policy: { mode: 'observe', sources: { github: { allowed: [{ id: 'alice' }] } } } })
    const effects = new Effects(store, () => false)
    let engine!: Engine
    const session = new MainSession({
      engine: () => engine, effects, store, settings: () => settings, stateDir: dir,
    })
    session.install()
    const scope = { scope: () => ({ listened: true, observed: true }) }
    engine = new Engine({
      repo: store, scope, policy: () => settingsPolicy(settings, scope),
      assessor: { request: () => {} },
      executor: { start: () => {}, wake: () => {}, stop: () => {} },
      outbox: { send: () => {}, withdrawDrafts: () => {} },
    })
    const trigger = {
      id: 'github:comment:1', source: 'github', threads: [{ source: 'github', id: 'issue:1' }],
      actor: { source: 'github', id: 'alice' }, human: true as const, addressed: 'mention' as const,
      at: new Date().toISOString(), text: '/agent summarize x',
      channel: { source: 'github', thread: 'issue:1', address: { number: '1' } }, meta: {},
    }
    engine.receive(trigger)
    engine.evaluateDue()
    // Skip Router: decide directly
    engine.decide(trigger.id, {
      kind: 'accept', title: 't', scope: 's', capability: 'read', reason: 'explicit', evalId: store.threads.get('github:issue:1')!.evaluating!.id,
    })
    const ticket = store.tickets.open()[0]!
    const assignment = ticket.assignments[0]!
    engine.assignmentStarted(ticket.id, assignment.id, { directory: '/tmp', branch: 'b', base: 'main', session: 's', backend: 'mock' })
    engine.turnEnded(ticket.id, assignment.id, { report: { state: 'failed', summary: 'boom' } })

    const wd = new Watchdog({ engine: () => engine, store, settings: () => settings, session })
    const actions = await wd.tick()
    assert.ok(actions.some(item => item.action === 'retry'))
    assert.equal(store.tickets.get(ticket.id)!.assignments.length, 2)
    await effects.settle()
  })
})
