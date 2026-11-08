/**
 * Panel views (docs/005). The overview answers, in order: does anything need me now; is the system healthy and doing
 * the right things; and links to the history of one piece of work. A healthy state takes no space; every count equals
 * the length of the list it links to.
 */
import { readFileSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { latestReport, type Decision, type Thread, type Ticket, type TicketInput, type Trigger } from '../core/model.ts'
import { reasonText } from '../core/reasons.ts'
import { canRetry, stageLabel, ticketStage } from '../core/stage.ts'
import { inputCard } from '../executor/prompt.ts'
import type { Receipt } from '../store/outbox.ts'
import { codeHost } from './replies.ts'
import type { Runtime } from './runtime.ts'

const DAY = 24 * 3600 * 1000

/** What a label says: whom the row waits for and what it needs. */
export const STAGE_TEXT: Record<string, string> = {
  'person/delivery': '投递失败', 'person/answer': '待回答', 'person/review': '待评审', 'person/blocked': '受阻', 'person/failed': '失败',
  'working/queued': '排队中', working: '执行中', idle: '等待触发', ended: '已结束',
}
const OUTCOME_TEXT: Record<string, string> = { completed: '已完成', merged: 'PR 已合并', closed: 'PR 已关闭', dropped: '无需处理', stopped: '被人停止' }

export function ticketRow(ticket: Ticket, maxRetries = 3) {
  const stage = stageLabel(ticketStage(ticket))
  const report = latestReport(ticket)
  return {
    id: ticket.id, name: ticket.name, title: ticket.title, stage, stageText: ticket.ended ? OUTCOME_TEXT[ticket.ended.outcome] : STAGE_TEXT[stage],
    capability: ticket.mandate.capability, strength: ticket.mandate.strength, requester: `${ticket.mandate.actor.source}:${ticket.mandate.actor.id}`,
    report: report ? { state: report.state, summary: report.summary.slice(0, 240), at: report.at } : undefined,
    attention: ticket.attention?.question, delivery: ticket.delivery?.error,
    canRetry: canRetry(ticket, maxRetries), ended: ticket.ended, retries: ticket.retries ?? 0,
    follows: ticket.follows, proposal: ticket.proposal, createdAt: ticket.createdAt, updatedAt: ticket.updatedAt,
  }
}

function decisionRow(decision: Decision, runtime: Runtime) {
  const trigger = runtime.store.triggers.get(decision.triggerIds.at(-1)!)
  return {
    id: decision.id, at: decision.at, kind: decision.kind, strength: decision.strength, threadKey: decision.threadKey, ticketId: decision.ticketId,
    wouldAccept: decision.audit?.would_accept === true, reasons: decision.reason.map(reason => ({ ...reason, text: reasonText(reason) })),
    audit: decision.audit, dismissed: !!decision.dismissed, policyVersion: decision.policyVersion,
    trigger: trigger ? { id: trigger.id, source: trigger.source, from: trigger.actor.id, human: trigger.human, addressed: !!trigger.addressed, text: trigger.text.slice(0, 200), url: trigger.url } : undefined,
    allowable: !!trigger?.human && decision.reason.some(reason => reason.code === 'not_a_member')
      && !runtime.settings.policy.sources[trigger.source]?.allowed.some(entry => entry.id.toLowerCase() === trigger.actor.id.toLowerCase()),
  }
}

function receiptRow(receipt: Receipt, runtime: Runtime) {
  const ticket = receipt.ticketId ? runtime.store.tickets.get(receipt.ticketId) : undefined
  const replyTo = receipt.replyTo ? runtime.store.triggers.get(receipt.replyTo) : undefined
  return { ...receipt, ticketTitle: ticket?.title, replyToText: replyTo ? `${replyTo.actor.id}: ${replyTo.text.slice(0, 160)}` : undefined }
}

/** Unavailable Decisions that still need a person: under a day old, latest on their Thread, not dismissed, Thread idle. */
function unresolved(runtime: Runtime): Decision[] {
  const since = new Date(Date.now() - DAY).toISOString()
  return runtime.store.recentDecisions(200, since).filter(decision => {
    if (decision.kind !== 'unavailable' || decision.dismissed) return false
    const thread = runtime.store.threads.get(decision.threadKey)
    const latest = runtime.store.decisions.onThread(decision.threadKey).at(-1)
    return latest?.id === decision.id && !thread?.pending.length && !thread?.evaluating
  })
}

export function overview(runtime: Runtime) {
  const { store } = runtime
  const open = store.tickets.open()
  const since = new Date(Date.now() - DAY).toISOString()
  const decisions = store.recentDecisions(1000, since)
  const sources = runtime.registry.all()
  const problems = [
    ...runtime.effects.problems().map(item => ({ kind: `effect:${item.kind}`, text: `${item.kind} ${item.key} 已连续失败 ${item.attempts} 次：${item.error ?? ''}` })),
    ...sources.filter(source => source.enabled && !source.dryRun).flatMap(source => Object.entries(source.facts())
      .filter(([, value]) => value === 'missing').map(([name]) => ({ kind: `source:${source.id}`, text: `来源 ${source.id} 缺少 ${name}` }))),
    ...codeHost(runtime) ? [] : [{ kind: 'setup', text: '没有可开 PR 的代码托管来源（github/gitlab）' }],
    ...[...runtime.sourceProblems].map(([id, text]) => ({ kind: `source:${id}`, text: `来源 ${id} 启动失败：${text}` })),
  ]
  return {
    needs: {
      drafts: runtime.outbox.list('draft').reverse().map(receipt => receiptRow(receipt, runtime)),
      tickets: open.filter(ticket => ticketStage(ticket).stage === 'person').map(ticketRow),
      unavailable: unresolved(runtime).map(decision => decisionRow(decision, runtime)),
      /** People not on the list who called the agent: the one-click way to learn a Feishu open_id or a login. */
      refused: decisions.map(decision => decisionRow(decision, runtime)).filter(row => row.allowable && row.trigger?.addressed)
        .filter((row, index, rows) => rows.findIndex(other => other.trigger?.from === row.trigger?.from && other.trigger?.source === row.trigger?.source) === index),
    },
    problems,
    activity: {
      triggers: store.count('SELECT count(*) AS n FROM trigger WHERE at >= ?', since),
      accepted: decisions.filter(item => item.kind === 'accept').length,
      wouldAccept: decisions.filter(item => item.audit?.would_accept === true).length,
      ignored: decisions.filter(item => item.kind === 'ignore' && item.audit?.would_accept !== true).length,
      stopped: decisions.filter(item => item.kind === 'stop').length,
      sent: store.count("SELECT count(*) AS n FROM outbox WHERE status = 'sent' AND json ->> '$.sentAt' >= ?", since),
    },
    load: { ...runtime.executor.load, open: open.length, working: open.filter(ticket => ticketStage(ticket).stage === 'working').length },
    system: { paused: runtime.settings.paused, mode: runtime.settings.policy.mode, outbound: runtime.settings.outbound,
      router: runtime.settings.router.agent, agent: runtime.settings.executor.agent,
      assessor: runtime.settings.eval.assessor, policyVersion: runtime.policyVersion, repository: runtime.deployment.repository },
    sources: sources.map(source => ({ id: source.id, kind: source.kind, enabled: source.enabled, facts: source.facts() })),
    router: { log: runtime.router.session.recentLog, inbox: runtime.store.kv<{ kind: string; key: string; at: string }[]>('router:inbox')?.length ?? 0 },
    watchdog: { actions: runtime.watchdog.actions.slice(-20).reverse() },
  }
}

export function tickets(runtime: Runtime, filter: string) {
  const all = runtime.store.allTickets(300)
  const rows = all.map(ticket => ticketRow(ticket, runtime.settings.executor.maxRetries))
  if (filter === 'open') return rows.filter(row => !row.ended)
  if (filter === 'ended') return rows.filter(row => row.ended)
  if (filter && filter !== 'all') return rows.filter(row => row.stage.startsWith(filter))
  return rows
}

export function ticketDetail(runtime: Runtime, id: string) {
  const { store } = runtime
  const ticket = store.tickets.get(id)
  if (!ticket) return undefined
  const trigger = (triggerId: string) => store.triggers.get(triggerId)
  const decision = store.decisions.get(ticket.decisionId)
  return {
    ...ticketRow(ticket, runtime.settings.executor.maxRetries),
    mandate: ticket.mandate,
    decision: decision ? decisionRow(decision, runtime) : undefined,
    origin: ticket.origin.triggerIds.flatMap(item => trigger(item) ?? []),
    inputs: ticket.inputs.map((input: TicketInput) => ({ ...inputCard(input, trigger), delivered: !ticket.undelivered.includes(input.id) })),
    assignments: ticket.assignments.slice().reverse(),
    artifacts: ticket.artifacts.slice().reverse(),
    execution: ticket.execution,
    messages: runtime.outbox.list(undefined, ticket.id).map(receipt => receiptRow(receipt, runtime)),
    events: store.eventsFor('ticket', ticket.id, 100),
  }
}

function threadRow(thread: Thread, runtime: Runtime) {
  const decisions = runtime.store.decisions.onThread(thread.key)
  return {
    key: thread.key, label: thread.meta.label, url: thread.meta.url, lastAt: thread.lastAt, pending: thread.pending.length,
    evaluating: !!thread.evaluating, subscriptions: thread.subscriptions, lastDecision: decisions.at(-1) ? decisionRow(decisions.at(-1)!, runtime) : undefined,
  }
}

export function threads(runtime: Runtime, filter: string) {
  const rows = runtime.store.recentThreads(200).map(thread => threadRow(thread, runtime))
  if (filter === 'subscribed') return rows.filter(row => row.subscriptions.length)
  if (filter === 'evaluating') return rows.filter(row => row.evaluating || row.pending)
  return rows
}

export function threadDetail(runtime: Runtime, key: string) {
  const { store } = runtime
  const thread = store.threads.get(key)
  if (!thread) return undefined
  const triggers = store.triggers.onThread(key, 500).map((trigger: Trigger) => ({ ...trigger, disposition: store.triggers.disposition(trigger.id) }))
  return {
    ...threadRow(thread, runtime), correlated: thread.correlated, evaluation: thread.evaluating,
    triggers, decisions: store.decisions.onThread(key).map(decision => decisionRow(decision, runtime)).reverse(),
    messages: runtime.outbox.forConversation(key).map(receipt => receiptRow(receipt, runtime)),
    tickets: thread.subscriptions.flatMap(id => store.tickets.get(id) ?? []).map(ticketRow),
  }
}

export function decisions(runtime: Runtime, filter: string) {
  const rows = runtime.store.recentDecisions(300).map(decision => decisionRow(decision, runtime))
  if (filter === 'would_accept') return rows.filter(row => row.wouldAccept)
  if (filter) return rows.filter(row => row.kind === filter)
  return rows
}

/** An artifact's text; only files under the state directory are readable. */
export function artifact(runtime: Runtime, path: string): string | undefined {
  const full = resolve(path)
  if (!full.startsWith(resolve(runtime.deployment.stateDir) + sep)) return undefined
  try { return readFileSync(full, 'utf8').slice(0, 512 * 1024) } catch { return undefined }
}
