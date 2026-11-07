/**
 * Formats domain events as Main Session inbox prose (article §2: Worker reports relay to Router).
 * The mock Router consumes structured inbox items; these strings feed logs and a future LLM turn.
 */
import { latestReport, type Ticket } from '../core/model.ts'
import { stageLabel, ticketStage } from '../core/stage.ts'
import type { Store } from '../store/store.ts'

export function reportRelay(store: Store, ticketId: string, assignmentId: string): string {
  const ticket = store.tickets.get(ticketId)
  if (!ticket) return `Worker report for missing Ticket ${ticketId}.`
  const assignment = ticket.assignments.find(item => item.id === assignmentId)
  const report = assignment?.report ?? latestReport(ticket)
  const bits = [
    `Worker report on Ticket ${ticket.id} (${ticket.title}).`,
    `Stage: ${stageLabel(ticketStage(ticket))}.`,
    report ? `State: ${report.state}. Summary: ${report.summary}` : 'No report body.',
  ]
  if (report?.question) bits.push(`Question for person: ${report.question}`)
  if (report?.reply) bits.push(`Suggested reply:\n${report.reply.slice(0, 1500)}`)
  if (ticket.proposal) bits.push(`Pull request proposed: ${ticket.proposal.title}`)
  return bits.join('\n')
}

export function followupRelay(store: Store, triggerId: string): string {
  const trigger = store.triggers.get(triggerId)
  if (!trigger) return `Follow-up ${triggerId} missing.`
  return `Person follow-up on owned Thread from ${trigger.actor.id}:\n${trigger.text.slice(0, 800)}\n(You may only stop the Ticket if they asked to stop.)`
}

export function candidateCard(store: Store, evalId: string, engineCandidate: unknown): string {
  return `Eval candidate ${evalId} for Main Session routing.\n${JSON.stringify(engineCandidate, null, 2).slice(0, 6000)}`
}

export function ticketBrief(ticket: Ticket): string {
  return `${ticket.id} | ${stageLabel(ticketStage(ticket))} | ${ticket.title}`
}
