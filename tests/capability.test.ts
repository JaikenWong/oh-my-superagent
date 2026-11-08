/** Host Execution Policy helpers and dsh backend command shape. */
import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { dsh } from '../src/executor/agents.ts'
import { blockedGitSubcommands, CAPABILITY_MATRIX, permissionModeFor } from '../src/executor/capability.ts'

describe('capability matrix', () => {
  test('read cannot edit or commit; write still cannot push', () => {
    assert.equal(CAPABILITY_MATRIX.editFiles.read, false)
    assert.equal(CAPABILITY_MATRIX.gitCommit.read, false)
    assert.equal(CAPABILITY_MATRIX.gitPush.write, false)
    assert.equal(CAPABILITY_MATRIX.openPullRequest.write, 'host')
  })

  test('git shim blocks commit on read Mandates', () => {
    assert.ok(blockedGitSubcommands('read').includes('commit'))
    assert.ok(blockedGitSubcommands('read').includes('push'))
    assert.deepEqual(blockedGitSubcommands('write'), ['push'])
  })

  test('dsh permission modes map Mandate → harness presets', () => {
    assert.equal(permissionModeFor('read', 'dsh'), 'read-only')
    assert.equal(permissionModeFor('write', 'dsh'), 'workspace-write')
  })
})

describe('dsh backend', () => {
  test('command uses headless profile and capability permission mode', () => {
    const cmd = dsh.command({
      directory: '/tmp/work', prompt: 'summarize', sessionId: 's', resume: false, capability: 'read',
      lastMessagePath: '/tmp/last.md', extraArgs: [], dshRoot: undefined,
    })
    assert.ok(cmd.args.includes('headless') || cmd.args.includes('--profile'))
    assert.ok(cmd.args.includes('read-only'))
    assert.ok(cmd.args.includes('never'))
    assert.equal(cmd.input, 'summarize')
  })
})
