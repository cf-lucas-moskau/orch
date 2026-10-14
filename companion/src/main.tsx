import { useCallback, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App, { bridge, Companion, useOrchState } from './App.tsx';
import { scenes } from './demo.ts';
import type { OrchState } from './model.ts';
import './styles.css';

// Outside Electron the page is a demo: the same companion, fed from fixture scenes.
function Demo() {
  const [scene, setScene] = useState('working');
  const [push, setPush] = useState<((s: OrchState | null) => void) | null>(null);
  const feed = useCallback((cb: (s: OrchState | null) => void) => {
    setPush(() => cb);
    cb(scenes.find(s => s.id === 'working')!.state(Date.now()));
  }, []);
  const { state, now, sprites } = useOrchState(feed);
  const pick = (id: string) => { setScene(id); push?.(scenes.find(s => s.id === id)!.state(Date.now())); };
  return (
    <div className="demo">
      <div className="demo-bar">
        {scenes.map(s => <button key={s.id} aria-pressed={scene === s.id} onClick={() => pick(s.id)}>{s.label}</button>)}
      </div>
      <p className="demo-hint">Hover a worker, click the pet. "Hand over", "Worker done" and "Cleaned up" animate from the Working scene.</p>
      <div className="desk"><Companion state={state} now={now} sprites={sprites} /></div>
    </div>
  );
}

if (!bridge) document.documentElement.classList.add('is-demo');
createRoot(document.getElementById('root')!).render(bridge ? <App /> : <Demo />);
