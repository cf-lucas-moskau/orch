import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { Files, Tab, View } from '../types'
import {
  STAGES, actions, ago, buildDeck, clip, edge, flowFromCall, hhmm, parseDecision, parseFeed, stageBar, statusLine,
  type Deck, type FeedEvent, type Flow, type Node,
} from './core'

const PANE = 'orch-deck'
const FEED_KEEP = 800
const DEFAULT_FILES: Files = { sessions: {}, workers: [], decisions: [], log: [] }
const DEFAULT_VIEW: View = { tab: 'map', sel: 0, steering: false, readout: null, note: '' }

const feed = atom({ plugin: 'orch-deck', key: 'feed' } as const, [] as FeedEvent[])
const files = atom({ plugin: 'orch-deck', key: 'files' } as const, DEFAULT_FILES)
const view = atom({ plugin: 'orch-deck', key: 'view' } as const, DEFAULT_VIEW)
const live = atom({ plugin: 'orch-deck', key: 'live' } as const, [] as Flow[])
const tick = atom({ plugin: 'orch-deck', key: 'tick' } as const, 0)

// The plugin sits in <orch>/mod; the ledger is its parent.
const orchRoot = ($: EngineInterface) => $.plugin.root.replace(/\/\.claude-plugin\/?$/, '').replace(/\/mod\/?$/, '')
const today = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
const nowIso = (ms: number) => new Date(ms).toISOString()

async function deckOf($: EngineInterface): Promise<Deck> {
  const [f, fl, lv, now] = await Promise.all([read($, files), read($, feed), read($, live), $.clock.now()])
  return buildDeck({ feed: fl, sessions: f.sessions, workers: f.workers, decisions: f.decisions, log: f.log, now, selfCwd: orchRoot($), liveFlows: lv })
}

// ---------------------------------------------------------------- feeding

let stream: { return?: () => unknown } | null = null
let streamDay = ''

// tail -F today's feed for the session's life; at midnight the poll ends it and starts tomorrow's.
function startFeed($: EngineInterface, day: string) {
  streamDay = day
  const file = `${orchRoot($)}/feed/${day}.jsonl`
  void (async () => {
    let buf = ''
    let first = true
    try {
      const s = $.process.spawn({ argv: ['tail', '-n', String(FEED_KEEP), '-F', file] })
      stream = s as unknown as { return?: () => unknown }
      for await (const chunk of s) {
        if (!('text' in chunk) || chunk.stream !== 'stdout') continue
        buf += chunk.text
        const cut = buf.lastIndexOf('\n')
        if (cut < 0) continue
        const evs = parseFeed(buf.slice(0, cut))
        buf = buf.slice(cut + 1)
        const replace = first
        first = false
        await update($, feed, list => (replace ? evs : [...list, ...evs]).slice(-FEED_KEEP))
      }
    } catch (err) {
      $.ui.log(`feed stream ended: ${String(err)}`, { to: 'debug' })
    }
  })()
}

let lastFiles = ''
async function pollFiles($: EngineInterface) {
  const root = orchRoot($)
  const json = async <T>(p: string, d: T): Promise<T> => {
    try { return JSON.parse(await $.fs.read(`${root}/${p}`)) as T } catch { return d }
  }
  const [sessions, workers] = await Promise.all([json('sessions.json', {}), json('workers.json', [])])
  let log: string[] = []
  try { log = (await $.fs.read(`${root}/log.md`)).split('\n').filter(l => l.startsWith('- ')).slice(-200) } catch { /* none yet */ }
  const decisions = []
  try {
    for (const e of await $.fs.list(`${root}/decisions`)) {
      const id = e.name.match(/^(D-\d+)\.md$/)?.[1]
      if (id) decisions.push(parseDecision(id, await $.fs.read(`${root}/decisions/${e.name}`)))
    }
  } catch { /* none yet */ }
  const next: Files = { sessions, workers, decisions, log }
  const key = JSON.stringify(next)
  if (key !== lastFiles) {
    lastFiles = key
    await update($, files, () => next)
  }
  $.ui.status(statusLine(await deckOf($)))
  const day = today(await $.clock.now())
  if (day !== streamDay) {
    stream?.return?.()
    startFeed($, day)
  }
}

