/** `npm run demo`: creates examples/demo-repo once. */
import { fileURLToPath } from 'node:url'
import { createDemoRepo } from './demo-repo.ts'

const directory = createDemoRepo(fileURLToPath(new URL('../examples/demo-repo', import.meta.url)))
console.log(`demo repository: ${directory}`)
