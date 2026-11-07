/** The report protocol: a worker ends its final message with one fenced JSON block. Anything else is not a report. */
import type { ReportState } from '../core/model.ts'
import type { WorkerReport } from '../core/engine.ts'

const STATES: ReportState[] = ['progress', 'waiting', 'ready', 'blocked', 'failed', 'dropped']

interface RawReport {
  state?: string; summary?: string; reply?: string; reply_to?: string; question?: string; question_to?: string
  pull_request?: { title?: string; body?: string } | null; handbacks?: { trigger_id?: string; reason?: string }[]; acked?: string[]
}

/** The last fenced JSON block of the text, as a report; an explanation when there is none or it is malformed. */
export function extractReport(text: string): { report: WorkerReport } | { error: string } {
  const blocks = [...text.matchAll(/```json\s*\n([\s\S]*?)\n\s*```/g)]
  const last = blocks.at(-1)?.[1]
  if (!last) return { error: 'The worker ended its turn without a report block.' }
  let raw: RawReport
  try { raw = JSON.parse(last) as RawReport } catch (error) { return { error: `The report block is not JSON: ${(error as Error).message}` } }
  if (!raw.state || !STATES.includes(raw.state as ReportState)) return { error: `The report state must be one of ${STATES.join(', ')}.` }
  if (typeof raw.summary !== 'string' || !raw.summary.trim()) return { error: 'The report needs a summary.' }
  const text_ = (value: unknown, max: number) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
  const report: WorkerReport = { state: raw.state as ReportState, summary: raw.summary.trim() }
  const reply = text_(raw.reply, 20_000), replyTo = text_(raw.reply_to, 200), question = text_(raw.question, 1000), questionTo = text_(raw.question_to, 200)
  if (reply) report.reply = reply
  if (reply && replyTo) report.replyTo = replyTo
  if (question) report.question = question
  if (question && questionTo) report.questionTo = questionTo
  const title = text_(raw.pull_request?.title, 200)
  if (title) report.pullRequest = { title, body: text_(raw.pull_request?.body, 20_000) ?? '' }
  const handbacks = (raw.handbacks ?? []).flatMap(item => item.trigger_id && item.reason ? [{ triggerId: item.trigger_id, reason: item.reason.slice(0, 300) }] : [])
  if (handbacks.length) report.handbacks = handbacks
  const acked = (raw.acked ?? []).filter((id): id is string => typeof id === 'string')
  if (acked.length) report.acked = acked
  return { report }
}
