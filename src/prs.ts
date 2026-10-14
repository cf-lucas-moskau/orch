// Pure: the user's morning PR routine for one repo.
// His PRs with colleague feedback get a worker that checks and implements it; colleagues' PRs nobody
// reviewed yet get a bimodel review and a drafted comment. Everything else is listed, not acted on.

export type Pr = {
  number: number; title: string; url: string; isDraft: boolean; headRefName: string; baseRefName: string;
  author: { login: string } | null;
  commits: { nodes: { commit: { committedDate: string } }[] };
  reviews: { nodes: { author: { login: string } | null; state: string; submittedAt: string }[] };
  reviewThreads: { nodes: { isResolved: boolean; comments: { nodes: { author: { login: string } | null; body: string; path: string | null; line: number | null }[] } }[] };
  comments: { nodes: { author: { login: string } | null; body: string; createdAt: string }[] };
};

export type Feedback = { who: string; where: string; body: string };
export type Triage =
  | { kind: 'address'; pr: Pr; feedback: Feedback[] }   // mine, colleague feedback waiting
  | { kind: 'approved'; pr: Pr; by: string[] }          // mine, approved, nothing open
  | { kind: 'waiting'; pr: Pr }                         // mine, no colleague review yet
  | { kind: 'review'; pr: Pr }                          // theirs, nobody reviewed it
  | { kind: 'reviewed'; pr: Pr; by: string[] }          // theirs, already has a review
  | { kind: 'draft'; pr: Pr };

const BOT = /\[bot\]$|^(cursor|copilot|coderabbitai|github-actions|dependabot|renovate|sonarcloud|codecov|vercel)$/i;
export const isBot = (login: string) => BOT.test(login);
const login = (a: { login: string } | null) => a?.login ?? 'ghost';

export function triagePr(pr: Pr, me: string): Triage {
  if (pr.isDraft) return { kind: 'draft', pr };
  const author = login(pr.author);
  const human = (who: string) => who !== author && !isBot(who);
  const lastCommit = pr.commits.nodes[0]?.commit.committedDate ?? '';

  if (author === me) {
    const threads: Feedback[] = pr.reviewThreads.nodes
      .filter(t => !t.isResolved && human(login(t.comments.nodes[0]?.author ?? null)))
      .map(t => { const c = t.comments.nodes[0]; return { who: login(c.author), where: c.path ? `${c.path}${c.line ? `:${c.line}` : ''}` : 'thread', body: c.body }; });
    // A review body or PR comment after the last push is feedback too; earlier ones were presumably handled.
    const later: Feedback[] = pr.comments.nodes
      .filter(c => human(login(c.author)) && c.createdAt > lastCommit)
      .map(c => ({ who: login(c.author), where: 'conversation', body: c.body }));
    const changes = pr.reviews.nodes.filter(r => human(login(r.author)) && r.state === 'CHANGES_REQUESTED' && r.submittedAt > lastCommit);
    const feedback = [...threads, ...later];
    if (feedback.length || changes.length) return { kind: 'address', pr, feedback };
    const approvers = [...new Set(pr.reviews.nodes.filter(r => human(login(r.author)) && r.state === 'APPROVED').map(r => login(r.author)))];
    return approvers.length ? { kind: 'approved', pr, by: approvers } : { kind: 'waiting', pr };
  }

  const reviewers = [...new Set(pr.reviews.nodes.map(r => login(r.author)).filter(human))];
  return reviewers.length ? { kind: 'reviewed', pr, by: reviewers } : { kind: 'review', pr };
}

const ORDER: Triage['kind'][] = ['address', 'review', 'approved', 'waiting', 'reviewed', 'draft'];
export const triagePrs = (prs: Pr[], me: string) =>
  prs.map(p => triagePr(p, me)).sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind) || a.pr.number - b.pr.number);

const LABEL: Record<Triage['kind'], string> = {
  address: 'Yours, colleague feedback to check and implement',
  review: "Colleagues', not reviewed yet",
  approved: 'Yours, approved, nothing open',
  waiting: 'Yours, waiting for a review',
  reviewed: "Colleagues', already reviewed",
  draft: 'Drafts',
};

export function renderTriage(repo: string, ts: Triage[]): string {
  const out = [`# PRs in ${repo}`, ''];
  for (const kind of ORDER) {
    const group = ts.filter(t => t.kind === kind);
    if (!group.length) continue;
    out.push(`## ${LABEL[kind]} (${group.length})`);
    for (const t of group) {
      const who = login(t.pr.author);
      const extra = t.kind === 'address' ? ` · ${t.feedback.length} open comments`
        : t.kind === 'approved' || t.kind === 'reviewed' ? ` · by ${t.by.join(', ')}` : '';
      out.push(`- #${t.pr.number} ${t.pr.title} (@${who}${extra})`);
    }
    out.push('');
  }
  if (out.length === 2) out.push('No open PRs.');
  return out.join('\n');
}

// The brief an address worker gets: every open colleague comment, verbatim, with where it points.
export function addressTask(pr: Pr, feedback: Feedback[]): string {
  return [
    `PR #${pr.number} "${pr.title}" (${pr.url}) has review feedback from colleagues. You are on a branch made from its head, ${pr.headRefName}.`,
    `For each comment: verify it against the code and decide valid, partly valid, or not valid, with a one-line reason. Implement the valid parts. Do not reply on GitHub.`,
    `End with a table: comment, verdict, reason, what you changed.`,
    '',
    ...feedback.map((f, i) => `${i + 1}. @${f.who} on ${f.where}:\n${f.body.trim()}`),
  ].join('\n');
}
