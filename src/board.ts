export type Agent = {
  agent?: string;
  agent_session?: { value?: string };
  agent_status: string;
  pane_id: string;
  workspace_id: string;
  cwd: string;
  name?: string;
  terminal_title_stripped?: string;
};
export type Snapshot = { workspaces: { workspace_id: string; label: string }[]; agents: Agent[] };
export type FeedEvent = { ts: string; sid: string; event: string; cwd: string; prompt: string; msg: string; tail?: string; agent?: string };
export type Repo = { repo: string; branch: string };
export type Row = {
  sid: string; pane: string; workspace: string; name: string; status: string; repo: string; cwd: string; kind: string;
  asked: string; said: string; waitingOn: string; movedMin: number | null;
};

const ORDER: Record<string, number> = { blocked: 0, working: 1, done: 2, unknown: 3, idle: 4 };
const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();

export function buildBoard(
  snap: Snapshot, feed: FeedEvent[], now: number,
  opts: { selfCwd?: string; repos?: Record<string, Repo> },
): Row[] {
  const labels = new Map(snap.workspaces.map(w => [w.workspace_id, w.label]));
  const bySid = new Map<string, FeedEvent[]>();
  for (const e of feed) (bySid.get(e.sid) ?? bySid.set(e.sid, []).get(e.sid)!).push(e);

  // herdr knows Claude's session id; for Codex it is null, so take the latest Codex session seen in that cwd.
  const sidOf = (a: Agent) => a.agent_session?.value
    || feed.filter(e => e.agent === a.agent && e.cwd === a.cwd).sort((x, y) => x.ts.localeCompare(y.ts)).at(-1)?.sid;
  const rows = snap.agents
    .filter(a => sidOf(a) && a.cwd !== opts.selfCwd)
    .map(a => {
      const sid = sidOf(a)!;
      const evs = (bySid.get(sid) ?? []).sort((x, y) => x.ts.localeCompare(y.ts));
      const last = (kind: string) => evs.filter(e => e.event === kind).at(-1);
      const workspace = labels.get(a.workspace_id) ?? a.workspace_id;
      const title = a.terminal_title_stripped && a.terminal_title_stripped !== 'Claude Code' ? a.terminal_title_stripped : '';
      const repo = opts.repos?.[a.cwd];
      const lastEv = evs.at(-1);
      return {
        sid, pane: a.pane_id, workspace, status: a.agent_status, cwd: a.cwd, kind: a.agent ?? 'claude',
        name: (a.name || title || `${workspace} ${a.pane_id}`) + (a.agent && a.agent !== 'claude' ? ` (${a.agent})` : ''),
        repo: repo ? `${repo.repo}@${repo.branch}` : '',
        asked: oneLine(last('UserPromptSubmit')?.prompt ?? ''),
        said: oneLine(last('Stop')?.msg ?? ''),
        waitingOn: a.agent_status === 'blocked' ? oneLine(last('Notification')?.msg ?? '') : '',
        movedMin: lastEv ? Math.round((now - Date.parse(lastEv.ts)) / 60000) : null,
      };
    });

  return rows.sort((x, y) =>
    (ORDER[x.status] ?? 5) - (ORDER[y.status] ?? 5) || (x.movedMin ?? 1e9) - (y.movedMin ?? 1e9));
}

const cell = (s: string, n = 80) => {
  const t = s.length > n ? s.slice(0, n - 1) + '…' : s;
  return t.replace(/\|/g, '\\|');
};
const age = (m: number | null) => m === null ? '' : m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;

export function renderBoard(rows: Row[], now: number): string {
  const head = `# board\n\nUpdated ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC · ${rows.length} sessions\n\n`;
  const table = [
    '| Session | Workspace | Status | Repo | Asked | Last said / waiting on | Moved |',
    '|---|---|---|---|---|---|---|',
    ...rows.map(r => `| ${cell(r.name, 40)} | ${cell(r.workspace, 20)} | ${r.status} | ${cell(r.repo, 40)} | ${cell(r.asked)} | ${cell(r.waitingOn || r.said)} | ${age(r.movedMin)} |`),
  ];
  return head + table.join('\n') + '\n';
}
