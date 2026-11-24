// Citizen art progress for the queue page's Art tab: what each Citizen body should wear (targets.json, written by
// evrloot-next from its item catalog) against what the live atlases on the deployment carry (index.json `items`).
export type Target = { name: string; slot: string };
export type Group = 'own' | 'universal' | 'held' | 'warborn';
export type Targets = Record<string, Partial<Record<Group, Target[]>>>;
export type GroupProgress = { group: Group; live: number; total: number; missing: Target[] };
// live/total count only what a Citizen can wear; warborn (Warborn-only items, never equippable on a Citizen) is listed apart.
export type BodyProgress = { body: string; live: number; total: number; groups: GroupProgress[]; warborn: GroupProgress; liveKnown: boolean };

export const BODIES = ['behemoth-f', 'behemoth-m', 'sandshaper-f', 'sandshaper-m'];
export const GROUPS: Group[] = ['own', 'universal', 'held'];
const ALL: Group[] = [...GROUPS, 'warborn'];

// "Main hand" and "main-hand" are one slot; the atlas keys are "<slot>:<name>".
export const slotKey = (s: string) => s.trim().toLowerCase().replace(/[\s_]+/g, '-');
const norm = (s: string) => s.normalize('NFKC').replace(/[’‘]/g, "'").trim().toLowerCase();

// live: per body the keys of its atlas's items, or undefined when the live index could not be read.
export function artProgress(targets: Targets, live: Record<string, string[] | undefined>, bodies = BODIES): BodyProgress[] {
  return bodies.map(body => {
    const keys = live[body];
    const have = new Set((keys ?? []).map(k => {
      const i = k.indexOf(':');
      return i < 0 ? `:${norm(k)}` : `${slotKey(k.slice(0, i))}:${norm(k.slice(i + 1))}`;
    }));
    const names = new Set([...have].map(k => k.slice(k.indexOf(':') + 1)));
    const t = targets[body] ?? {};
    // An item counts in one group only: a neck item is both universal and held (drawn from old art), and counts as held.
    const owner = new Map<string, Group>();
    for (const g of ['own', 'held', 'universal', 'warborn'] as Group[])
      for (const x of t[g] ?? []) if (!owner.has(norm(x.name))) owner.set(norm(x.name), g);
    const all = ALL.map(group => {
      const list = (t[group] ?? []).filter(x => owner.get(norm(x.name)) === group);
      // A name can only count once per body, even if the catalog lists it under two slots.
      const seen = new Set<string>();
      const uniq = list.filter(x => !seen.has(`${slotKey(x.slot)}:${norm(x.name)}`) && !!seen.add(`${slotKey(x.slot)}:${norm(x.name)}`));
      const isLive = (x: Target) => have.has(`${slotKey(x.slot)}:${norm(x.name)}`) || names.has(norm(x.name));
      const missing = uniq.filter(x => !isLive(x));
      return { group, live: uniq.length - missing.length, total: uniq.length, missing };
    });
    const groups = all.slice(0, GROUPS.length);
    return {
      body, liveKnown: keys !== undefined, warborn: all[GROUPS.length],
      live: groups.reduce((s, g) => s + g.live, 0), total: groups.reduce((s, g) => s + g.total, 0), groups,
    };
  });
}
