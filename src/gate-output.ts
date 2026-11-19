// Picks the failing tests out of a gate's output, so a failed gate names them instead of
// only a summary like "# fail 3". Knows node:test (TAP) and vitest output.

const MAX = 20;

// One line per failing test: its name, plus the first error line when the output has one.
export function failingTests(output: string): string[] {
  const lines = output.split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length && out.length < MAX; i++) {
    const line = lines[i];
    // node:test TAP: "not ok 3 - name", indented for subtests. A suite fails when a test in it
    // fails, so a "not ok" whose YAML says its subtests failed is skipped: the test itself is listed.
    const tap = /^\s*not ok \d+ - (.+?)\s*(?:#.*)?$/.exec(line);
    if (tap) {
      const yaml = yamlBlock(lines, i + 1);
      if (/failureType:\s*'?subtestsFailed/.test(yaml.join('\n'))) continue;
      const err = yaml.find(l => /^\s*error:\s*/.test(l));
      const msg = err ? err.replace(/^\s*error:\s*/, '').replace(/^\|-?\s*$/, '').replace(/^['"]|['"]$/g, '').trim() : '';
      const detail = msg || nextNonEmpty(yaml, yaml.indexOf(err ?? '') + 1);
      out.push(detail ? `${tap[1]}: ${clip(detail)}` : tap[1]);
      continue;
    }
    // vitest: " FAIL  |client| src/a.test.ts > suite > name" (the summary block) or " × name".
    const vt = /^\s*(?:FAIL|×|✗)\s+(.+)$/.exec(line);
    if (vt && !/^\s*FAIL\s+(?:Tests|Test Files)\b/.test(line)) {
      const err = nextNonEmpty(lines, i + 1);
      const name = vt[1].replace(/\s+\d+m?s$/, '').trim();
      const msg = err && /^(?:\w*Error|AssertionError|Error:|expected)/.test(err.trim()) ? `: ${clip(err.trim())}` : '';
      const entry = name + msg;
      if (!out.some(o => o.startsWith(name))) out.push(entry);
    }
  }
  return out;
}

function yamlBlock(lines: string[], from: number): string[] {
  if (!/^\s*---\s*$/.test(lines[from] ?? '')) return [];
  const block: string[] = [];
  for (let j = from + 1; j < lines.length && !/^\s*\.\.\.\s*$/.test(lines[j]); j++) block.push(lines[j]);
  return block;
}

function nextNonEmpty(lines: string[], from: number): string {
  for (let j = Math.max(from, 0); j < lines.length; j++) if (lines[j].trim()) return lines[j].trim();
  return '';
}

function clip(s: string): string {
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}
