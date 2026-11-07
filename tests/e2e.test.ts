/**
 * The whole application on a real git repository, with the mock agent as a real child process and the Sources in
 * dry-run mode: native webhook payloads in; Main Session (mock Router) speaks and outbound is auto.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, before, describe, test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { Runtime } from '../src/app/runtime.ts'
import * as views from '../src/app/views.ts'
import type { Deployment } from '../src/config.ts'
import { createDemoRepo } from '../scripts/demo-repo.ts'

let root: string
let runtime: Runtime

before(() => {
  mkdirSync(join(process.cwd(), '.state'), { recursive: true })
  root = mkdtempSync(join(process.cwd(), '.state', 'e2e-'))
  const deployment: Deployment = {
    stateDir: join(root, 'state'), http: { host: '127.0.0.1', port: 0 },
    repository: { path: createDemoRepo(join(root, 'repo')), baseBranch: 'main', source: 'github' },
    sources: {
      github: { kind: 'github', repo: 'acme/demo-app', account: 'superagent-bot', dryRun: true, receiveAll: true },
      feishu: { kind: 'feishu', botOpenId: 'ou_bot', dryRun: true },
    },
    settings: {
      outbound: 'auto',
      policy: { mode: 'observe', sources: { github: { allowed: [{ id: 'alice' }] }, feishu: { allowed: [{ id: 'ou_alice' }] } } },
      executor: { maxWorkers: 2, agent: 'mock', turnTimeoutMinutes: 2 },
    },
  }
  runtime = new Runtime(deployment, { database: ':memory:', watchdogMs: 0 })
  console.log = () => {}
})
after(async () => {
  if (runtime) await runtime.stop()
  if (root) rmSync(root, { recursive: true, force: true })
})

async function until<T>(what: string, probe: () => T | undefined | false, ms = 20_000): Promise<T> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    runtime.pass()
    await runtime.effects.settle()
    const value = probe()
    if (value) return value
    await sleep(40)
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('Day-1 demo: /agent summarize on a GitHub Issue', () => {
  let ticketId: string
  test('Main Session accepts and speaks acknowledgement; outbound auto-sends', async () => {
    const answer = runtime.simulate('github', { event: 'issue', number: 12, user: 'alice', title: 'Login crashes for phone sign-ups', text: '/agent summarize users who signed up with a phone number crash on login' })
    assert.equal(answer.status, 200)
    const ticket = await until('a Ticket', () => runtime.store.tickets.open()[0])
    ticketId = ticket.id
    assert.equal(ticket.mandate.capability, 'read')
    const ack = await until('acknowledgement sent', () => runtime.outbox.list('sent', ticketId).find(item => item.purpose === 'acknowledgement'))
    assert.match(ack.text, /收到|来/)
  })

  test('the worker runs in its own worktree; Router relays the analysis', async () => {
    const result = await until('a result sent', () => runtime.outbox.list('sent', ticketId).find(item => item.purpose === 'result'))
    assert.match(result.text, /src\/login\.js/)
    const ticket = runtime.store.tickets.get(ticketId)!
    assert.equal(ticket.ended?.outcome, 'completed')
    assert.match(ticket.execution!.directory, /work/)
    assert.equal(execFileSync('git', ['-C', ticket.execution!.directory, 'branch', '--show-current'], { encoding: 'utf8' }).trim(), ticket.execution!.branch)
    assert.ok(ticket.artifacts.some(item => item.kind === 'prompt') && ticket.artifacts.some(item => item.kind === 'log'))
    const prompt = readFileSync(ticket.artifacts.find(item => item.kind === 'prompt')!.path, 'utf8')
    assert.match(prompt, /capability: \*\*read\*\*/)
    const sent = runtime.outbox.list('sent', ticketId).reverse().map(item => item.purpose)
    assert.deepEqual(sent, ['acknowledgement', 'result'])
  })

  test('a code change asked on the read-only Ticket is handed back and becomes a write Ticket with a pull request', async () => {
    runtime.simulate('github', { event: 'comment', number: 12, user: 'alice', text: '/agent fix src/greet.js "Helo" -> "Hello"' })
    const write = await until('a write Ticket', () => runtime.store.tickets.open().find(item => item.mandate.capability === 'write'))
    const read = runtime.store.tickets.get(ticketId)!
    assert.ok(read.inputs.some(input => input.kind === 'resumed'), 'the human message resumed the ended Ticket first')
    assert.equal(runtime.outbox.list(undefined, ticketId).filter(item => item.purpose === 'result').length, 1, 'the resumed Ticket does not repeat its answer')
    assert.equal(views.ticketRow(read).stage, 'idle', 'it handed the request back and waits')
    const proposal = await until('a pull request sent', () => runtime.outbox.list(undefined, write.id).find(item => item.purpose === 'pull_request' && (item.status === 'sent' || item.status === 'pending')))
    assert.equal(proposal.ticketId, write.id)
    const log = execFileSync('git', ['-C', runtime.deployment.repository.path, 'log', '--oneline', `superagent/${write.name}`], { encoding: 'utf8' })
    assert.match(log, /Helo/)
    assert.equal(execFileSync('git', ['-C', runtime.deployment.repository.path, 'show', 'main:src/greet.js'], { encoding: 'utf8' }).includes('Helo'), true, 'main is untouched')
    const opened = await until('the pull request bound', () => runtime.store.tickets.get(write.id)!.follows.find(follow => follow.own))
    await until('the link announced', () => runtime.outbox.list('sent', write.id).find(item => item.purpose === 'result' && /PR/.test(item.text)))
    assert.equal(views.ticketRow(runtime.store.tickets.get(write.id)!).stage, 'person/review')
    const number = Number(opened.thread.split(':').at(-1))
    runtime.simulate('github', { event: 'pr_merged', number, user: 'bob' })
    assert.equal(runtime.store.tickets.get(write.id)!.ended?.outcome, 'merged')
  })

  test('a listed person who does not address the agent: observe mode records "would accept" and starts nothing', async () => {
    const open = runtime.store.tickets.open().length
    runtime.simulate('github', { event: 'issue', number: 13, user: 'alice', title: 'Crash on start', text: 'The app crashes with a stack trace on start.' })
    const decision = await until('a Decision', () => runtime.store.decisions.onThread('github:issue:13')[0])
    assert.equal(decision.kind, 'ignore')
    assert.equal(decision.audit?.would_accept, true)
    assert.equal(runtime.store.tickets.open().length, open)
  })

  test('a stranger is not admitted', async () => {
    runtime.simulate('github', { event: 'comment', number: 14, user: 'mallory', text: '/agent fix everything' })
    const decision = await until('a Decision', () => runtime.store.decisions.onThread('github:issue:14')[0])
    assert.equal(decision.reason[0]!.code, 'not_a_member')
  })
})

describe('Feishu', () => {
  test('a mention in a group topic starts a Ticket; Router replies in the topic', async () => {
    runtime.simulate('feishu', { event: 'comment', user: 'ou_alice', chat: 'oc_team', text: '@agent 总结一下 src/login.js 为什么会崩溃' })
    const ticket = await until('a Feishu Ticket', () => runtime.store.tickets.open().find(item => item.mandate.actor.source === 'feishu')
      ?? runtime.store.allTickets().find(item => item.mandate.actor.source === 'feishu'))
    const result = await until('a result sent', () => runtime.outbox.list('sent', ticket.id).find(item => item.purpose === 'result'))
    assert.equal(result.channel.source, 'feishu')
    assert.ok(result.channel.address.message_id)
  })
})
