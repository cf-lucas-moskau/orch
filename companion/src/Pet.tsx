import type { PetMood } from './model.ts';

const INK = 'var(--ink)';

function Eyes({ mood }: { mood: PetMood }) {
  if (mood === 'asleep') return (
    <g className="eyes" stroke={INK} strokeWidth="2.4" strokeLinecap="round" fill="none">
      <path d="M41 66 q5 4 10 0" /><path d="M69 66 q5 4 10 0" />
    </g>
  );
  if (mood === 'blocked') return (
    <g className="eyes">
      <circle cx="46" cy="63" r="7" fill="#fff" stroke={INK} strokeWidth="2" />
      <circle cx="74" cy="63" r="7" fill="#fff" stroke={INK} strokeWidth="2" />
      <circle cx="46" cy="63" r="2.6" fill={INK} /><circle cx="74" cy="63" r="2.6" fill={INK} />
    </g>
  );
  const look = mood === 'thinking' ? 'translate(3 -3)' : '';
  const ry = mood === 'working' ? 4 : 5.5;
  return (
    <g className="eyes blinker" transform={look}>
      <ellipse cx="46" cy="64" rx="4" ry={ry} fill={INK} />
      <ellipse cx="74" cy="64" rx="4" ry={ry} fill={INK} />
      <circle cx="47.4" cy="62" r="1.3" fill="#fff" /><circle cx="75.4" cy="62" r="1.3" fill="#fff" />
    </g>
  );
}

function Mouth({ mood }: { mood: PetMood }) {
  if (mood === 'blocked') return <ellipse cx="60" cy="78" rx="3.5" ry="4.5" fill={INK} />;
  if (mood === 'waiting') return <path d="M53 75 q7 8 14 0 z" fill={INK} />;
  if (mood === 'asleep') return <path d="M57 78 h6" stroke={INK} strokeWidth="2" strokeLinecap="round" />;
  return <path d="M55 75 q5 4.5 10 0" stroke={INK} strokeWidth="2.2" strokeLinecap="round" fill="none" />;
}

export function Pet({ mood, count, handing }: { mood: PetMood; count: number; handing: boolean }) {
  return (
    <svg className={`pet mood-${mood}${handing ? ' handing' : ''}`} viewBox="0 0 120 120" width="120" height="120" aria-hidden>
      <ellipse className="shadow" cx="60" cy="110" rx="32" ry="5" />
      <g className="body">
        <ellipse cx="45" cy="104" rx="9" ry="5" fill="var(--body-shade)" stroke={INK} strokeWidth="2" />
        <ellipse cx="75" cy="104" rx="9" ry="5" fill="var(--body-shade)" stroke={INK} strokeWidth="2" />
        <g className="arm-left">
          {mood === 'waiting' ? <>
            <path d="M25 72 q-12 -4 -14 -22" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />
            <circle cx="11" cy="49" r="4.6" fill="var(--body)" stroke={INK} strokeWidth="2" />
          </> : <>
            <path d="M25 76 q-10 2 -12 -8" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />
            <circle cx="13" cy="67" r="4.2" fill="var(--body)" stroke={INK} strokeWidth="2" />
          </>}
        </g>
        <path d="M60 32 C86 32 100 52 100 72 C100 92 84 104 60 104 C36 104 20 92 20 72 C20 52 34 32 60 32 Z"
          fill="var(--body)" stroke={INK} strokeWidth="2.4" />
        <path d="M56 33 q-2 -8 4 -12 q2 6 -1 12" fill="var(--accent)" stroke={INK} strokeWidth="1.8" strokeLinejoin="round" />
        <ellipse cx="37" cy="74" rx="5" ry="3" fill="var(--cheek)" />
        <ellipse cx="83" cy="74" rx="5" ry="3" fill="var(--cheek)" />
        <Eyes mood={mood} />
        <Mouth mood={mood} />
        <path className="bowtie" d="M60 92 l-9 -5 v10 z M60 92 l9 -5 v10 z" fill="var(--accent)" stroke={INK} strokeWidth="1.6" strokeLinejoin="round" />
        <circle cx="60" cy="92" r="2.2" fill="var(--accent)" stroke={INK} strokeWidth="1.4" />
        <g className="arm-right">
          <path d="M95 78 q10 0 12 -8" stroke={INK} strokeWidth="2.4" fill="none" strokeLinecap="round" />
          <line className="baton" x1="107" y1="69" x2="116" y2="50" stroke={INK} strokeWidth="2" strokeLinecap="round" />
          <circle className="baton-tip" cx="116" cy="50" r="1.8" fill="var(--accent)" />
          <circle cx="107" cy="70" r="4.2" fill="var(--body)" stroke={INK} strokeWidth="2" />
        </g>
      </g>
      {mood === 'thinking' && (
        <g className="thought">
          <circle cx="88" cy="22" r="3" /><circle cx="98" cy="16" r="3.6" /><circle cx="109" cy="11" r="4.2" />
        </g>
      )}
      {mood === 'blocked' && (
        <g className="alarm">
          <circle cx="96" cy="20" r="11" fill="var(--danger)" stroke={INK} strokeWidth="2" />
          <path d="M96 13 v8" stroke="#fff" strokeWidth="3" strokeLinecap="round" /><circle cx="96" cy="26" r="1.8" fill="#fff" />
        </g>
      )}
      {mood === 'asleep' && (
        <g className="zzz" fill="var(--ink-soft)" fontFamily="ui-rounded, system-ui" fontWeight="700">
          <text x="84" y="34" fontSize="11">z</text><text x="93" y="24" fontSize="14">z</text><text x="103" y="12" fontSize="17">z</text>
        </g>
      )}
      {count > 0 && mood !== 'asleep' && (
        <g className="badge">
          <circle cx="30" cy="24" r="11" fill="var(--accent)" stroke={INK} strokeWidth="2" />
          <text x="30" y="28.5" textAnchor="middle" fontSize="13" fontWeight="800" fill="#fff" fontFamily="ui-rounded, system-ui">{count > 9 ? '9+' : count}</text>
        </g>
      )}
    </svg>
  );
}
