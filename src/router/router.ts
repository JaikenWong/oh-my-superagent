/**
 * The Router is the Main Session role: a persistent session that routes and speaks. It does not execute Worker work.
 * Gate still filters noise; admissible candidates and worker reports are injected here; tools call the Engine.
 */
import type { Engine } from '../core/engine.ts'
import type { Assessor as AssessorPort } from '../core/ports.ts'
import type { Settings } from '../policy.ts'
import type { Effects } from '../store/effects.ts'
import type { Store } from '../store/store.ts'
import { MainSession } from './session.ts'

export interface RouterDeps {
  engine: () => Engine
  effects: Effects
  store: Store
  settings: () => Settings
  stateDir: string
}

export class Router implements AssessorPort {
  readonly session: MainSession
  readonly #d: RouterDeps

  constructor(deps: RouterDeps) {
    this.#d = deps
    this.session = new MainSession({
      engine: deps.engine, effects: deps.effects, store: deps.store, settings: deps.settings, stateDir: deps.stateDir,
    })
  }

  install(): void { this.session.install() }

  request(evalId: string): void { this.session.enqueueCandidate(evalId) }

  relayReport(ticketId: string, assignmentId: string): void { this.session.enqueueReport(ticketId, assignmentId) }

  relayFollowup(triggerId: string): void { this.session.enqueueFollowup(triggerId) }

  /** @deprecated Prefer relayFollowup; kept for Runtime emit wiring during transition. */
  followup(triggerId: string): void { this.relayFollowup(triggerId) }
}
