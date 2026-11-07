/**
 * The composition root: builds the parts with the narrow interfaces they use, and owns startup, the pass loop and
 * shutdown. It holds no domain rule.
 */
import { join } from 'node:path'
import { Engine } from '../core/engine.ts'
import { liveTicket } from '../core/model.ts'
import type { Deployment } from '../config.ts'
import { WorkerExecutor } from '../executor/executor.ts'
import type { AgentBackend } from '../executor/agents.ts'
import { normalizeSettings, policyEffects, policyVersion, settingsPolicy, type Settings } from '../policy.ts'
import { Router } from '../router/router.ts'
import type { SimulateInput, WebhookRequest, WebhookResult } from '../sources/kind.ts'
import { SourceRegistry } from '../sources/registry.ts'
import { Effects } from '../store/effects.ts'
import { OutboxStore } from '../store/outbox.ts'
import { Store } from '../store/store.ts'
import { Watchdog } from '../watchdog/watchdog.ts'
import { installReplies } from './replies.ts'

export interface RuntimeOptions {
  /** `:memory:` for tests. */
  database?: string
  backend?: (settings: Settings) => AgentBackend
  passMs?: number
  /** Watchdog interval; `0` disables the timer (tests still call `watchdog.tick()`). */
  watchdogMs?: number
}
interface SettingsRecord { revision: number; at: string; origin: string; version: string; value: Settings }

export class Runtime {
  readonly deployment: Deployment
  readonly store: Store
  readonly effects: Effects
  readonly outbox: OutboxStore
  readonly registry: SourceRegistry
  readonly engine: Engine
  readonly executor: WorkerExecutor
  readonly router: Router
  readonly watchdog: Watchdog
  #settings: Settings
  #timer?: NodeJS.Timeout
  readonly #passMs: number
  readonly #watchdogMs: number

