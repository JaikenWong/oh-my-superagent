/**
 * The Policy (docs/002): who may originate work through each Source, in that Source's own identities, the accept mode and
 * the proactive rules. The gate is the deterministic fast path; the Router's assessment is the slow path.
 */
import { createHash } from 'node:crypto'
import type { AcceptMode, ActorRef, AdmissionCell, Mandate, PolicyEffect, Thread, Ticket, Trigger } from './core/model.ts'
import type { AssessmentOutcome, GateResult, Policy, SourceScope } from './core/ports.ts'

export type Admission = 'explicit' | 'inferred' | 'ignore'
export interface AdmissionRow { listedUnaddressed?: 'inferred' | 'ignore'; unlistedAddressed?: Admission; unlistedUnaddressed?: 'inferred' | 'ignore' }
export interface Allowed { id: string; name?: string }
export interface SourcePolicy { allowed: Allowed[]; bots?: Allowed[]; admission?: AdmissionRow }
/** A kind of proactive work. `keywords` only feed the offline heuristic assessor. */
export interface Rule { id: string; name: string; enabled: boolean; instruction: string; keywords?: string[] }

export interface Settings {
  paused: boolean
  /** `review`: every outgoing message waits in the panel for a person's approval. */
  outbound: 'review' | 'auto'
  policy: { mode: AcceptMode; rules: Rule[]; sources: Record<string, SourcePolicy> }
  eval: { timeoutSeconds: number; assessor: 'heuristic' | 'claude' }
  /** Main Session backend: `claude` = real CLI Router; `mock` = deterministic offline. */
  router: { agent: 'mock' | 'claude' }
  executor: {
    maxWorkers: number
    agent: 'mock' | 'claude' | 'codex' | 'dsh'
    turnTimeoutMinutes: number
    /** Automatic Retry budget (Watchdog / host); Stop still forbids restart. */
    maxRetries: number
    blockedCommands: string[]
    prepare: string
    agentArgs: string[]
    /** Absolute path to a deepseek-harness checkout when `agent` is `dsh`; else `DSH_ROOT` / `DSH_BIN`. */
    dshRoot?: string
  }
  watchdog: { intervalMs: number }
}

