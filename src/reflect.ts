// Pure: pull the lines worth learning from out of Claude transcripts, each with a citation.

export type Signal = { cite: string; said: string; before: string };

const SIGNAL = /\b(no+|nope|don'?t|do not|stop|never|always|instead|wrong|actually|why did you|i said|i told you|remember|again|not what|please don'?t|revert|undo|nein|nicht|falsch|warum|immer|nie)\b|!{2,}/i;

const text = (content: unknown): string =>
  typeof content === 'string' ? content
    : Array.isArray(content) ? content.filter(c => c?.type === 'text').map(c => c.text).join('\n') : '';

// A human turn: typed by the user, not a tool result, hook output, command echo, notification or claude -p.
function humanText(o: any): string {
  if (o.type !== 'user' || o.isSidechain || o.isMeta || (o.entrypoint && o.entrypoint !== 'cli')) return '';
  if (o.origin && o.origin.kind !== 'human') return '';
  const t = text(o.message?.content).trim();
  return !t || t.startsWith('<') || t.startsWith('[Request interrupted') ? '' : t;
}

// orchSent: text orch itself typed into sessions (worker prompts, steers); those are not the user.
export function extractSignals(jsonl: string, file: string, orchSent: string[] = []): Signal[] {
  const byOrch = (t: string) => t.startsWith('You are worker ') || orchSent.some(o => o && t.startsWith(o));
  const out: Signal[] = [];
  let before = '';
  jsonl.split('\n').forEach((line, i) => {
    let o: any; try { o = line ? JSON.parse(line) : null; } catch { return; }
    if (!o) return;
    if (o.type === 'assistant' && !o.isSidechain) { const t = text(o.message?.content); if (t) before = t; return; }
    const said = humanText(o);
    if (said && SIGNAL.test(said) && !byOrch(said)) out.push({ cite: `${file}:${i + 1}`, said: said.slice(0, 600), before: before.slice(-300) });
  });
  return out;
}

export type Outcome = { id: string; session: string; status: string; stakes: string; gates: string; outcome: string };

export function parseOutcome(md: string): Outcome | null {
  const field = (k: string) => md.match(new RegExp(`^- ${k}: (.+)$`, 'm'))?.[1].trim() ?? '';
  const outcome = md.split(/^## Outcome\s*$/m)[1]?.trim() ?? '';
  const id = md.match(/^# (D-\d+)/)?.[1];
  return id && outcome ? { id, session: field('Session'), status: field('Status'), stakes: field('Stakes'), gates: field('Gates'), outcome } : null;
}
