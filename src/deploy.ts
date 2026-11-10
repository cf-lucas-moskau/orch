// Pure: what the Evrloot deploy (src/deploy-evrloot.ts) refuses before it touches the live world.

// The first statement in a migration that drops or deletes data, or null. Comments and string literals go first and
// whitespace is collapsed, so a statement split over lines is matched whole. Any DROP counts, ALTER ... DROP included:
// a refusal only means Lucas looks first.
export function dataLoss(sql: string): string | null {
  const flat = sql.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ').replace(/'(?:[^']|'')*'/g, "''").replace(/\s+/g, ' ');
  return flat.split(';').map(s => s.trim()).find(s => /\b(drop|truncate)\b|\bdelete\s+from\b/i.test(s)) ?? null;
}

// git diff --name-status <deployed> origin/main lines for the migrations folder, and a reader for a file at origin/main.
// Every migration added since the running release is checked whole; one changed, deleted or renamed after it shipped
// is refused outright, since the database already ran it.
export function migrationBlocker(nameStatus: string, show: (path: string) => string): string | null {
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [status, path] = line.split('\t');
    if (!path.endsWith('.sql')) continue;
    if (status !== 'A') return `${path} was ${({ M: 'changed', D: 'deleted' } as Record<string, string>)[status] ?? 'renamed or replaced'} after it shipped`;
    const stmt = dataLoss(show(path));
    if (stmt) return `${path} drops or deletes data: ${stmt.slice(0, 160)}`;
  }
  return null;
}
