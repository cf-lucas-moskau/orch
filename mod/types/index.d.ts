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

export type Files = { sessions: Record<string, SessionInfo>; workers: Worker[]; decisions: Decision[]; log: string[] }
export type Tab = 'map' | 'bus' | 'workers' | 'decisions' | 'flows'
export type View = { tab: Tab; sel: number; steering: boolean; readout: { name: string; text: string } | null; note: string }

declare module 'claude-code' {
  interface PluginState {
    'orch-deck': {
      feed: FeedEvent[]
      files: Files
      view: View
      live: Flow[]
      tick: number
    }
  }
}
