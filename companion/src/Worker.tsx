import type { Sprite } from './model.ts';

const INK = 'var(--ink)';

// One small helper per worker. Pose comes from status, the one-shot phases (arrive, cheer, leave) from CSS.
export function Worker({ sprite }: { sprite: Sprite }) {
  const { status, kind } = sprite.worker;
  const raised = status === 'asking' || status === 'blocked';
  const cheer = sprite.phase === 'cheering';
  const typing = status === 'working' && !cheer;
  return (
    <svg className={`bot st-${status} ph-${sprite.phase} kind-${kind}`} viewBox="0 0 44 50" width="44" height="50" aria-hidden>
      <ellipse className="shadow" cx="22" cy="47" rx="13" ry="2.6" />
      <g className="bot-body">
        <line x1="22" y1="9" x2="22" y2="3.5" stroke={INK} strokeWidth="1.6" />
        <circle className="bulb" cx="22" cy="3.5" r="2.6" stroke={INK} strokeWidth="1.2" />
        <rect x="9" y="9" width="26" height="22" rx="8" fill="var(--bot)" stroke={INK} strokeWidth="1.8" />
        <rect x="13" y="13.5" width="18" height="12" rx="4.5" fill="var(--screen)" />
        <g className="bot-eyes blinker" fill="var(--screen-ink)">
          {status === 'done' && !cheer
            ? <path d="M16.5 19.5 l3.5 3 l7 -6.5" stroke="var(--ok)" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            : <><circle cx="18" cy="19.5" r="1.9" /><circle cx="26" cy="19.5" r="1.9" /></>}
        </g>
        <rect x="13" y="31" width="18" height="10" rx="4" fill="var(--bot)" stroke={INK} strokeWidth="1.8" />
        <rect x="14" y="40" width="5" height="5" rx="2" fill={INK} /><rect x="25" y="40" width="5" height="5" rx="2" fill={INK} />
        {cheer || raised ? (
          <>
            <path className="hand-up" d="M31 33 l6 -12" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
            {cheer
              ? <path className="hand-up" d="M13 33 l-6 -12" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
              : <path d="M13 34 l-4 5" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />}
          </>
        ) : (
          <>
            <path className={typing ? 'tap-l' : ''} d="M13 34 l-3 6" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
            <path className={typing ? 'tap-r' : ''} d="M31 34 l3 6" stroke={INK} strokeWidth="2.2" strokeLinecap="round" />
          </>
        )}
      </g>
      {(typing || status === 'idle') && (
        <g className="laptop">
          {typing
            ? <path d="M4 44 h36 l-4 -7 h-28 z" fill="var(--laptop)" stroke={INK} strokeWidth="1.4" strokeLinejoin="round" />
            : <rect x="5" y="42.5" width="34" height="2.6" rx="1.2" fill="var(--laptop)" stroke={INK} strokeWidth="1.2" />}
        </g>
      )}
      {raised && (
        <g className="ask">
          <circle cx="37" cy="12" r="6.5" fill={status === 'blocked' ? 'var(--danger)' : 'var(--ask)'} stroke={INK} strokeWidth="1.4" />
          <text x="37" y="15.6" textAnchor="middle" fontSize="10" fontWeight="800" fill="#fff" fontFamily="ui-rounded, system-ui">{status === 'blocked' ? '!' : '?'}</text>
        </g>
      )}
      {cheer && (
        <g className="confetti">
          <rect x="4" y="6" width="3" height="3" fill="var(--accent)" /><rect x="38" y="4" width="3" height="3" fill="var(--ok)" />
          <rect x="9" y="1" width="2.5" height="2.5" fill="var(--ask)" /><rect x="32" y="9" width="2.5" height="2.5" fill="var(--accent)" />
        </g>
      )}
    </svg>
  );
}
