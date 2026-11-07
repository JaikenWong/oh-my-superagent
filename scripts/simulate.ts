/**
 * Sends a simulated native webhook to a running host, through the same parser as the platform's:
 *   npm run simulate -- github issue --number 12 --user alice --title "登录崩溃" --text "/agent summarize 手机号注册用户登录时报错"
 *   npm run simulate -- github comment --number 12 --user alice --text "/agent fix src/greet.js \"Helo\" -> \"Hello\""
 *   npm run simulate -- feishu comment --user ou_alice --text "@agent 总结一下 src/login.js 的问题"
 */
import { parseArgs } from 'node:util'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:7878' },
    number: { type: 'string' }, user: { type: 'string', default: 'alice' }, text: { type: 'string' }, title: { type: 'string' },
    chat: { type: 'string' }, root: { type: 'string' }, direct: { type: 'boolean' }, bot: { type: 'boolean' },
  },
})
const [source = 'github', event = 'comment'] = positionals
const body = { event, user: values.user, ...values.number ? { number: Number(values.number) } : {}, ...values.text ? { text: values.text } : {},
  ...values.title ? { title: values.title } : {}, ...values.chat ? { chat: values.chat } : {}, ...values.root ? { root: values.root } : {},
  ...values.direct ? { direct: true } : {}, ...values.bot ? { bot: true } : {} }
const response = await fetch(`${values.url}/api/simulate/${source}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
console.log(response.status, await response.text())
