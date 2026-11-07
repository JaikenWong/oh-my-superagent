/** Why the core recorded a Decision or set a Trigger aside: a code with values, optionally for one Trigger of a batch. */
export interface Reason { code: string; values?: Record<string, string>; triggerId?: string }

/** Words an assessor or a person wrote. */
export const said = (text: string): Reason => ({ code: 'said', values: { text } })

const TEXT: Record<string, string> = {
  said: '{text}',
  not_a_member: '发送者不在允许列表',
  no_mention: '未直接呼叫 agent',
  admission_ignored: '准入表忽略此类消息',
  not_human: '非人类消息且不在 bot 列表',
  source_off: '来源未启用',
  noAdmissible: '批次内没有可准入的触发',
  startedTicket: '该触发已创建工单 {ticket}',
  timeout: '评估超时',
  policyChanged: '策略已变更，按新版本重新评估',
  observed: 'observe 模式：本会接单（{text}）',
  directionUnsettled: '方向未定，不接单',
  noRuleMatched: '没有规则匹配',
  nothingToStop: '线程上没有可停止的工单',
  stopNotExplicit: '停止需要明确请求',
  routed: '已路由',
  resumeRefused: '授权复核失败，未恢复工单',
}

export function reasonText(reason: Reason): string {
  const template = TEXT[reason.code] ?? reason.code
  return template.replace(/\{(\w+)\}/g, (_, name: string) => reason.values?.[name] ?? '')
}
