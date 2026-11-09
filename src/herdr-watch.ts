// The watcher's herdr side, for workers whose sessions send no hook events (Codex: no session id in herdr, and no
// turn hooks since herdr 0.9.5). Their finishes and blocks come from `herdr agent wait`; the hook feed stays the only
// source for every other session.
export type HerdrAgent = { agent_status?: string; state_change_seq?: number; completion_seq?: number };
export type HerdrReply = { result?: { agent?: HerdrAgent }; error?: { code: string; message?: string } };

// done and idle are one finish (focusing a pane turns done into idle); completion_seq tells it from the next one.
export function settleKey(a: HerdrAgent): string | null {
  if (a.agent_status === 'blocked') return `blocked ${a.state_change_seq}`;
  if (a.agent_status === 'done' || a.agent_status === 'idle') return `settled ${a.completion_seq ?? a.state_change_seq}`;
  return null;
}

// The workers herdr follows: running, prompted (before its first prompt a worker sits idle, which is no finish),
// without a session id, and with no hook event from their worktree. Codex usually sends hooks through orch's own
// Codex hook; when it does, the feed covers it and herdr would only repeat its lines.
export type Followed = { name: string; pane: string; worktree: string; sid?: string; status: string; prompted?: string };
export const herdrFollowed = <W extends Followed>(workers: W[], hooked: Set<string>): W[] =>
  workers.filter(w => w.status === 'running' && w.pane && w.prompted && !w.sid && !hooked.has(w.worktree));

export const RETRY = 5000;
export type FollowDeps = {
  get: () => Promise<HerdrReply>;
  // until [] is herdr's settled wait (idle, done or blocked).
  wait: (until: string[]) => Promise<HerdrReply>;
  sleep: (ms: number) => Promise<void>;
  emit: (kind: 'blocked' | 'done', a: HerdrAgent) => void;
};

// Follows one worker's pane until alive() turns false. Every round first looks at the current state, so a finish
// before the watcher found the worker, or during a failed wait, still counts; each settled state is reported once.
// seed takes the state at start as known without reporting it: a watcher re-arm must not repeat old finishes.
export async function follow(d: FollowDeps, alive: () => boolean, seed = false) {
  let handled: string | null = null;
  const settle = (a: HerdrAgent | undefined) => {
    const key = a ? settleKey(a) : null;
    if (!a || !key || key === handled) return;
    handled = key;
    if (!seed) d.emit(a.agent_status === 'blocked' ? 'blocked' : 'done', a);
  };
  const failed = async (r: HerdrReply) => {
    if (!r.error) return false;
    if (r.error.code !== 'timeout') await d.sleep(RETRY);
    return true;
  };
  while (alive()) {
    const now = await d.get();
    if (!alive()) return;
    settle(now.result?.agent);
    seed = false;
    if (await failed(now)) continue;
    const w = await d.wait(['working']);
    if (!alive()) return;
    if (await failed(w)) continue;
    const s = await d.wait([]);
    if (!alive()) return;
    if (await failed(s)) continue;
    settle(s.result?.agent);
  }
}
