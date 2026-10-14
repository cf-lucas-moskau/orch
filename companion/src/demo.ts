import type { OrchState, WorkerView } from './model.ts';

// Fixture states for the demo page and the screenshot run.
const w = (name: string, repo: string, status: WorkerView['status'], said: string, kind = 'claude'): WorkerView =>
  ({ name, repo, kind, status, said, started: '2026-10-14 09:30' });
const base = (now: number): OrchState => ({
  v: 1, ts: new Date(now).toISOString(), orch: { state: 'idle', said: 'All quiet. Three workers on tariffs.' },
  workers: [], decisions: [], sessions: { idle: 9, done: 1 },
  actions: [
    '14:40 cleanup zolt140: pane closed, worktree removed, branch kept',
    '15:28 gates zolt144: all passed',
    '15:33 review tariffs 0d14aa37: 1 agreed, 1 Claude only, 1 Codex only',
    '15:58 ZOLT-144 pushed and PR opened',
    '17:43 ask-prep demo committed locally',
  ],
});
const crew = [
  w('zolt144', 'tariffs', 'working', 'Running the traceability search tests now.'),
  w('ask-prep', 'ask-prep', 'working', 'Building the demo deck, slide 6 of 9.'),
  w('lint-fix', 'orch', 'idle', 'Gates green, nothing left to do.', 'codex'),
];

export type Scene = { id: string; label: string; state: (now: number) => OrchState | null };

export const scenes: Scene[] = [
  { id: 'idle', label: 'Idle', state: now => ({ ...base(now), workers: [crew[2]] }) },
  { id: 'thinking', label: 'Thinking', state: now => ({ ...base(now), orch: { state: 'thinking', said: '' }, workers: [crew[2]] }) },
  { id: 'working', label: 'Working', state: now => ({ ...base(now), orch: { state: 'working', said: '' }, workers: crew }) },
  {
    id: 'waiting', label: 'Waiting on you', state: now => ({
      ...base(now), orch: { state: 'waiting', said: 'Merge #130 now that CI is green?' },
      workers: [crew[0], w('ask-prep', 'ask-prep', 'asking', 'Should I keep the German slide titles?')],
      decisions: [{ id: 'D-12', question: 'Merge the traceability stack (#130 to #134)?' }],
    }),
  },
  {
    id: 'blocked', label: 'Blocked', state: now => ({
      ...base(now), orch: { state: 'blocked', said: '' },
      workers: [crew[0], w('db-mig', 'tariffs', 'blocked', 'Claude needs your permission to use Bash')],
    }),
  },
  { id: 'asleep', label: 'Feed stale', state: now => ({ ...base(now - 5 * 60_000), workers: crew }) },
  { id: 'handover', label: 'Hand over', state: now => ({ ...base(now), orch: { state: 'working', said: '' }, workers: [...crew, w('docs', 'orch', 'working', 'Starting on the README.')] }) },
  { id: 'cheer', label: 'Worker done', state: now => ({ ...base(now), orch: { state: 'working', said: '' }, workers: [{ ...crew[0], status: 'done', said: 'Gates green, one commit ready.' }, crew[1], crew[2]] }) },
  { id: 'walkoff', label: 'Cleaned up', state: now => ({ ...base(now), orch: { state: 'working', said: '' }, workers: [crew[1], crew[2]] }) },
];
