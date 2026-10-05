export interface TrackedFile {
  path: string;
  hash: string;
  size: number;
  mode: number;
}
export type Attribution =
  | { kind: 'unattributed' }
  | { kind: 'hook'; tool: string; conversation?: string; stepIdx?: number; paths: string[] };
export interface Checkpoint {
  schemaVersion: 1;
  id: string;
  parentId: string | null;
  createdAt: string;
  trigger: 'baseline' | 'watcher' | 'save' | 'reconcile';
  files: TrackedFile[];
  attribution: Attribution;
}
export interface TimelineRow {
  id: string;
  createdAt: string;
  changedPaths: string[];
  attribution: Attribution;
}
export interface TimelineState {
  status: 'empty' | 'loading' | 'ready' | 'error' | 'limit';
  rows: TimelineRow[];
  unsaved: boolean;
  message?: string;
}
export type TimelineInbound = { type: 'request-timeline' } | { type: 'retry-capture' };
export interface TimelineOutbound {
  type: 'timeline';
  data: TimelineState;
}
