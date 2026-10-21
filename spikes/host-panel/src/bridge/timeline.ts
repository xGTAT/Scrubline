export interface TrackedFile {
  path: string;
  hash: string;
  size: number;
  mode: number;
}
export type Attribution =
  | { kind: 'unattributed' }
  | { kind: 'hook'; tool: string; conversation?: string; stepIdx?: number; paths: string[] }
  | { kind: 'composed'; mode: 'combine' | 'revert' | 'mosaic'; sources: string[] };
export interface PerfMetrics {
  htmlBytes: number;
  domElements: number;
  cssBytes: number;
  cssRules: number;
  assetBytes: number;
  totalBytes: number;
}
export interface PerfDelta {
  metric: keyof PerfMetrics;
  label: string;
  before: number;
  after: number;
  delta: number;
}
export interface Checkpoint {
  schemaVersion: 1;
  id: string;
  parentId: string | null;
  branch?: { id: string; name: string };
  createdAt: string;
  trigger: 'baseline' | 'watcher' | 'save' | 'reconcile';
  files: TrackedFile[];
  attribution: Attribution;
  perf?: PerfMetrics;
}
export interface TimelineRow {
  alternative?: string;
  id: string;
  createdAt: string;
  changedPaths: string[];
  attribution: Attribution;
  perf?: PerfMetrics;
  perfDelta?: PerfDelta[];
  renderMs?: number;
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
    receipt?: import('../evidence/types').RenderReceipt;
    preload?: string;
    preloadPrevious?: string;
    regions?: import('../webview/Frame').Region[];
    comparison?: { checkpoint: string; regions: import('../webview/Frame').Region[] };
    label?: string;
    message?: string;
  };
  review?: {
    token: string;
    checkpoint: string;
    paths: string[];
    conflicts: string[];
    note?: string;
    elements?: { selector?: string; paths: string[] }[];
    /** Element picks that can apply to one page or every matching HTML page. */
    scope?: { selected: 'page' | 'sitewide'; documents: number };
    /** Present when the review is a multi-checkpoint composition. */
    multi?: {
      mode: 'combine' | 'revert' | 'mosaic';
      sources: string[];
      decisions: { path: string; sources: string[]; status: string; reason?: string }[];
      warnings: string[];
      hints: { missing: string; neededBy: string; path: string }[];
      /** Composition conflicts blocking apply (separate from drift). */
      blocked: string[];
      overrides?: Record<string, string | { source: string; element: string }>;
      /** Binds mode, ordered sources, overrides and the exact composed file
       * set; recomputed at apply time so a stale review cannot apply. */
      compositionId: string;
    };
  };
  selection?: { ids: string[]; mode: 'combine' | 'revert' | 'mosaic' };
  measuredPacket?: import('../targeting/measured').MeasuredPacket;
  backend?: import('../backend/types').BackendState;
  rollback?: { message: string; changes?: import('../investigation/change-units').CssUnit[] };
  canUndo?: boolean;
  branches?: { id: string; name: string; checkpoint: string; base: string; directory: string }[];
  comparison?: { left?: string; right?: string; leftId: string; rightId: string; message?: string };
  /** Per-alternative webpage previews, keyed by branch id. `checkpoint` binds the
   * image to the exact branch head it renders; a mismatch means stale. */
  branchPreviews?: Record<string, { checkpoint: string; image?: string; message?: string }>;
  pages?: import('../pages').PageInfo[];
  activePage?: string;
  layout?: import('../layout/types').LayoutMatrix;
  investigation?: import('../investigation/types').Investigation;
  targeting?: {
    status: 'off' | 'on' | 'ready' | 'stale' | 'error';
    message?: string;
    packet?: string;
    crop?: string;
    summary?: string;
    selection?: import('../targeting/packet').Selection;
    selections?: import('../targeting/packet').Selection[];
  };
  chatbot?: import('../chatbot/types').ChatbotState;
  verificationReport?: import('../verification/types').VerificationReport;
  /** Elements the user locked; agents and restores must never modify them. */
  locks?: import('../locks/registry').LockedElement[];
  /** Locks whose owning document changed in the latest capture - drift warning. */
  lockDrift?: { selector: string; document: string; label?: string }[];
  /** Active panel presentation. 'standard' (default) shows the everyday scrub/
   * preview/review surface; 'dev' adds granular diagnostics and advanced
   * actions. Published by the host so every view stays in sync. */
  uiMode?: 'standard' | 'dev';
}
export type TimelineInbound =
  | { type: 'set-ui-mode'; mode: 'standard' | 'dev' }
  | { type: 'lock-element'; label?: string }
  | { type: 'open-locks-preview' }
  | { type: 'unlock-element'; selector: string; document: string }
  | { type: 'render-history' }
  | { type: 'fullscreen'; active: boolean }
  | { type: 'cancel-render' }
  | { type: 'refresh-renders' }
  | { type: 'recheck-render'; id: string }
  | {
      type: 'layout-sweep';
      widths: number[];
      checkpoints: string[];
      guard: import('../layout/types').LayoutGuard;
    }
  | { type: 'cancel-layout' }
  | { type: 'investigate-css'; request: import('../investigation/types').InvestigationRequest }
  | { type: 'cancel-investigation' }
  | { type: 'build-measured-packet' }
  | { type: 'copy-measured-packet'; identity: string }
  | { type: 'review-css-rollback'; keep: import('../layout/types').LayoutGuard[] }
  | { type: 'fork-checkpoint'; id: string }
  | { type: 'capture-branch'; branch: string }
  | { type: 'compare-branch'; branch: string }
  | { type: 'preview-branches' }
  | { type: 'pick-element'; id: string }
  | { type: 'review-element'; id: string; document: string; element: string }
  | { type: 'review-navbar'; id: string; document: string }
  | { type: 'review-section'; id: string; document: string }
  | { type: 'review-selective'; id: string; paths: string[] }
  | {
      type: 'review-multi-element';
      selections: {
        checkpointId: string;
        document: string;
        selector?: string;
        fingerprint?: string;
      }[];
    }
  | { type: 'clear-target-selections' }
  | { type: 'start-targeting' }
  | { type: 'stop-targeting' }
  | { type: 'copy-packet' }
  | { type: 'validate-target' }
  | { type: 'request-timeline' }
  | { type: 'request-backend'; id: string }
  | { type: 'set-page'; document: string }
  | { type: 'selective-scope'; scope: 'page' | 'sitewide' }
  | { type: 'add-page' }
  | { type: 'retry-capture' }
  | { type: 'select-checkpoint'; id: string }
  | {
      type: 'set-selection';
      ids: string[];
      mode: 'combine' | 'revert' | 'mosaic';
    }
  | {
      type: 'review-multi';
      ids: string[];
      mode: 'combine' | 'revert' | 'mosaic';
      overrides?: Record<string, string | { source: string; element: string }>;
    }
  | { type: 'start-preview' }
  | { type: 'review-checkpoint'; id: string }
  | { type: 'apply-reviewed'; id: string; token: string }
  | { type: 'undo-restore' }
  | { type: 'open-preview' }
  | { type: 'open-diff'; id: string; path: string }
  | { type: 'ask-chatbot'; query: string; checkpointId?: string; compareCheckpointId?: string }
  | { type: 'clear-chatbot-history' }
  | { type: 'request-chatbot-state' };
export type TimelineOutbound =
  | { type: 'timeline'; data: TimelineState }
  | { type: 'select'; id: string }
  | { type: 'chatbot-state'; data: import('../chatbot/types').ChatbotState };
