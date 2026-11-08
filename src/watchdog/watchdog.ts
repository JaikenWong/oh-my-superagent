/**
 * External Control Loop (design §11): Detector (pure) + Recovery Policy.
 * Does not execute Worker work; acts through Engine / Main Session inbox.
 */
import { canRetry, stageLabel, ticketStage } from '../core/stage.ts'
import type { Engine } from '../core/engine.ts'
import type { Ticket } from '../core/model.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../store/store.ts'
import type { OutboxStore } from '../store/outbox.ts'
import type { MainSession } from '../router/session.ts'

export interface WatchdogDeps {
  engine: () => Engine
  store: Store
  settings: () => Settings
  session: MainSession
  /** When set, Recovery Policy skips auto-retry if Ticket has in-flight / unknown outbound. */
  outbox?: OutboxStore
  /** Default 60s; tests may use a shorter interval. */
  intervalMs?: number
}

export interface WatchdogAction {
  at: string
  ticketId?: string
  action: string
  detail: string
}

export type DetectKind = 'stalled' | 'side_effect_unknown' | 'budget_exhausted' | 'stopped'

export class Watchdog {
  readonly #d: WatchdogDeps
  readonly actions: WatchdogAction[] = []
  #timer?: NodeJS.Timeout
  #running = false

  constructor(deps: WatchdogDeps) { this.#d = deps }

  start(): void {
    const ms = this.#d.intervalMs ?? this.#d.settings().watchdog.intervalMs
    this.#timer = setInterval(() => { void this.tick() }, ms)
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer)
    while (this.#running) await new Promise(resolve => setTimeout(resolve, 20))
  }

  /** One inspection pass; also used by tests and panel "run now". */
  async tick(): Promise<WatchdogAction[]> {
    if (this.#running) return []
    this.#running = true
    const taken: WatchdogAction[] = []
    try {
      const maxRetries = this.#d.settings().executor.maxRetries
      const open = this.#d.store.tickets.open()
      const summary = open.map(ticket => {
        const stage = stageLabel(ticketStage(ticket))
        const report = [...ticket.assignments].reverse().find(item => item.report)?.report
        return `- ${ticket.id} stage=${stage} report=${report?.state ?? 'none'} retry=${canRetry(ticket, maxRetries)} retries=${ticket.retries ?? 0}/${maxRetries}`
      }).join('\n') || '(no open tickets)'

      this.#d.session.enqueueWatchdog(`Watchdog inspection.\nOpen tickets:\n${summary}`)

      for (const ticket of open) {
        const decision = this.#policy(ticket, maxRetries)
        if (decision.action === 'skip') continue
        if (decision.action === 'note') {
          const action: WatchdogAction = {
            at: new Date().toISOString(), ticketId: ticket.id, action: 'note', detail: decision.detail,
          }
          taken.push(action)
          this.#record(action)
          this.#d.engine().note(ticket.id, decision.detail)
          this.#d.session.enqueueWatchdog(`Watchdog: ${ticket.id} — ${decision.detail}`)
          continue
        }
        try {
          this.#d.engine().retryTicket(ticket.id, maxRetries)
          const action: WatchdogAction = {
            at: new Date().toISOString(), ticketId: ticket.id, action: 'retry',
            detail: `Retried stalled Ticket ${ticket.title}`,
          }
          taken.push(action)
          this.#record(action)
          this.#d.engine().note(ticket.id, 'Watchdog retried this Ticket after detecting a stall.')
        } catch {
          /* cannot retry */
        }
      }
      if (!taken.length) {
        const action: WatchdogAction = { at: new Date().toISOString(), action: 'inspect', detail: `Inspected ${open.length} open Ticket(s); none retried.` }
        taken.push(action)
        this.#record(action)
      }
      return taken
    } finally {
      this.#running = false
    }
  }

  /** Recovery Policy: Detector flags stall; policy chooses retry vs pause. */
  #policy(ticket: Ticket, maxRetries: number): { action: 'retry' | 'note' | 'skip'; detail: string } {
    if (ticket.ended) return { action: 'skip', detail: 'ended' }
    if (!canRetry(ticket, maxRetries)) {
      if ((ticket.retries ?? 0) >= maxRetries && (ticket.attention || ticket.delivery)) {
        return { action: 'note', detail: `Retry budget exhausted (${ticket.retries}/${maxRetries}); waiting for a person.` }
      }
      return { action: 'skip', detail: 'not retryable' }
    }
    if (this.#hasUnknownSideEffect(ticket)) {
      return {
        action: 'note',
        detail: 'Outbound may already have succeeded (sending/unknown/proposal); not auto-retrying. Confirm on Source.',
      }
    }
    return { action: 'retry', detail: 'safe to retry' }
  }

  #hasUnknownSideEffect(ticket: Ticket): boolean {
    if (ticket.proposal) return true
    const outbox = this.#d.outbox
    if (!outbox) return false
    return outbox.list(undefined, ticket.id).some(item => item.status === 'sending' || item.status === 'unknown')
  }

  #record(action: WatchdogAction): void {
    this.actions.push(action)
    if (this.actions.length > 100) this.actions.splice(0, this.actions.length - 100)
  }
}
