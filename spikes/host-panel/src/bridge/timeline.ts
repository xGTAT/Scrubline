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
  branch?: { id: string; name: string };
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
  selected?: string;
  rendered?: string[];
  rendering?: {
    running: boolean;
    done: number;
    total: number;
    failed: number;
    cancelled?: boolean;
    message?: string;
  };
  preview?: {
    status: 'idle' | 'loading' | 'ready' | 'error';
    checkpoint?: string;
    url?: string;
    image?: string;
    preload?: string;
    preloadPrevious?: string;
    regions?: import('../webview/Frame').Region[];
    label?: string;
    message?: string;
  };
  review?: { token: string; checkpoint: string; paths: string[]; conflicts: string[] };
  canUndo?: boolean;
  branches?: { id: string; name: string; checkpoint: string; base: string; directory: string }[];
  comparison?: { left?: string; right?: string; leftId: string; rightId: string; message?: string };
  targeting?: {
    status: 'off' | 'on' | 'ready' | 'stale' | 'error';
    message?: string;
    packet?: string;
    crop?: string;
    summary?: string;
  };
}
export type TimelineInbound =
  | { type: 'render-history' }
  | { type: 'fullscreen'; active: boolean }
  | { type: 'cancel-render' }
  | { type: 'refresh-renders' }
  | { type: 'fork-checkpoint'; id: string }
  | { type: 'capture-branch'; branch: string }
  | { type: 'compare-branch'; branch: string }
  | { type: 'review-navbar'; id: string; document: string }
  | { type: 'review-selective'; id: string; paths: string[] }
  | { type: 'start-targeting' }
  | { type: 'stop-targeting' }
  | { type: 'copy-packet' }
  | { type: 'validate-target' }
  | { type: 'request-timeline' }
  | { type: 'retry-capture' }
  | { type: 'select-checkpoint'; id: string }
  | { type: 'start-preview' }
  | { type: 'review-checkpoint'; id: string }
  | { type: 'apply-reviewed'; id: string; token: string }
  | { type: 'undo-restore' }
  | { type: 'open-preview' }
  | { type: 'open-diff'; id: string; path: string };
export interface TimelineOutbound {
  type: 'timeline';
  data: TimelineState;
}
