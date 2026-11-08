/** Ticket stages after docs/003: read top to bottom, the first matching row wins. Categories are exclusive and complete. */
import { latestAssignment, waitsForPerson, type Ticket } from './model.ts'

export type TicketStage =
  | { stage: 'person'; action: 'delivery' | 'answer' | 'review' | 'blocked' | 'failed' }
  | { stage: 'working'; action?: 'queued' }
  | { stage: 'idle' }
  | { stage: 'ended' }

export function ticketStage(ticket: Ticket): TicketStage {
  if (ticket.ended) return { stage: 'ended' }
  if (ticket.delivery) return { stage: 'person', action: 'delivery' }
  if (ticket.attention) return { stage: 'person', action: 'answer' }
  const assignment = latestAssignment(ticket)
  const report = assignment?.report?.state
  if (report === 'ready') return { stage: 'person', action: 'review' }
  if ((report === 'blocked' || report === 'failed') && waitsForPerson(ticket)) return { stage: 'person', action: report }
  if (!assignment || assignment.state === 'pending') return { stage: 'working', action: 'queued' }
  // A running Assignment works while a turn runs (`taking`) or Inputs wait for the next one; otherwise it waits for a Trigger.
  if (assignment.taking) return { stage: 'working' }
  if (assignment.state === 'ended' || !ticket.undelivered.length) return { stage: 'idle' }
  return { stage: 'working' }
}

export const stageLabel = (stage: TicketStage): string => stage.stage === 'person' ? `person/${stage.action}`
  : stage.stage === 'working' && stage.action ? 'working/queued' : stage.stage

/**
 * Retry is the remedy for a stalled Ticket: blocked or failed without a newer person's message, or a failed delivery.
 * Stopped / ended Tickets never retry (INV-7). `maxRetries` caps automatic recovery budget.
 */
export const canRetry = (ticket: Ticket, maxRetries = 3): boolean =>
  !ticket.ended && (ticket.retries ?? 0) < maxRetries && (waitsForPerson(ticket) || !!ticket.delivery)