  constructor(deployment: Deployment, options: RuntimeOptions = {}) {
    this.deployment = deployment
    this.#passMs = options.passMs ?? 1000
    this.#watchdogMs = options.watchdogMs ?? 60_000
    this.store = new Store(options.database ?? join(deployment.stateDir, 'superagent.sqlite'))
    this.#settings = normalizeSettings(this.store.kv<SettingsRecord>('settings')?.value ?? deployment.settings)
    this.registry = new SourceRegistry(deployment.sources)
    this.effects = new Effects(this.store, () => this.#settings.paused)
    this.outbox = new OutboxStore(this.store, this.effects, () => this.#settings.outbound === 'review')
    let engine: Engine | undefined
    const getEngine = () => engine!
    this.router = new Router({
      engine: getEngine, effects: this.effects, store: this.store, settings: () => this.#settings, stateDir: deployment.stateDir,
    })
    this.executor = new WorkerExecutor({
      engine: getEngine, store: this.store, effects: this.effects, outbox: this.outbox, settings: () => this.#settings, deployment,
      variables: () => this.registry.environment(), ...options.backend ? { backend: options.backend } : {},
    })
    engine = new Engine({
      repo: this.store,
      policy: () => settingsPolicy(this.#settings, this.registry),
      scope: this.registry,
      assessor: this.router,
      executor: this.executor,
      outbox: this.outbox,
    })
    this.engine = engine
    this.watchdog = new Watchdog({
      engine: getEngine, store: this.store, settings: () => this.#settings, session: this.router.session,
      ...this.#watchdogMs > 0 ? { intervalMs: this.#watchdogMs } : {},
    })
    this.router.install()
    this.executor.install()
    installReplies({ store: this.store, effects: this.effects, outbox: this.outbox, registry: this.registry, engine: getEngine, deployment })
  }

  get settings(): Settings { return this.#settings }
  get policyVersion(): string { return policyVersion(this.#settings) }

  /** Problems a Source met at start, such as a Feishu app whose bot capability is off; shown until a restart fixes them. */
  readonly sourceProblems = new Map<string, string>()

  start(): void {
    for (const source of this.registry.all()) {
      if (!source.enabled || !source.start) continue
      source.start().catch(error => {
        const text = error instanceof Error ? error.message : String(error)
        this.sourceProblems.set(source.id, text)
        console.error(`source ${source.id}: ${text}`)
      })
    }
    this.engine.recover()
    this.effects.start(this.#passMs)
    this.#timer = setInterval(() => this.pass(), this.#passMs)
    if (this.#watchdogMs > 0) this.watchdog.start()
  }

  /** One pass: the Evals that are due, then the effects that are due. */
  pass(): void {
    try { this.engine.evaluateDue() } catch (error) { console.error('pass failed', error) }
    this.effects.tick()
  }

  async stop(): Promise<void> {
    clearInterval(this.#timer)
    await this.watchdog.stop()
    await this.executor.shutdown()
    await this.effects.drain()
    this.store.close()
  }

  /** A webhook: verified and translated by its Source, then received by the Engine in one transaction. */
  ingest(sourceId: string, request: WebhookRequest): { status: number; body: unknown } {
    const source = this.registry.get(sourceId)
    if (!source) return { status: 404, body: { error: 'unknown source' } }
    if (!source.verify(request)) return { status: 401, body: { error: 'signature or token mismatch' } }
    let result: WebhookResult
    try { result = source.parse(request) } catch (error) { return { status: 400, body: { error: `unreadable payload: ${(error as Error).message}` } } }
    if (result.response) return result.response
    const received = this.store.atomic(() => {
      for (const thread of result.threads ?? []) this.engine.describeThread(thread.ref, thread.meta)
      const outcomes = result.triggers.map(trigger => ({ id: trigger.id, result: this.engine.receive(trigger) }))
      for (const opened of result.opened ?? []) {
        const name = opened.branch.split('/').at(-1)
        const ticket = this.store.tickets.open().find(item => item.name === name && item.execution?.branch === opened.branch)
        if (ticket) this.engine.bindThread(ticket.id, opened.ref, true, opened.url)
      }
      for (const closed of result.closed ?? []) this.engine.threadClosed(closed.ref, closed.outcome)
      return outcomes
    })
    this.effects.poke()
    return { status: 200, body: { received } }
  }

  simulate(sourceId: string, input: SimulateInput): { status: number; body: unknown } {
    const source = this.registry.get(sourceId)
    if (!source) return { status: 404, body: { error: 'unknown source' } }
    return this.ingest(sourceId, source.simulate(input))
  }

  /** Saves settings as a new revision; a new Policy version restarts running Evals and tells the live Tickets it bears on. */
  saveSettings(value: unknown, origin: 'panel' | 'config'): SettingsRecord {
    const next = normalizeSettings(value)
    return this.store.atomic(() => {
      const before = this.#settings
      const previous = this.store.kv<SettingsRecord>('settings')
      const record: SettingsRecord = { revision: (previous?.revision ?? 0) + 1, at: new Date().toISOString(), origin, version: policyVersion(next), value: next }
      this.store.setKv('settings', record)
      this.store.setKv(`settings:${record.revision}`, record)
      this.#settings = next
      this.store.events.append('settings.saved', { revision: record.revision, origin, version: record.version })
      if (policyVersion(before) !== record.version) {
        const tickets = this.store.tickets.open().filter(liveTicket)
        this.engine.policyChanged(policyVersion(before), record.version, policyEffects(tickets, before, next, this.registry))
      }
      return record
    })
  }

  settingsHistory(): Omit<SettingsRecord, 'value'>[] {
    const current = this.store.kv<SettingsRecord>('settings')?.revision ?? 0
    const items: Omit<SettingsRecord, 'value'>[] = []
    for (let revision = current; revision > 0 && items.length < 20; revision--) {
      const record = this.store.kv<SettingsRecord>(`settings:${revision}`)
      if (record) items.push({ revision: record.revision, at: record.at, origin: record.origin, version: record.version })
    }
    return items
  }

  /** Adds a sender to a Source's allowed list, in that Source's own identity: a new Policy version. */
  allow(source: string, id: string, name?: string): void {
    const settings = structuredClone(this.#settings)
    const part = settings.policy.sources[source] ??= { allowed: [] }
    if (part.allowed.some(entry => entry.id.toLowerCase() === id.toLowerCase())) return
    part.allowed.push({ id, ...name ? { name } : {} })
    this.saveSettings(settings, 'panel')
  }

  pause(paused: boolean): void {
    this.saveSettings({ ...this.#settings, paused }, 'panel')
  }
}
