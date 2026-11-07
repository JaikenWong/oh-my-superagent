/** Commands people address to the agent: `/agent <verb> <request>` or `@agent <verb> <request>`, in English or Chinese. */
import type { Capability } from '../core/model.ts'

export type CommandKind = Capability | 'stop'
export interface Command { verb: string; kind: CommandKind; rest: string; known: boolean }

const VERBS: Record<string, { kind: CommandKind; label: string; en: string }> = {}
const add = (kind: CommandKind, label: string, en: string, ...names: string[]) => { for (const name of names) VERBS[name] = { kind, label, en } }
add('read', '总结', 'summarize', 'summarize', 'summary', 'tldr', '总结', '概括')
add('read', '分析', 'analyze', 'analyze', 'analyse', 'investigate', 'triage', 'debug', '分析', '排查', '定位')
add('read', '解释', 'explain', 'explain', 'why', '解释', '说明')
add('read', '评审', 'review', 'review', '评审', '审查')
add('read', '回答', 'answer', 'ask', 'question', '问', '回答')
add('write', '修复', 'fix', 'fix', '修复', '修')
add('write', '实现', 'implement', 'implement', 'add', 'build', '实现', '添加', '新增')
add('write', '修改', 'change', 'change', 'refactor', 'update', 'rename', '修改', '改', '重构')
add('stop', '停止', 'stop', 'stop', 'cancel', 'abort', '停止', '取消', '停')

const CJK = /[\u4e00-\u9fff]/
const ADDRESS = /^(?:(?:\/agent\b|@[\w.\-[\]]+)[\s,，:：]*)+/i

/** The first line that addresses the agent, as a command; unknown verbs are an `ask` with the whole text. */
export function parseCommand(text: string): Command | undefined {
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const address = line.match(ADDRESS)
    if (!address) continue
    const body = line.slice(address[0].length).trim()
    const token = body.split(/\s+/)[0] ?? ''
    const verb = Object.keys(VERBS).sort((a, b) => b.length - a.length)
      .find(name => CJK.test(name) ? token.startsWith(name) : token.toLowerCase() === name)
    if (!verb) return { verb: 'ask', kind: 'read', rest: body, known: false }
    const rest = CJK.test(verb) ? body.slice(verb.length).replace(/^[一下个]+/, '').trim() : body.slice(token.length).trim()
    return { verb, kind: VERBS[verb]!.kind, rest, known: true }
  }
  return undefined
}

export const verbLabel = (verb: string) => VERBS[verb]?.label ?? '处理'
export const verbEnglish = (verb: string) => VERBS[verb]?.en ?? 'answer'
