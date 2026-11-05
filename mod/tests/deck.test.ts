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
// What the health tab reads: a Mac with 12 GB free, normal pressure, docker not running, no temperature tool.
const MACHINE: Record<string, string> = {
  df: 'Filesystem 1024-blocks Used Available Capacity iused ifree %iused Mounted on\n/dev/disk3s5 482797652 470000000 11718750 98% 1 1 5% /System/Volumes/Data\n',
  vm_stat: 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages wired down:                        265505.\nAnonymous pages:                         962697.\n',
  sysctl: 'hw.memsize: 34359738368\nvm.loadavg: { 2.00 3.00 4.00 }\nkern.boottime: { sec = 1793880000, usec = 0 }\nhw.ncpu: 12\nkern.memorystatus_vm_pressure_level: 1\n',
  'pmset batt': "Now drawing from 'AC Power'\n",
  'pmset therm': 'Note: No thermal warning level has been recorded\n',
  du: '7486584\t/home/me/.herdr/worktrees\n',
}

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
  on('env.get', () => ({ value: '/home/me' }) as never)
  on('process.run', (_$, e) => {
    const argv = (e as { argv: string[] }).argv
    const stdout = MACHINE[argv[0] === 'pmset' ? `pmset ${argv[2]}` : argv[0]!]
    return { value: { exitCode: stdout === undefined ? 1 : 0, stdout: stdout ?? '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } } as never
  })
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

test('h shows machine health with low disk in red and flags it on the map', async ($, on) => {
  engine(on, [])
  await start($ as never)
  for (let i = 0; i < 50; i++) await Promise.resolve()
  const ui = await $.ui.mount({ ...pane(90), surface: 'terminal' })
  expect(await ui.find({ text: /⚠ disk 12\.0 GB free/ })).toBeDefined()
  await ui.press({ key: 'tab-health' })
  expect((await ui.find({ type: 'Text', text: '12.0 GB free of 494 GB · /System/Volumes/Data' }))?.props.color).toBe('error')
  expect((await ui.find({ type: 'Text', text: '20.1 GB used of 34.4 GB · pressure normal' }))?.props.color).toBeUndefined()
  expect(await ui.find({ text: 'not readable without sudo' })).toBeDefined()
  expect(await ui.find({ text: 'docker not running' })).toBeDefined()
  expect(await ui.find({ text: '7.7 GB in ~/.herdr/worktrees' })).toBeDefined()
  await ui.unmount()
})
