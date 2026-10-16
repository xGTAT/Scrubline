/** Backend visuals: sanitized, metadata-only records of what a render observed. */
export interface BackendRequestEntry {
  method: string;
  /** hostname[:port]; never includes credentials, query or fragment. */
  host: string;
  /** Path with secret-looking segments replaced by {redacted}. */
  path: string;
  /** Query parameter NAMES only; values are never recorded. */
  queryKeys: string[];
  status: number | null;
  resourceType: string;
  /** Milliseconds from navigation start; -1 when timing is unavailable. */
  startedAt: number;
  durationMs: number | null;
  sameOrigin: boolean;
  /** True for methods that can change server state (not GET/HEAD/OPTIONS). */
  mutation: boolean;
  /** Generic failure class ('failed'/'aborted'); never error text with URLs. */
  failure?: string;
}
export interface BackendCapture {
  version: 1;
  checkpoint: string;
  specification: string;
  capturedAt: string;
  pageHost: string;
  entries: BackendRequestEntry[];
  truncated: boolean;
  /** Human-facing coverage notes; rendered in the panel, not invented later. */
  coverage: string[];
}
export interface EndpointRoute {
  method: string;
  path: string;
  file: string;
  line: number;
}
export interface EndpointMap {
  framework: 'express' | 'unknown';
  routes: EndpointRoute[];
  scannedFiles: number;
  notes: string[];
}
export interface ModuleGraph {
  nodes: string[];
  edges: { from: string; to: string }[];
  external: string[];
  scannedFiles: number;
  truncated: boolean;
}
export interface BackendDiffEntry {
  key: string;
  kind: 'added' | 'removed' | 'status' | 'timing';
  before?: string;
  after?: string;
}
export interface BackendState {
  status: 'loading' | 'ready' | 'empty' | 'error';
  checkpoint: string;
  capture?: BackendCapture;
  /** Index into endpoints.routes for each capture entry, -1 when unmatched. */
  matches?: number[];
  endpoints?: EndpointMap;
  graph?: ModuleGraph;
  diff?: BackendDiffEntry[];
  message?: string;
}
