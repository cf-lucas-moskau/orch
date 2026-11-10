// Leads: long-running Claude sessions that each run one area of focus under orch. A lead's watcher prints the lines of
// its area; orch's watcher drops them while that lead is up and handles them itself while it is down.

export type Lead = {
  name: string;
  // Workers on this repo belong to the lead: their DONE, QUESTION, BLOCKED and OVERLAP lines.
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

// A lead's watcher touches leads/<name>.beat every minute with its session id. Older than this, the lead counts as down:
// a watcher re-armed after its 30-minute Monitor timeout is back well within it.
export const BEAT_STALE_MS = 3 * 60_000;
export const leadUp = (beatMs: number | undefined, now: number) => beatMs !== undefined && now - beatMs < BEAT_STALE_MS;

const WORKER_KINDS = new Set(['DONE', 'QUESTION', 'BLOCKED']);

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
