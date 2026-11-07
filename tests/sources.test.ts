/** The Sources translate native payloads into Triggers and verify where they came from. */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { FeishuSource } from '../src/sources/feishu.ts'
import { GithubSource } from '../src/sources/github.ts'
import { GitlabSource } from '../src/sources/gitlab.ts'
import { parseCommand } from '../src/router/command.ts'

describe('GitHub', () => {
  process.env.TEST_GH_SECRET = 's3cret'
  const github = new GithubSource('github', { kind: 'github', repo: 'acme/app', account: 'agent-bot', secretEnv: 'TEST_GH_SECRET' })

  test('verifies the HMAC signature', () => {
    const request = github.simulate({ event: 'comment', number: 3, user: 'alice', text: '/agent summarize' })
    assert.ok(github.verify(request))
    assert.ok(!github.verify({ ...request, body: request.body.replace('summarize', 'fix') }))
  })

  test('a comment is a Trigger on its Issue Thread, addressed by command or mention', () => {
    const { triggers, threads } = github.parse(github.simulate({ event: 'comment', number: 3, user: 'alice', text: 'hey @agent-bot can you look?' }))
    assert.equal(triggers[0]!.threads[0]!.id, 'issue:3')
    assert.equal(triggers[0]!.addressed, 'mention')
    assert.equal(threads![0]!.meta.number, 3)
  })

  test("the agent's own signed comments never enter the domain; the same account's unsigned ones are a person's; bots are not human", () => {
    assert.equal(github.parse(github.simulate({ event: 'comment', number: 3, user: 'agent-bot', text: '> 由自动化 agent 发出，非人工。\n\ndone' })).triggers.length, 0)
    const [mine] = github.parse(github.simulate({ event: 'comment', number: 3, user: 'agent-bot', text: '/agent summarize' })).triggers
    assert.equal(mine!.human, true)
    assert.equal(mine!.addressed, 'mention')
    assert.equal(github.parse(github.simulate({ event: 'comment', number: 3, user: 'ci[bot]', bot: true, text: 'red' })).triggers[0]!.human, false)
  })

  test('a merged pull request closes its Thread', () => {
    const { closed } = github.parse(github.simulate({ event: 'pr_merged', number: 8, user: 'bob' }))
    assert.deepEqual(closed, [{ ref: { source: 'github', id: 'pull:8' }, outcome: 'merged' }])
  })

  test('another repository is ignored', () => {
    const request = github.simulate({ event: 'comment', number: 3, user: 'alice', text: '/agent x' })
    const other = new GithubSource('github', { kind: 'github', repo: 'acme/other', account: 'agent-bot', dryRun: true })
    assert.equal(other.parse(request).triggers.length, 0)
  })
})

describe('GitLab', () => {
  process.env.TEST_GL_SECRET = 'tok'
  const gitlab = new GitlabSource('gitlab', { kind: 'gitlab', project: 'acme/app', account: 'agent-bot', secretEnv: 'TEST_GL_SECRET' })
  test('verifies the token and reads a note on an Issue', () => {
    const request = gitlab.simulate({ event: 'comment', number: 4, user: 'alice', text: '/agent explain' })
    assert.ok(gitlab.verify(request))
    assert.ok(!gitlab.verify({ ...request, headers: { 'x-gitlab-token': 'nope' } }))
    const [trigger] = gitlab.parse(request).triggers
    assert.equal(trigger!.threads[0]!.id, 'issue:4')
    assert.equal(trigger!.channel!.address.iid, '4')
  })
  test('access-token bots are not human', () => {
    const [trigger] = gitlab.parse(gitlab.simulate({ event: 'comment', number: 4, user: 'project_12_bot_ab', text: 'x' })).triggers
    assert.equal(trigger!.human, false)
  })
})

describe('Feishu', () => {
  const feishu = new FeishuSource('feishu', { kind: 'feishu', botOpenId: 'ou_bot', dryRun: true })
  test('answers the URL challenge', () => {
    const result = feishu.parse({ headers: {}, body: JSON.stringify({ type: 'url_verification', challenge: 'c1', token: '' }) })
    assert.deepEqual(result.response, { status: 200, body: { challenge: 'c1' } })
  })
  test('a mention is addressed, a topic reply joins the topic Thread, a direct message is direct', () => {
    const [mention] = feishu.parse(feishu.simulate({ event: 'comment', user: 'ou_a', chat: 'oc_1', text: '@agent 看看' })).triggers
    assert.equal(mention!.addressed, 'mention')
    assert.equal(mention!.text, '@agent 看看')
    const [reply] = feishu.parse(feishu.simulate({ event: 'comment', user: 'ou_a', chat: 'oc_1', root: 'om_root', text: '补充一下' })).triggers
    assert.equal(reply!.threads[0]!.id, 'chat:oc_1:om_root')
    assert.equal(reply!.addressed, undefined)
    const [direct] = feishu.parse(feishu.simulate({ event: 'comment', user: 'ou_a', direct: true, text: 'hi' })).triggers
    assert.equal(direct!.addressed, 'direct')
  })
  test("the bot's own messages are dropped", () => {
    assert.equal(feishu.parse(feishu.simulate({ event: 'comment', user: 'ou_bot', text: 'x' })).triggers.length, 0)
  })
})

describe('commands', () => {
  test('verbs in English and Chinese, with leading mentions', () => {
    assert.deepEqual(parseCommand('/agent summarize the crash'), { verb: 'summarize', kind: 'read', rest: 'the crash', known: true })
    assert.equal(parseCommand('@agent 总结一下这个问题')!.rest, '这个问题')
    assert.equal(parseCommand('@alice @agent-bot fix it')!.kind, 'write')
    assert.equal(parseCommand('/agent stop')!.kind, 'stop')
    assert.deepEqual(parseCommand('@agent why does it fail?'), { verb: 'why', kind: 'read', rest: 'does it fail?', known: true })
    assert.equal(parseCommand('just chatting'), undefined)
  })
})
