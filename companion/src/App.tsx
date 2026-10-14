import { useEffect, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import { motionFps, nextSprites, nextWake, petMood, waitingCount, type OrchState, type Sprite } from './model.ts';
import { Pet } from './Pet.tsx';
import { Worker } from './Worker.tsx';
import { Panel } from './Panel.tsx';

type Bridge = {
  onState(cb: (s: OrchState | null) => void): void;
  interactive(on: boolean): void;
  dragStart(): void; drag(dx: number, dy: number): void; dragEnd(): void;
};
export const bridge = (window as unknown as { companion?: Bridge }).companion;

const PET = { right: 16, bottom: 10 };
const PER_ROW = 5;
// Worker slots fan out to the left of the pet, two rows at most before they wrap upward.
const slot = (i: number) => ({ right: 140 + (i % PER_ROW) * 50, bottom: 8 + Math.floor(i / PER_ROW) * 58 });
// Vector from a slot to the pet's baton, so arrivals start at the pet.
const fromPet = (i: number) => { const s = slot(i); return { x: s.right + 22 - (PET.right + 4), y: s.bottom + 25 - (PET.bottom + 70) }; };

export function useOrchState(feed: (cb: (s: OrchState | null) => void) => void) {
  const [state, setState] = useState<OrchState | null>(null);
  const [now, setNow] = useState(Date.now());
  const [sprites, setSprites] = useState<Sprite[] | null>(null);

  useEffect(() => feed(s => { setState(s); setNow(Date.now()); }), [feed]);
  useEffect(() => { setSprites(prev => nextSprites(prev, state, Date.now())); }, [state]);
  // Two one-shot timers stand in for a render loop: the next phase end and the moment the feed goes stale.
  useEffect(() => {
    const at = nextWake(sprites ?? [], state, Date.now());
    if (!isFinite(at)) return;
    const t = setTimeout(() => { setNow(Date.now()); setSprites(prev => prev && nextSprites(prev, state, Date.now())); }, Math.max(0, at - Date.now()));
    return () => clearTimeout(t);
  }, [sprites, state, now]);
  return { state, now, sprites: sprites ?? [] };
}

const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Frame counter for the looping poses; no timer at all when fps is 0.
function useFrame(fps: number) {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    if (!fps || reducedMotion()) return setFrame(0);
    const t = setInterval(() => setFrame(f => (f + 1) % 8), 1000 / fps);
    return () => clearInterval(t);
  }, [fps]);
  return frame;
}

// A blink every few seconds from one timeout, instead of an always-running animation.
function useBlink(on: boolean) {
  const [shut, setShut] = useState(false);
  useEffect(() => {
    if (!on || reducedMotion()) return;
    let t: ReturnType<typeof setTimeout>;
    const next = () => { t = setTimeout(() => { setShut(true); t = setTimeout(() => { setShut(false); next(); }, 140); }, 3500 + Math.random() * 4000); };
    next();
    return () => { clearTimeout(t); setShut(false); };
  }, [on]);
  return shut;
}

export function Companion({ state, now, sprites }: { state: OrchState | null; now: number; sprites: Sprite[] }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState<number | null>(null);
  const drag = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const mood = petMood(state, now);
  const handing = sprites.some(s => s.phase === 'arriving');
  const frame = useFrame(motionFps(mood, sprites));
  const blinking = useBlink(mood !== 'asleep' && mood !== 'blocked');

  useEffect(() => {
    if (!bridge) return;
    let on = false;
    const move = (e: MouseEvent) => {
      const hit = !!drag.current || !!(e.target as Element | null)?.closest?.('[data-hit]');
      if (hit !== on) bridge.interactive(on = hit);
    };
    window.addEventListener('mousemove', move);
    return () => window.removeEventListener('mousemove', move);
  }, []);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, []);

  const down = (e: RPointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    drag.current = { x: e.screenX, y: e.screenY, moved: false };
    bridge?.dragStart();
  };
  const moveDrag = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.screenX - d.x, dy = e.screenY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    if (d.moved) bridge?.drag(dx, dy);
  };
  const up = () => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.moved) bridge?.dragEnd(); else setOpen(o => !o);
  };

  const title = mood === 'asleep' ? (state ? 'orch feed is stale' : 'no orch state yet') : `orch is ${mood === 'waiting' ? 'waiting on you' : mood}`;
  return (
    <div className={`stage mood-${mood}${blinking ? ' blinking' : ''}`} data-f={frame}>
      {open && <Panel state={state} now={now} mood={mood} />}
      {sprites.map((s, i) => {
        const pos = slot(i), v = fromPet(i);
        return (
          <div key={s.worker.name} className="slot" data-hit style={{ right: pos.right, bottom: pos.bottom, '--fx': `${v.x}px`, '--fy': `${v.y}px` } as React.CSSProperties}
            onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(h => h === i ? null : h)}>
            {s.phase === 'arriving' && <span className="spark" />}
            <Worker sprite={s} />
            {hover === i && s.phase !== 'leaving' && (
              <div className="tip">
                <b>{s.worker.name}</b> <span className="muted">{s.worker.repo}{s.worker.kind !== 'claude' ? ` · ${s.worker.kind}` : ''} · {s.worker.status}</span>
                {s.worker.said && <div>{s.worker.said}</div>}
              </div>
            )}
          </div>
        );
      })}
      <div className="pet-hit" data-hit title={title} style={PET} onPointerDown={down} onPointerMove={moveDrag} onPointerUp={up}>
        <Pet mood={mood} count={waitingCount(state)} handing={handing} />
      </div>
    </div>
  );
}

export default function App() {
  const { state, now, sprites } = useOrchState(bridgeFeed);
  return <Companion state={state} now={now} sprites={sprites} />;
}

function bridgeFeed(cb: (s: OrchState | null) => void) { bridge?.onState(cb); }
