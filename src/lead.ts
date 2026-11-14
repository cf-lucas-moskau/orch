// Leads: long-running Claude sessions that each run one area of focus under orch. orch's watcher makes every line; a
// line of a lead that is up goes to that lead's inbox (src/lead-inbox.ts), which the lead's watcher prints. While the
// lead is down, orch prints its lines itself.

export type Lead = {
  name: string;
  // Workers on this repo belong to the lead: their DONE, QUESTION, BLOCKED, STALLED and OVERLAP lines.
  repo: string;
  // Watcher line kinds that are the lead's whatever they name.
  kinds: readonly string[];
};

export const LEADS: Record<string, Lead> = {
  evrloot: { name: 'evrloot', repo: 'evrloot-next', kinds: ['IDEA', 'TEAM', 'BRIDGE'] },
};

// The herdr agent name and workspace label of a lead.
export const leadAgent = (name: string) => `lead-${name}`;

// What `lead start` keeps in leads/<name>.json, so a restart resumes the same conversation.
export type LeadRecord = { name: string; workspace: string; pane: string; sid: string; started: string; status: 'running' | 'stopped' };

// A lead's watcher writes leads/<name>.beat every minute with its session id. The lead is up only while that beat is
// fresh, comes from the session its record names, and the record says running: a watcher left over from a stopped or
// replaced lead does not count. The lead re-arms its expired 30-minute Monitor only when its turn ends, so a long turn
// leaves the beat stale while the lead works: up to BEAT_DEAD_MS a stale beat still counts as up while herdr says the
// lead's pane runs the recorded session and is working. A herdr call that failed says nothing either way ('unknown'), so
// it keeps the lead up within that grace too. pane is asked only for a stale beat.
export const BEAT_STALE_MS = 3 * 60_000;
export const BEAT_DEAD_MS = 15 * 60_000;
export type Beat = { ms: number; sid: string };
export type LeadPane = { status: string; sid: string } | 'gone' | 'unknown';
export function leadUp(beat: Beat | undefined, rec: Pick<LeadRecord, 'sid' | 'status'> | undefined, now: number, pane: () => LeadPane = () => 'gone') {
  if (!beat || !rec || rec.status !== 'running' || !rec.sid || beat.sid !== rec.sid) return false;
  const age = now - beat.ms;
  if (age < BEAT_STALE_MS) return true;
  if (age >= BEAT_DEAD_MS) return false;
  const p = pane();
  return p === 'unknown' || (p !== 'gone' && p.status === 'working' && p.sid === rec.sid);
}

// The output of `herdr agent get lead-<name>`: agent_not_found means its process is gone; anything else unreadable is unknown.
export function parsePane(stdout: string): LeadPane {
  let r: any;
  try { r = JSON.parse(stdout); } catch { return 'unknown'; }
  if (r?.error?.code === 'agent_not_found') return 'gone';
  const a = r?.result?.agent;
  return typeof a?.agent_status === 'string' ? { status: a.agent_status, sid: a.agent_session?.value ?? '' } : 'unknown';
}

const WORKER_KINDS = new Set(['DONE', 'QUESTION', 'BLOCKED', 'STALLED']);

// Who handles a watcher line: a lead's name, or 'orch'. workerRepo finds a running worker's repo by name.
export function ownerOf(line: string, workerRepo: (name: string) => string | undefined, leads: Lead[] = Object.values(LEADS)): string {
  const kind = line.split(' ', 1)[0];
  const byKind = leads.find(l => l.kinds.includes(kind));
  if (byKind) return byKind.name;
  let repo: string | undefined;
  if (WORKER_KINDS.has(kind)) {
    const m = line.match(/^\w+ worker (\S+) /);
    repo = m ? workerRepo(m[1]) : undefined;
  } else if (kind === 'OVERLAP') {
    // OVERLAP <repo>: ..., OVERLAP error: <repo>: ..., OVERLAP warning: <repo>: ...; an error about the check itself names no repo.
    repo = line.match(/^OVERLAP (?:(?:error|warning): )?([^\s:]+):/)?.[1];
  }
  return leads.find(l => l.repo === repo)?.name ?? 'orch';
}

// Whether a watcher prints a line. me: the lead this watcher runs for, or undefined for orch's own watcher.
export function shows(owner: string, me: string | undefined, up: (lead: string) => boolean): boolean {
  return me ? owner === me : owner === 'orch' || !up(owner);
}

// What orch's watcher says when a lead it was started for goes down or comes back. down is whether that was already said
// (leads/<name>.down exists), so a re-armed watcher does not say it again. A stopped lead is down on purpose: nothing to say.
export function leadNotice(lead: Lead, up: boolean, running: boolean, down: boolean): { line?: string; down: boolean } {
  if (up) return down ? { line: `LEAD ${lead.name} up: its lines go to ${leadAgent(lead.name)} again`, down: false } : { down: false };
  if (!running || down) return { down };
  return { line: `LEAD ${lead.name} down: orch handles its ${lead.kinds.join(', ')} and ${lead.repo} worker lines until it is back (npm run -s orch -- lead start ${lead.name})`, down: true };
}

// The first prompt of a lead: a fresh one reads its skill, a resumed one only re-arms its watcher.
export const leadPrompt = (name: string, resumed: boolean) => resumed
  ? `orch restarted you as lead ${name}. Re-arm your watcher as the orch-lead skill says (ORCH_LEAD=${name}), then carry on where you were.`
  : `You are lead ${name}. Read .claude/skills/orch-lead/SKILL.md and follow it.`;
