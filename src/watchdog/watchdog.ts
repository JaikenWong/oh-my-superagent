/**
 * External Control Loop (article §6): a timer-driven Session that watches stalled Tickets and can retry / note / stop.
 * It does not execute Worker work; it only calls Engine tools through the Main Session inbox or directly.
 */
import { canRetry, stageLabel, ticketStage } from '../core/stage.ts'
import type { Engine } from '../core/engine.ts'
import type { Settings } from '../policy.ts'
import type { Store } from '../store/store.ts'
import type { MainSession } from '../router/session.ts'

export interface WatchdogDeps {
  engine: () => Engine
  store: Store
  settings: () => Settings
  session: MainSession
  /** Default 60s; tests may use a shorter interval. */
  intervalMs?: number
}

export interface WatchdogAction {
  at: string
  ticketId?: string
  action: string
  detail: string
}

export class Watchdog {
  readonly #d: WatchdogDeps
  readonly actions: WatchdogAction[] = []
  #timer?: NodeJS.Timeout
  #running = false

  constructor(deps: WatchdogDeps) { this.#d = deps }

  start(): void {
    const ms = this.#d.intervalMs ?? 60_000
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
      const open = this.#d.store.tickets.open()
      const summary = open.map(ticket => {
        const stage = stageLabel(ticketStage(ticket))
        const report = [...ticket.assignments].reverse().find(item => item.report)?.report
        return `- ${ticket.id} stage=${stage} report=${report?.state ?? 'none'} retry=${canRetry(ticket)}`
      }).join('\n') || '(no open tickets)'

      this.#d.session.enqueueWatchdog(`Watchdog inspection.\nOpen tickets:\n${summary}`)

      for (const ticket of open) {
        if (!canRetry(ticket)) continue
        try {
          this.#d.engine().retryTicket(ticket.id)
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

  #record(action: WatchdogAction): void {
    this.actions.push(action)
    if (this.actions.length > 100) this.actions.splice(0, this.actions.length - 100)
  }
}
