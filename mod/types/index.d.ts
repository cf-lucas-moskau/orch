// orch deck's state contract and the shapes hooks/core.ts works on. Self-contained, as mods require.

export type FeedEvent = { ts: string; sid: string; event: string; cwd: string; prompt: string; msg: string; tail?: string; agent?: string };
export type SessionInfo = { pane: string; workspace: string; name: string; cwd: string; kind: string };
export type Worker = { name: string; kind?: string; pair?: string; repo: string; task: string; branch: string; pane: string; sid: string; started: string; status: string };
export type Decision = { id: string; question: string; status: string; session: string; opened: string; recommendation: string };

export type Status = 'blocked' | 'question' | 'working' | 'done' | 'idle';
export type Stage = 'brief' | 'work' | 'gates' | 'review' | 'judge' | 'push';
export type Node = {
  sid: string; name: string; pane: string; kind: 'claude' | 'codex'; status: Status; lastTs: string; lastEvent: string; said: string;
  worker: null | { repo: string; branch: string; task: string; stage: Stage; pair: string | null; started: string };
};
export type BusKind = 'needs' | 'relay' | 'fyi' | 'prompt';
export type BusLine = { ts: string; sid: string; name: string; kind: BusKind; text: string };
export type FlowName = 'dispatch' | 'review' | 'prs' | 'continue' | 'learn' | 'decisions' | 'status';
export type Flow = { ts: string; flow: FlowName; detail: string };
export type Deck = { nodes: Node[]; idle: number; bus: BusLine[]; decisions: Decision[]; flows: Flow[] };

export type Level = 'ok' | 'warn' | 'crit';
export type Pressure = 'normal' | 'warn' | 'critical';
export type Disk = { mount: string; totalB: number; freeB: number };
export type Power = { source: string; pct: number | null; state: string; remaining: string | null };
export type DockerRow = { type: string; sizeB: number; reclaimB: number | null };
export type Sys = { memB: number; load: [number, number, number]; cpus: number; pCores: number | null; eCores: number | null; bootS: number; swapB: number; pressure: Pressure };
// fast: every 30 s, each command ~20 ms. slow: every 5 min (docker df ~0.5 s, du of the worktrees ~2 s).
export type Health = {
  fast: null | { disks: Disk[]; memUsedB: number; sys: Sys; power: Power; therm: { speedLimit: number | null; warning: number | null } };
  slow: null | { docker: DockerRow[] | string; worktreesB: number | null; tempC: number | null };
};
// brief: the few words the status line shows when the row is not ok.
export type HealthRow = { label: string; value: string; level: Level; brief?: string };

export type Files = { sessions: Record<string, SessionInfo>; workers: Worker[]; decisions: Decision[]; log: string[] }
export type Tab = 'map' | 'bus' | 'workers' | 'decisions' | 'flows' | 'health'
export type View = { tab: Tab; sel: number; steering: boolean; readout: { name: string; text: string } | null; note: string }

declare module 'claude-code' {
  interface PluginState {
    'orch-deck': {
      feed: FeedEvent[]
      files: Files
      view: View
      live: Flow[]
      tick: number
      health: Health
    }
  }
}
