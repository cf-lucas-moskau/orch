import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

type Submitted = { text: string; asUser?: true }[]
const worker = { name: 'admin-fix', kind: 'claude', repo: 'tariffs', task: 'fix the dashboard', branch: 'orch/admin-fix', pane: 'wY:p1', sid: 'w1', started: '2026-10-09 10:12', status: 'running' }
const FILES: Record<string, string> = {
  'workers.json': JSON.stringify([worker]),
  'sessions.json': '{}',
  'log.md': '- 2026-10-09 10:12 run admin-fix (claude) on tariffs\n',
  'D-07.md': '# D-07: Push orch/admin-fix?\n\n- Session: admin-fix\n- Status: open\n\n## Recommendation\nYes, gates green.\n',
}
const FEED = `${JSON.stringify({ ts: '2026-10-09T10:13:00Z', sid: 'w1', event: 'UserPromptSubmit', cwd: '/w', prompt: 'You are worker admin-fix', msg: '' })}\n`

// The world under the deck: orch's files, a feed tail that prints once, prompts recorded.
const engine = (on: On, submitted: Submitted) => {
  mock.clock(on, { now: Date.parse('2026-10-09T10:20:00Z') })
  on('session.start', () => ({ cwd: '/home/me/orch' }) as never)
  on('ui.log', () => ({ value: undefined }) as never)
  on('ui.status', () => ({ value: undefined }) as never)
  on('ui.open', () => ({ value: { isPlaced: true } }) as never)
  on('command.register', () => ({ value: undefined }) as never)
  on('fs.read', (_$, e) => { const f = FILES[String((e as { path: string }).path).split('/').pop()!]; return (f === undefined ? { deny: 'ENOENT' } : { value: f }) as never })
  on('fs.list', () => ({ value: [{ name: 'D-07.md', kind: 'file', size: 1, mtimeMs: 0, isLink: false }] }) as never)
  on('process.run', () => ({ value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }) as never)
  on('process.spawn', async function* () { yield { stream: 'stdout', text: FEED }; return { value: { code: 0, signal: null } } } as never)
  on('prompt.submit', (_$, e) => { submitted.push({ text: e.text, asUser: (e as { origin?: { asUser?: true } }).origin?.asUser }); return { text: e.text } as never })
}
const pane = (bodyColumns: number) => ({
  plugin: 'orch-deck', component: 'Pane' as const, requestId: 'orch-deck',
  props: { title: 'orch deck', isFocused: true, bodyColumns, placement: 'dock' as const, scroll: { offset: 0, bodyRows: 60 }, view: {} },
})
const start = async ($: { session: { start: (e: never) => Promise<unknown> } }) => {
  await $.session.start({ cwd: '/home/me/orch', source: 'startup' } as never)
  for (let i = 0; i < 50; i++) await Promise.resolve() // let the feed loop take its one chunk
}

test('the map shows the worker, its stage and the open decision', async ($, on) => {
  engine(on, [])
  await start($ as never)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  expect(await ui.find({ text: /admin-fix/ })).toBeDefined()
  expect(await ui.find({ text: /^work\s*$/ })).toBeDefined()
  expect(await ui.find({ text: /Push orch\/admin-fix\?/ })).toBeDefined()
  await ui.unmount()
})

test('y answers the decision as the user, g asks orch for gates on the selected worker', async ($, on) => {
  const submitted: Submitted = []
  engine(on, submitted)
  await start($ as never)
  const ui = await $.ui.mount({ ...pane(80), surface: 'terminal' })
  await ui.press({ key: 'yes' })
  await ui.press({ key: 'gates' })
  expect(submitted.map(s => s.text)).toEqual(['D-07: yes, go with your recommendation.', 'Run the gates for worker admin-fix and tell me the result.'])
  expect(submitted.every(s => s.asUser)).toBe(true)
  await ui.unmount()
})
