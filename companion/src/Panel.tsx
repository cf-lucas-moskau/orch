import type { OrchState, PetMood } from './model.ts';

const MOOD: Record<PetMood, string> = {
  idle: 'idle', thinking: 'thinking', working: 'working', waiting: 'waiting on you', blocked: 'blocked', asleep: 'feed stale',
};
const ago = (ms: number) => ms < 60_000 ? `${Math.max(0, Math.round(ms / 1000))}s ago` : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m ago` : `${Math.round(ms / 3_600_000)}h ago`;

export function Panel({ state, now, mood }: { state: OrchState | null; now: number; mood: PetMood }) {
  if (!state) return (
    <div className="panel" data-hit>
      <h2>orch <span className="pill mood-asleep">no state</span></h2>
      <p className="muted">Waiting for ~/agent-bus/orch-state.json. Is <code>npm run state</code> running on spare-mbp?</p>
    </div>
  );
  const others = Object.entries(state.sessions).map(([k, n]) => `${n} ${k}`).join(', ');
  return (
    <div className="panel" data-hit>
      <h2>orch <span className={`pill mood-${mood}`}>{MOOD[mood]}</span><span className="muted right">{ago(now - Date.parse(state.ts))}</span></h2>
      {state.orch.said && <p className="said">{state.orch.said}</p>}
      {state.decisions.length > 0 && (
        <section>
          <h3>Needs you</h3>
          {state.decisions.map(d => <div key={d.id} className="row"><b>{d.id}</b> {d.question}</div>)}
        </section>
      )}
      <section>
        <h3>Workers</h3>
        {state.workers.length === 0 && <div className="muted">none running</div>}
        {state.workers.map(w => (
          <div key={w.name} className="row">
            <span className={`dot st-${w.status}`} /><b>{w.name}</b> <span className="muted">{w.repo} · {w.status}</span>
            {w.said && <div className="said small">{w.said}</div>}
          </div>
        ))}
      </section>
      <section>
        <h3>Last actions</h3>
        {state.actions.slice().reverse().map((a, i) => <div key={i} className="row small">{a}</div>)}
      </section>
      {others && <div className="muted small foot">Other sessions: {others}</div>}
    </div>
  );
}
