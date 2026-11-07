/** A small git repository with two planted problems, for the demo and the end-to-end tests. */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const FILES: Record<string, string> = {
  'README.md': '# demo-app\n\nA tiny app the agent works on.\n',
  'src/greet.js': "export function greet(name) {\n  return 'Helo, ' + name + '!'\n}\n",
  'src/login.js': "export function login(user) {\n  // Crashes when the user signed up with a phone number and has no email.\n  const email = user.email.toLowerCase()\n  return { ok: true, email }\n}\n",
  'test/greet.test.js': "import { greet } from '../src/greet.js'\nif (greet('Ada') !== 'Hello, Ada!') throw new Error('greet is wrong')\n",
  'package.json': '{ "name": "demo-app", "type": "module", "scripts": { "test": "node test/greet.test.js" } }\n',
}

export function createDemoRepo(directory: string): string {
  if (existsSync(join(directory, '.git'))) return directory
  mkdirSync(directory, { recursive: true })
  for (const [path, content] of Object.entries(FILES)) {
    mkdirSync(join(directory, path, '..'), { recursive: true })
    writeFileSync(join(directory, path), content)
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', directory, ...args], {
    stdio: 'ignore',
    env: { ...process.env, GIT_TEMPLATE_DIR: '', GIT_CONFIG_NOSYSTEM: '1' },
  })
  git('init', '-q', '-b', 'main')
  git('add', '-A')
  git('-c', 'user.name=demo', '-c', 'user.email=demo@localhost', 'commit', '-q', '-m', 'initial')
  return directory
}