export const ADMISSION_DEFAULTS: Required<AdmissionRow> = { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' }
const STRENGTH: Record<Admission, number> = { ignore: 0, inferred: 1, explicit: 2 }

export const DEFAULT_SETTINGS: Settings = {
  paused: false,
  outbound: 'auto',
  policy: {
    mode: 'observe',
    rules: [
      { id: 'typo', name: '文案/拼写修正', enabled: true, keywords: ['typo', '拼写', '错别字', 'misspell'],
        instruction: 'Explicit requests to correct a typo, wording or punctuation. Preserve product promises and business meaning.' },
      { id: 'repro', name: '静默复现', enabled: true, keywords: ['crash', 'exception', '报错', '崩溃', 'stack trace'],
        instruction: 'A bug report with concrete reproduction facts: reproduce it quietly; deliver only a confirmed simple fix, otherwise stay silent.' },
    ],
    sources: {},
  },
  eval: { timeoutSeconds: 120, assessor: 'heuristic' },
  router: { agent: 'mock' },
  executor: {
    maxWorkers: 2, agent: 'mock', turnTimeoutMinutes: 30, maxRetries: 3,
    blockedCommands: ['gh', 'glab', 'lark-cli'], prepare: '', agentArgs: [],
  },
  watchdog: { intervalMs: 60_000 },
}

/** Settings as a config file or the panel gives them: every block may be partial. */
export type SettingsInput = Partial<Pick<Settings, 'paused' | 'outbound'>> & {
  policy?: Partial<Settings['policy']>; eval?: Partial<Settings['eval']>
  router?: Partial<Settings['router']>; executor?: Partial<Settings['executor']>
  watchdog?: Partial<Settings['watchdog']>
}

/** Merges stored or configured settings over the defaults, refusing values the host cannot enforce. */
export function normalizeSettings(value: unknown): Settings {
  const input = (value ?? {}) as SettingsInput
  const settings: Settings = {
    ...DEFAULT_SETTINGS, ...input,
    policy: { ...DEFAULT_SETTINGS.policy, ...input.policy, sources: { ...input.policy?.sources } },
    eval: { ...DEFAULT_SETTINGS.eval, ...input.eval },
    router: { ...DEFAULT_SETTINGS.router, ...input.router },
    executor: { ...DEFAULT_SETTINGS.executor, ...input.executor },
    watchdog: { ...DEFAULT_SETTINGS.watchdog, ...input.watchdog },
  }
  const fail = (message: string): never => { throw new Error(`Invalid settings: ${message}`) }
  if (!['off', 'observe', 'auto'].includes(settings.policy.mode)) fail('policy.mode is off, observe or auto')
  if (!['review', 'auto'].includes(settings.outbound)) fail('outbound is review or auto')
  const ids = settings.policy.rules.map(rule => rule.id)
  if (new Set(ids).size !== ids.length) fail('duplicate rule ids')
  for (const rule of settings.policy.rules) if (!/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id) || !rule.instruction?.trim()) fail(`rule ${rule.id}`)
  if (!Number.isInteger(settings.executor.maxWorkers) || settings.executor.maxWorkers < 1 || settings.executor.maxWorkers > 16) fail('executor.maxWorkers is 1..16')
  if (!Number.isInteger(settings.executor.maxRetries) || settings.executor.maxRetries < 0 || settings.executor.maxRetries > 32) fail('executor.maxRetries is 0..32')
  if (!['mock', 'claude'].includes(settings.router.agent)) fail('router.agent is mock or claude')
  if (!['mock', 'claude', 'codex', 'dsh'].includes(settings.executor.agent)) fail('executor.agent is mock, claude, codex or dsh')
  if (!Number.isInteger(settings.watchdog.intervalMs) || settings.watchdog.intervalMs < 1000) fail('watchdog.intervalMs >= 1000')
  for (const [source, part] of Object.entries(settings.policy.sources)) {
    if (!Array.isArray(part.allowed)) fail(`policy.sources.${source}.allowed is a list`)
  }
  return settings
}

/** Hash of what authorizes work: rules, accept mode and the Sources' parts. Models, limits and pause do not count. */
export function policyVersion(settings: Settings): string {
  const { mode, rules, sources } = settings.policy
  return `p-${createHash('sha256').update(JSON.stringify({ mode, rules, sources })).digest('hex').slice(0, 10)}`
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export const allowedSender = (settings: Settings, actor: ActorRef): Allowed | undefined =>
  settings.policy.sources[actor.source]?.allowed.find(entry => same(entry.id, actor.id))
const listedBot = (settings: Settings, actor: ActorRef): Allowed | undefined =>
  settings.policy.sources[actor.source]?.bots?.find(entry => same(entry.id, actor.id))
const admissionOf = (settings: Settings, source: string, cell: AdmissionCell): Admission =>
  settings.policy.sources[source]?.admission?.[cell] ?? ADMISSION_DEFAULTS[cell]

/** Builds the current Policy; it is stateless and built fresh for each use. */
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings)
  const mode = settings.policy.mode
  const rulesOn = (rules: string[] = []) => rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
  const participating = (thread: Thread, tickets: Ticket[]) => thread.subscriptions.length > 0 || tickets.length > 0

  /** Bots: only listed ones, as inferred candidates at most, and only where they address the agent or every message is received. */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = listedBot(settings, trigger.actor)
    const scope = sources.scope(trigger)
    if (!bot || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
    return { admissible: true, strength: 'inferred', basis: { source: trigger.source, sender: bot.name ?? bot.id, via: 'bot', observation: { mode } } }
  }

  return {
    version,
    paused: settings.paused,
    evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    gate(trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger)
      const allowed = allowedSender(settings, trigger.actor)
      const recorded = { source: trigger.source, ...allowed ? { sender: allowed.name ?? allowed.id } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell: AdmissionCell = allowed ? 'listedUnaddressed' : trigger.addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
      // Unaddressed messages use the admission table only where the Source receives every message.
      const receivable = !!trigger.addressed || sources.scope(trigger).observed
      const admission = receivable ? admissionOf(settings, trigger.source, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell }
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // A follow-up on a Thread with Tickets: explicit from a listed sender, inferred otherwise; a stranger's direct message is never one.
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: rules => mode === 'auto' && rules.length > 0 && rulesOn(rules),
    revalidate(mandate: Mandate) {
      const { basis } = mandate
      if (!sources.scope({ source: basis.source, meta: {} }).listened) return false
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      if (basis.via === 'bot') return !!listedBot(settings, mandate.actor) && mode === 'auto' && rulesOn(basis.rules)
      if (basis.via === 'addressed') return !!allowedSender(settings, mandate.actor)
      // An admission-table Mandate holds while the sender's cell today grants at least its original strength.
      const listed = !!allowedSender(settings, mandate.actor)
      if (basis.cell === 'unlistedAddressed' && listed) return true
      const cell = basis.cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : basis.cell
      if (cell === 'listedUnaddressed' && !listed) return false
      if (STRENGTH[admissionOf(settings, basis.source, cell)] < STRENGTH[mandate.strength]) return false
      return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
    },
  }
}

