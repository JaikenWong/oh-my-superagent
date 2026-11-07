/**
 * Persistent Main Session inbox: candidates, worker relays and follow-ups coalesce into turns.
 * `router.agent=claude` runs a real Claude CLI turn (JSON actions → host tools); `mock` stays offline-deterministic.
 */
import { mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Engine } from '../core/engine.ts'
import type { Settings } from '../policy.ts'
import type { Effects } from '../store/effects.ts'
import type { Store } from '../store/store.ts'
import { runClaudeRouterTurn } from './claude-router.ts'
import { type InboxItem, runMockRouterTurn } from './mock-router.ts'
import type { ToolHost } from './tools.ts'

export interface MainSessionDeps {
  engine: () => Engine
  effects: Effects
  store: Store
  settings: () => Settings
  stateDir: string
}

interface InboxRow { kind: InboxItem['kind']; key: string; payload: string; at: string }

export class MainSession {
  readonly #d: MainSessionDeps
  readonly #log: string[] = []
  #busy = false

  constructor(deps: MainSessionDeps) { this.#d = deps }

  get recentLog(): string[] { return this.#log.slice(-40) }

  install(): void {
    this.#d.effects.handle('router-turn', () => this.#turn(), { concurrency: 1, baseMs: 1000, maxMs: 60_000, pausable: true })
  }

  enqueueCandidate(evalId: string): void {
    this.#push({ kind: 'candidate', key: `eval:${evalId}`, evalId })
  }

  enqueueReport(ticketId: string, assignmentId: string): void {
    this.#push({ kind: 'report', key: `report:${ticketId}:${assignmentId}`, ticketId, assignmentId })
  }

  enqueueFollowup(triggerId: string): void {
    this.#push({ kind: 'followup', key: `followup:${triggerId}`, triggerId })
  }

  enqueueWatchdog(text: string): void {
    this.#push({ kind: 'watchdog', key: `watchdog:${Date.now()}`, text })
  }

  #push(item: InboxItem): void {
    this.#d.store.atomic(() => {
      const rows = this.#d.store.kv<InboxRow[]>('router:inbox') ?? []
      if (rows.some(row => row.key === item.key)) {
        this.#d.effects.enqueue('router-turn', 'main')
        return
      }
      rows.push({
        kind: item.kind, key: item.key, at: new Date().toISOString(),
        payload: JSON.stringify(item),
      })
      this.#d.store.setKv('router:inbox', rows)
      this.#d.effects.enqueue('router-turn', 'main')
    })
  }

  async #turn(): Promise<void> {
    if (this.#busy) return
    this.#busy = true
    try {
      const items = this.#d.store.atomic(() => {
        const rows = this.#d.store.kv<InboxRow[]>('router:inbox') ?? []
        this.#d.store.setKv('router:inbox', [])
        return rows.map(row => JSON.parse(row.payload) as InboxItem)
      })
      if (!items.length) return
      this.#note(`turn: ${items.map(item => item.kind).join(',')}`)
      const host: ToolHost = { engine: this.#d.engine, store: this.#d.store }
      const settings = this.#d.settings()
      if (settings.router.agent === 'claude') await runClaudeRouterTurn(host, settings, items, line => this.#note(line))
      else await runMockRouterTurn(host, settings, items)
      this.#persist(items)
    } finally {
      this.#busy = false
      const pending = this.#d.store.kv<InboxRow[]>('router:inbox') ?? []
      if (pending.length) this.#d.effects.enqueue('router-turn', 'main')
    }
  }

  #note(line: string): void {
    const text = `${new Date().toISOString()} ${line}`
    this.#log.push(text)
    if (this.#log.length > 200) this.#log.splice(0, this.#log.length - 200)
  }

  #persist(items: InboxItem[]): void {
    try {
      const dir = join(this.#d.stateDir, 'router')
      mkdirSync(dir, { recursive: true })
      appendFileSync(join(dir, 'session.log'), `${new Date().toISOString()} processed ${items.length}: ${items.map(i => i.kind).join(',')}\n`)
      writeFileSync(join(dir, 'last-turn.json'), JSON.stringify({ at: new Date().toISOString(), items }, null, 2))
    } catch { /* demo state dir may be read-only in some tests */ }
  }
}
