/**
 * The `reply` effect: sends an approved Outbox message through its Source. A pull request proposal is opened on the
 * repository's code host, bound to its Ticket, and announced once in the conversation the request came from.
 */
import { key } from '../core/ids.ts'
import type { Engine } from '../core/engine.ts'
import type { Deployment } from '../config.ts'
import type { SourceKind } from '../sources/kind.ts'
import type { SourceRegistry } from '../sources/registry.ts'
import { Later, type Effects } from '../store/effects.ts'
import type { OutboxStore, Receipt } from '../store/outbox.ts'
import type { Store } from '../store/store.ts'

export interface RepliesDeps { store: Store; effects: Effects; outbox: OutboxStore; registry: SourceRegistry; engine: () => Engine; deployment: Deployment }

/** The Source that hosts the repository's pull requests. */
export function codeHost(deps: Pick<RepliesDeps, 'registry' | 'deployment'>): SourceKind | undefined {
  const id = deps.deployment.repository.source
  return id ? deps.registry.get(id) : deps.registry.all().find(source => source.kind !== 'feishu' && source.enabled)
}

export function installReplies(deps: RepliesDeps): void {
  const { store, outbox, registry } = deps
  const failed = (receipt: Receipt, error: unknown): never => {
    receipt.attempts += 1
    receipt.status = 'failed'
    receipt.error = (error instanceof Error ? error.message : String(error)).slice(0, 500)
    outbox.save(receipt)
    store.events.append('outbox.failed', { messageId: receipt.id, ticketId: receipt.ticketId, attempts: receipt.attempts, error: receipt.error })
    // Re-queue limited retries via pending status for the effect runner.
    if (receipt.attempts < 3) {
      receipt.status = 'pending'
      outbox.save(receipt)
    }
    throw error
  }
  const sent = (receipt: Receipt, url?: string, number?: number) => {
    Object.assign(receipt, { status: 'sent', sentAt: new Date().toISOString(), ...url ? { result: { url, ...number ? { number } : {} } } : {} })
    delete receipt.error
    outbox.save(receipt)
    store.events.append('outbox.sent', { messageId: receipt.id, ticketId: receipt.ticketId, purpose: receipt.purpose, idempotencyKey: receipt.idempotencyKey, ...url ? { url } : {} })
  }
  deps.effects.handle('reply', async id => {
    const receipt = outbox.get(id)
    if (!receipt || (receipt.status !== 'pending' && receipt.status !== 'failed')) return
    if (receipt.status === 'failed' && receipt.attempts >= 3) return
    if (outbox.behind(receipt)) throw new Later(5000, 'an earlier message of this Ticket to this conversation has not gone out')
    outbox.markSending(id)
    const live = outbox.get(id)!
    if (live.purpose === 'pull_request') {
      const host = codeHost(deps)
      if (!host?.openPullRequest) { outbox.drop(live, 'noCodeHost'); return }
      if (!host.enabled) {
        live.status = 'pending'
        outbox.save(live)
        throw new Later(5000, 'the code host Source is off')
      }
      const pull = await host.openPullRequest(live.pullRequest!).catch(error => failed(live, error))
      store.atomic(() => {
        sent(live, pull.url, pull.number)
        if (live.ticketId) deps.engine().bindThread(live.ticketId, pull.ref, true, pull.url)
        if (live.channel.source !== 'repository') {
          outbox.send({ id: key('msg', id, 'link'), ticketId: live.ticketId, purpose: 'result', channel: live.channel, text: `PR 草稿已创建：${pull.url}`, idempotencyKey: key('idem', id, 'link') }, true)
        }
      })
      return
    }
    const source = registry.get(live.channel.source)
    // A message is dropped only when its Source no longer listens to the conversation; while its Source is off, it waits.
    if (!source) { outbox.drop(live, 'channelIgnored'); return }
    if (!source.enabled) {
      live.status = 'pending'
      outbox.save(live)
      throw new Later(5000, 'the Source is off')
    }
    const result = await source.send(live).catch(error => failed(live, error))
    store.atomic(() => result.status === 'gone' ? outbox.drop(live, 'channelGone') : sent(live, result.url))
  }, { concurrency: 1, baseMs: 5000, maxMs: 300_000, pausable: true })
}