/** Which live Tickets a settings change bears on, and how; unaffected Tickets get no notice. */
export function policyEffects(tickets: Ticket[], before: Settings, after: Settings, scope: SourceScope): Map<string, PolicyEffect> {
  const was = settingsPolicy(before, scope), now = settingsPolicy(after, scope)
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const old = before.policy.rules.find(rule => rule.id === id), next = after.policy.rules.find(rule => rule.id === id)
      if (!next?.enabled) return old?.enabled ? [{ id, change: 'disabled' }] : []
      return JSON.stringify(old) === JSON.stringify(next) ? [] : [{ id, change: 'changed', instruction: next.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (was.revalidate(ticket.mandate) && !now.revalidate(ticket.mandate)) {
      if (ticket.mandate.strength === 'inferred' && before.policy.mode === 'auto' && after.policy.mode !== 'auto') effect.proactive = false
      else effect.requesterAllowed = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}

/** What an assessor returns for an inferred candidate, after prompts/assess.md. */
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable'
  rule_assessments: { rule_id: string; matched: boolean; reason: string }[]
  direction: { implementation_requested: boolean; target_basis: 'specified' | 'existing-standard' | 'undetermined'; requires_design_decision: boolean; evidence: string }
  title?: string
  scope?: string
  reason: string
  intent_evidence?: string
  acknowledgement?: string
  worktree_name?: string
}

/**
 * Turns an assessment into an Engine outcome. Every enabled rule must be judged exactly once; an accept needs a settled
 * direction, a matched rule and intent evidence; outside `auto` it is recorded as "would accept" and nothing starts.
 */
export function assessmentOutcome(assessment: Assessment, settings: Settings): AssessmentOutcome {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = assessment.rule_assessments ?? []
  const ids = new Set(judged.map(item => item.rule_id))
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required')
  }
  const matches = judged.filter(item => item.matched)
  const audit = { rule_assessments: judged, direction: assessment.direction, ...assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {} }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  const { direction } = assessment
  if (!direction?.implementation_requested || direction.target_basis === 'undetermined' || direction.requires_design_decision) {
    return { kind: 'ignore', reason: { code: 'directionUnsettled' }, audit }
  }
  if (!matches.length) return { kind: 'ignore', reason: { code: 'noRuleMatched' }, audit }
  if (!assessment.intent_evidence) throw new Error('An accept requires intent_evidence')
  const title = assessment.title?.trim() || 'Proactive work'
  const scope = assessment.scope?.trim() || title
  if (settings.policy.mode !== 'auto') {
    return { kind: 'ignore', reason: { code: 'observed', values: { text: assessment.reason } }, audit: { ...audit, would_accept: true, proposal: { title, scope } } }
  }
  return {
    kind: 'accept', title, scope, capability: 'write', reason: assessment.reason, rules: matches.map(item => item.rule_id), audit,
    ...assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}, ...assessment.worktree_name ? { name: assessment.worktree_name } : {},
  }
}
