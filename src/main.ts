/** Entry point: `node src/main.ts --config <file>`. */
import { parseArgs } from 'node:util'
import { loadDeployment } from './config.ts'
import { createHttp, createWebhookHttp } from './app/http.ts'
import { Runtime } from './app/runtime.ts'

const { values } = parseArgs({ options: { config: { type: 'string', default: 'superagent.config.json' } } })
const deployment = loadDeployment(values.config!)
const runtime = new Runtime(deployment)
runtime.start()
const { host, port, webhookPort } = deployment.http
const panel = createHttp(runtime)
panel.listen(port, host, () => {
  const settings = runtime.settings
  console.log(`oh-my-superagent panel on http://${host}:${port}`)
  console.log(`  repository ${deployment.repository.path} (${deployment.repository.baseBranch}); agent ${settings.executor.agent}; mode ${settings.policy.mode}; outbound ${settings.outbound}`)
})
const hooks = webhookPort ? createWebhookHttp(runtime) : undefined
hooks?.listen(webhookPort, host, () => {
  console.log(`  webhooks only on http://${host}:${webhookPort}: ${runtime.registry.all().map(source => `/webhooks/${source.id}`).join(', ')} — expose this port, not the panel's`)
})
if (!hooks) console.log(`  webhooks: ${runtime.registry.all().map(source => `/webhooks/${source.id}`).join(', ') || '(no Source configured)'} on the panel's port`)

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (stopping) process.exit(1)
    stopping = true
    console.log('stopping…')
    panel.close()
    hooks?.close()
    void runtime.stop().then(() => process.exit(0))
  })
}