// ---------------------------------------------------------------- acting

const selectable = (d: Deck) => d.nodes
async function selected($: EngineInterface): Promise<Node | null> {
  const [d, v] = await Promise.all([deckOf($), read($, view)])
  const list = selectable(d)
  return list.length ? list[Math.min(v.sel, list.length - 1)]! : null
}
const setView = ($: EngineInterface, patch: Partial<View>) => update($, view, v => ({ ...DEFAULT_VIEW, ...v, ...patch }))
const hand = async ($: EngineInterface, text: string, note: string) => {
  await $.prompt.submit({ text, asUser: true })
  await setView($, { note })
}

async function readPane($: EngineInterface) {
  const n = await selected($)
  if (!n?.pane) return setView($, { note: 'no pane known for that session' })
  try {
    const r = await $.process.run(['herdr', 'agent', 'read', n.pane, '--lines', '30'], { timeoutMs: 10_000 })
    await setView($, { readout: { name: n.name, text: (r.stdout || r.stderr).trimEnd() }, note: '' })
  } catch (err) {
    await setView($, { note: `herdr read failed: ${String(err)}` })
  }
}

// ---------------------------------------------------------------- hooks

export const register: Register = (on) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'deck', description: 'orch deck: open or close the live orch pane', argumentHint: '[open|close]' })
    const day = today(await $.clock.now())
    startFeed($, day)
    await pollFiles($).catch(() => undefined)
    $.clock.every(4000, () => void pollFiles($).catch(() => undefined))
    // sessions.json is the board's; refresh it so new sessions get names.
    $.clock.every(60_000, () => void $.process.run(['npm', 'run', '-s', 'board'], { cwd: orchRoot($), timeoutMs: 30_000 }).catch(() => undefined))
    // Move the dots only while some edge is live.
    $.clock.every(350, () => void (async () => {
      const [fl, now] = await Promise.all([read($, feed), $.clock.now()])
      const last = fl.at(-1)
      if (last && now - Date.parse(last.ts) < 21_000) await update($, tick, t => t + 1)
    })().catch(() => undefined))
    void $.ui.open({ id: PANE, title: 'orch deck', columns: 72, rows: 10 }).catch(() => undefined)
    return started
  })

  on('command.run', { command: 'deck' }, async ($, e) => {
    if (e.args.trim() === 'close') {
      await $.ui.close({ id: PANE })
      return { text: 'orch deck closed.' }
    }
    const opened = await $.ui.open({ id: PANE, title: 'orch deck', columns: 72, rows: 10, focus: true })
    return { text: opened.isPlaced ? 'orch deck open. ctrl+x tab focuses it; m b w d f switch tabs, j/k select.' : `orch deck not shown: ${opened.reason}` }
  })

  // What orch itself is doing: its skills and orch commands, as they happen.
  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    try {
      if (!e.agentId) {
        const f = flowFromCall(String(e.tool), e as unknown as Record<string, unknown>)
        if (f) {
          const ts = nowIso(await $.clock.now()).slice(0, 16).replace('T', ' ')
          await update($, live, l => [...l, { ts, ...f }].slice(-20))
        }
      }
    } catch { /* never let the deck get in orch's way */ }
    return r
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const els = $.ui.resolve(e)
    const { Box, Text, Button } = els
    const Input = 'Input' in els ? els.Input : null
    const [d, v, t, now] = await Promise.all([deckOf($), read($, view), read($, tick), $.clock.now()])
    const W = Math.max(48, e.props.bodyColumns)
    const T = (children: string, props: Record<string, unknown> = {}) => Text({ ...props, children })
    const row = (...children: RenderChildren[]) => Box({ flexDirection: 'row', flexWrap: 'wrap', columnGap: 1, children })
    const col = (children: RenderChildren[], props: Record<string, unknown> = {}) => Box({ flexDirection: 'column', ...props, children })
    // A steer box left open would swallow the tab keys next time the pane is focused.
    if (v.steering && !e.props.isFocused) $.clock.after(0, () => void setView($, { steering: false }))
    const list = selectable(d)
    const sel = list.length ? Math.min(v.sel, list.length - 1) : 0
    const cur = list[sel] ?? null
    const statusColor = (s: Node['status']) => (s === 'blocked' || s === 'question' ? 'warning' : s === 'working' ? 'suggestion' : s === 'done' ? 'success' : 'inactive')
    const kindColor = (n: Node) => (n.kind === 'codex' ? 'permission' : 'claude')

    const tabs: [Tab, string, string][] = [['map', 'm', 'Map'], ['bus', 'b', 'Bus'], ['workers', 'w', 'Workers'], ['decisions', 'd', `Decisions${d.decisions.length ? ` ${d.decisions.length}` : ''}`], ['flows', 'f', 'Flows']]
    const header = row(
      T('orch deck', { bold: true, color: 'claude' }),
      ...tabs.map(([id, key, label]) => Button({ key: `tab-${id}`, plain: true, hotkey: key, label: v.tab === id ? `[${label}]` : label, dimColor: v.tab !== id, onPress: () => void setView($, { tab: id, readout: null }) })),
    )

    const nameW = Math.min(18, Math.max(8, ...list.map(n => n.name.length)))
    const nodeRow = (n: Node, i: number, last: boolean) => {
      const ed = edge(5, n, now, t)
      const bar = n.worker ? stageBar(n.worker.stage) : null
      return row(
        T(`${i === sel ? '›' : ' '} ${last ? '└' : '├'}`, { color: i === sel ? 'claude' : 'inactive' }),
        T(ed.text, { color: ed.isLive ? 'claude' : 'inactive' }),
        T(clip(n.name, nameW).padEnd(nameW), { color: kindColor(n), bold: i === sel }),
        ...(bar ? [Box({ flexDirection: 'row', children: [T(bar.done, { color: 'success' }), T(bar.now, { color: 'claude' }), T(bar.todo, { color: 'inactive' })] }), T(n.worker!.stage.padEnd(6))] : [T(n.kind.padEnd(13), { dimColor: true })]),
        T(n.status.padEnd(8), { color: statusColor(n.status) }),
        T(ago(n.lastTs, now), { dimColor: true }),
      )
    }

    const busRows = (n: number) => d.bus.slice(-n).map(b => row(
      T(hhmm(b.ts), { dimColor: true }),
      T(b.kind.padEnd(6), { color: b.kind === 'needs' ? 'warning' : b.kind === 'relay' ? 'success' : b.kind === 'prompt' ? 'suggestion' : 'inactive' }),
      T(clip(`${b.kind === 'prompt' ? '→ ' : ''}${b.name}${b.kind === 'prompt' ? '' : ' →'}  ${b.text}`, W - 16), { wrap: 'truncate-end' }),
    ))

    const decisionRows = (full: boolean) => d.decisions.map(x => col([
      row(T(x.id, { color: 'warning', bold: true }), T(x.question, { wrap: full ? 'wrap' : 'truncate-end' })),
      ...(full ? [T(`  ${x.session}`, { dimColor: true }), T(`  orch recommends: ${x.recommendation}`, { wrap: 'wrap' })] : []),
    ]))

    const body: RenderChildren[] = []
    if (v.tab === 'map') {
      const flowNow = d.flows.at(-1)
      body.push(Box({ flexDirection: 'row', children: [T('you ', { dimColor: true }), T('──▶ ', { color: 'inactive' }), T('orch ', { bold: true, color: 'claude' }), T(flowNow ? clip(`[${flowNow.flow}] ${flowNow.detail}`, W - 18) : '', { dimColor: true, wrap: 'truncate-end' })] }))
      list.forEach((n, i) => body.push(nodeRow(n, i, i === list.length - 1 && !d.idle)))
      if (d.idle) body.push(T(`  └──────▶ ${d.idle} idle session${d.idle === 1 ? '' : 's'}`, { color: 'inactive' }))
      if (d.decisions.length) body.push(T(' '), ...decisionRows(false))
      body.push(T(' '), T('bus', { dimColor: true }), ...busRows(6))
    } else if (v.tab === 'bus') {
      body.push(...busRows(40))
    } else if (v.tab === 'workers') {
      const ws = list.filter(n => n.worker)
      if (!ws.length) body.push(T('No workers running.', { dimColor: true }))
      for (const n of ws) {
        const w = n.worker!
        const bar = stageBar(w.stage)
        body.push(col([
          row(T(n === cur ? '›' : ' ', { color: 'claude' }), T(n.name, { bold: true, color: kindColor(n) }), T(`${n.kind}${w.pair ? ` · pair ${w.pair}` : ''} · ${w.repo} · ${w.branch}`, { dimColor: true })),
          row(T(' '), Box({ flexDirection: 'row', children: [T(bar.done, { color: 'success' }), T(bar.now, { color: 'claude' }), T(bar.todo, { color: 'inactive' })] }), T(STAGES.map(s => (s === w.stage ? s.toUpperCase() : s)).join(' · '), { dimColor: true })),
          T(`  ${w.task}`, { wrap: 'wrap' }),
          ...(n.said ? [T(`  last said: ${n.said}`, { dimColor: true, wrap: 'wrap' })] : []),
        ], { marginBottom: 1 }))
      }
    } else if (v.tab === 'decisions') {
      body.push(...(d.decisions.length ? decisionRows(true) : [T('No open decisions.', { dimColor: true })]))
    } else {
      body.push(T('routing: Claude by default · Codex for "with Codex" or (codex) · pair for (both) or risky work', { dimColor: true, wrap: 'wrap' }), T(' '))
      for (const f of [...d.flows].reverse().slice(0, 25)) body.push(row(T(f.ts.slice(11) || f.ts, { dimColor: true }), T(f.flow.padEnd(9), { color: 'suggestion' }), T(clip(f.detail, W - 18), { wrap: 'truncate-end' })))
    }

    if (v.readout) body.push(T(' '), T(`${v.readout.name}, last 30 lines`, { bold: true }), T(v.readout.text, { wrap: 'wrap', dimColor: true }))

    const dec = d.decisions[0]
    const btn = (key: string, hotkey: string, label: string, onPress: () => void) => Button({ key, plain: true, hotkey, label, onPress })
    const footer: RenderChildren[] = []
    if (v.steering && cur && Input) {
      footer.push(Input({
        key: 'steer', label: `steer ${cur.name}`, placeholder: 'what orch should tell it', autoFocus: true, submitLabel: 'send',
        onSubmit: (value: string) => void (async () => {
          if (value.trim()) await hand($, actions.steer(cur.name, value.trim()), `asked orch to steer ${cur.name}`)
          await setView($, { steering: false })
        })(),
      }))
      footer.push(btn('cancel', 'x', 'cancel', () => void setView($, { steering: false })))
    } else {
      footer.push(row(
        btn('prev', 'k', 'up', () => void setView($, { sel: Math.max(0, sel - 1), readout: null })),
        btn('next', 'j', 'down', () => void setView($, { sel: Math.min(list.length - 1, sel + 1), readout: null })),
        ...(cur ? [
          btn('steer', 's', 'steer', () => void setView($, { steering: true })),
          btn('read', 'r', 'read', () => void readPane($)),
          ...(cur.worker ? [
            btn('gates', 'g', 'gates', () => void hand($, actions.gates(cur.name), `asked orch for gates on ${cur.name}`)),
            btn('clean', 'c', 'clean up', () => void hand($, actions.cleanup(cur.name), `asked orch to clean up ${cur.name}`)),
          ] : []),
        ] : []),
      ))
      if (dec) footer.push(row(
        T(dec.id, { color: 'warning' }),
        btn('yes', 'y', 'yes', () => void hand($, actions.accept(dec), `answered ${dec.id}: yes`)),
        btn('no', 'n', 'no…', () => void $.prompt.fill({ text: actions.reject(dec), mode: 'replace' }).then(() => setView($, { note: `type why for ${dec.id} in the prompt` }))),
        ...(v.readout ? [btn('close', 'x', 'close readout', () => void setView($, { readout: null }))] : []),
      ))
    }
    if (v.note) footer.push(T(v.note, { dimColor: true, italic: true }))

    return col([header, T(' '), ...body, T(' '), ...footer], { paddingX: 1 })
  })
}
