import React, { useMemo, useState } from 'react';
import type {
  BackendState,
  BackendCapture,
  ModuleGraph,
  BackendRequestEntry
} from '../backend/types';

const base = (p: string) => p.split('/').pop() ?? p;

/* ── Method / status styling maps ─────────────────────────────────── */

const METHOD_COLORS: Record<string, string> = {
  GET: 'var(--vscode-charts-blue, #3794ff)',
  POST: 'var(--vscode-testing-iconPassed, #4caf7d)',
  PUT: 'var(--vscode-editorWarning-foreground, #e5c07b)',
  PATCH: 'var(--vscode-charts-orange, #d18616)',
  DELETE: 'var(--vscode-testing-iconFailed, #f14c4c)',
  HEAD: 'var(--vscode-descriptionForeground, #999)',
  OPTIONS: 'var(--vscode-descriptionForeground, #999)'
};

function methodColor(m: string) {
  return METHOD_COLORS[m.toUpperCase()] ?? 'var(--vscode-descriptionForeground, #999)';
}

function statusClass(e: BackendRequestEntry) {
  if (e.failure) return 'status-failed';
  if (e.status == null) return 'status-failed';
  if (e.status < 300) return 'status-ok';
  if (e.status < 400) return 'status-redirect';
  return 'status-error';
}

function statusLabel(e: BackendRequestEntry) {
  return e.failure ?? String(e.status ?? '---');
}

function fmtMs(ms: number | null) {
  if (ms == null) return '---';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/* ── Request type grouping ────────────────────────────────────────── */

type Group = { key: string; label: string; entries: BackendRequestEntry[] };

function groupEntries(entries: BackendRequestEntry[]): Group[] {
  const doc: BackendRequestEntry[] = [];
  const api: BackendRequestEntry[] = [];
  const static_: BackendRequestEntry[] = [];
  const thirdParty: BackendRequestEntry[] = [];
  for (const e of entries) {
    if (!e.sameOrigin) thirdParty.push(e);
    else if (e.resourceType === 'document') doc.push(e);
    else if (e.resourceType === 'fetch' || e.resourceType === 'xhr') api.push(e);
    else static_.push(e);
  }
  const groups: Group[] = [];
  if (doc.length) groups.push({ key: 'doc', label: 'Document', entries: doc });
  if (api.length) groups.push({ key: 'api', label: 'API Calls', entries: api });
  if (static_.length) groups.push({ key: 'static', label: 'Static Assets', entries: static_ });
  if (thirdParty.length) groups.push({ key: 'third', label: 'Third-Party', entries: thirdParty });
  return groups;
}

/* ── Time axis ────────────────────────────────────────────────────── */

function TimeAxis({ end, width, labelW }: { end: number; width: number; labelW: number }) {
  const chartW = width - labelW - 70;
  const ticks: number[] = [];
  const step = end <= 100 ? 25 : end <= 500 ? 100 : end <= 2000 ? 500 : 1000;
  for (let t = 0; t <= end; t += step) ticks.push(t);
  if (ticks[ticks.length - 1] < end) ticks.push(end);
  return (
    <div className="bv-axis" style={{ paddingLeft: labelW }}>
      {ticks.map((t) => (
        <span key={t} className="bv-axis-tick" style={{ left: labelW + (chartW * t) / end }}>
          {fmtMs(t)}
        </span>
      ))}
    </div>
  );
}

/* ── Waterfall row ────────────────────────────────────────────────── */

function WaterfallRow({
  entry,
  end,
  labelW,
  width,
  open,
  onToggle,
  match,
  routes
}: {
  entry: BackendRequestEntry;
  end: number;
  labelW: number;
  width: number;
  open: boolean;
  onToggle: () => void;
  match?: number;
  routes?: { method: string; path: string; file: string; line: number }[];
}) {
  const chartW = width - labelW - 70;
  const x = entry.startedAt >= 0 ? (chartW * entry.startedAt) / end : 0;
  const w =
    entry.durationMs != null && entry.startedAt >= 0
      ? Math.max(3, (chartW * entry.durationMs) / end)
      : 3;
  const sc = statusClass(entry);
  return (
    <>
      <button className={`bv-row ${open ? 'bv-row-open' : ''}`} onClick={onToggle} type="button">
        <span className="bv-method" style={{ color: methodColor(entry.method) }}>
          {entry.method}
        </span>
        <span className="bv-path" title={`${entry.host}${entry.path}`}>
          {entry.path}
          {entry.queryKeys.length > 0 && (
            <span className="bv-query">?{entry.queryKeys.join(',')}</span>
          )}
        </span>
        <span className="bv-bar-track">
          <span
            className={`bv-bar ${sc} ${entry.mutation ? 'mutation' : ''}`}
            style={{ left: x, width: w }}
          />
        </span>
        <span className={`bv-status ${sc}`}>{statusLabel(entry)}</span>
        <span className="bv-duration">{fmtMs(entry.durationMs)}</span>
      </button>
      {open && (
        <div className="bv-detail">
          <div className="bv-detail-grid">
            <span className="bv-detail-label">Host</span>
            <span className="bv-detail-value">{entry.host}</span>
            <span className="bv-detail-label">Type</span>
            <span className="bv-detail-value">{entry.resourceType}</span>
            <span className="bv-detail-label">Started</span>
            <span className="bv-detail-value">{fmtMs(entry.startedAt)}</span>
            <span className="bv-detail-label">Duration</span>
            <span className="bv-detail-value">{fmtMs(entry.durationMs)}</span>
            {!entry.sameOrigin && (
              <>
                <span className="bv-detail-label">Origin</span>
                <span className="bv-detail-value bv-third-party-badge">Third-party</span>
              </>
            )}
            {entry.mutation && (
              <>
                <span className="bv-detail-label">Mutation</span>
                <span className="bv-detail-value bv-mutation-badge">Write request</span>
              </>
            )}
          </div>
          {match != null && routes && match >= 0 && (
            <p className="bv-detail-match">
              Handler: {routes[match].file}:{routes[match].line}
            </p>
          )}
          {match === -1 && <p className="bv-detail-nomatch">No static route match.</p>}
        </div>
      )}
    </>
  );
}

/* ── Waterfall group section ──────────────────────────────────────── */

function WaterfallGroup({
  group,
  end,
  labelW,
  width,
  matches,
  routes,
  offset
}: {
  group: Group;
  end: number;
  labelW: number;
  width: number;
  matches?: number[];
  routes?: { method: string; path: string; file: string; line: number }[];
  offset: number;
}) {
  const [openRow, setOpenRow] = useState<number | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const totalMs = group.entries.reduce((s, e) => s + (e.durationMs ?? 0), 0);
  return (
    <div className="bv-group">
      <button className="bv-group-header" onClick={() => setCollapsed(!collapsed)} type="button">
        <span className="bv-group-arrow">{collapsed ? '\u25B8' : '\u25BE'}</span>
        <span className="bv-group-label">{group.label}</span>
        <span className="bv-group-count">{group.entries.length}</span>
        <span className="bv-group-time">{fmtMs(totalMs)}</span>
      </button>
      {!collapsed &&
        group.entries.map((e, i) => (
          <WaterfallRow
            key={i}
            entry={e}
            end={end}
            labelW={labelW}
            width={width}
            open={openRow === i}
            onToggle={() => setOpenRow(openRow === i ? null : i)}
            match={matches?.[offset + i]}
            routes={routes}
          />
        ))}
    </div>
  );
}

/* ── Main waterfall ───────────────────────────────────────────────── */

function Waterfall({
  capture,
  matches,
  routes
}: {
  capture: BackendCapture;
  matches?: number[];
  routes?: { method: string; path: string; file: string; line: number }[];
}) {
  const [filter, setFilter] = useState('');
  const entries = capture.entries.slice(0, 200);
  const end = Math.max(
    1,
    ...entries.map((e) => (e.startedAt >= 0 ? e.startedAt + (e.durationMs ?? 0) : 0))
  );
  const labelW = 0; // CSS handles label sizing now
  const width = 800;

  const filtered = useMemo(() => {
    if (!filter.trim()) return entries;
    const q = filter.toLowerCase();
    return entries.filter(
      (e) =>
        e.path.toLowerCase().includes(q) ||
        e.method.toLowerCase().includes(q) ||
        String(e.status ?? '').includes(q) ||
        e.host.includes(q)
    );
  }, [entries, filter]);

  const groups = useMemo(() => groupEntries(filtered), [filtered]);
  // Rebuild matches array aligned to filtered entries
  const alignedMatches = useMemo(() => {
    if (!matches) return undefined;
    const origIndices = new Map<BackendRequestEntry, number>();
    entries.forEach((e, i) => origIndices.set(e, i));
    return filtered.map((e) => {
      const origIdx = origIndices.get(e);
      return origIdx != null ? matches[origIdx] : -1;
    });
  }, [entries, filtered, matches]);

  let offset = 0;
  return (
    <div className="bv-waterfall">
      <div className="bv-toolbar">
        <input
          className="bv-filter"
          type="text"
          placeholder="Filter by path, method, status..."
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
        />
        <span className="bv-toolbar-count">
          {filtered.length} of {entries.length} request{entries.length !== 1 ? 's' : ''}
        </span>
      </div>
      <TimeAxis end={end} width={width} labelW={labelW} />
      {groups.map((g) => {
        const o = offset;
        offset += g.entries.length;
        return (
          <WaterfallGroup
            key={g.key}
            group={g}
            end={end}
            labelW={labelW}
            width={width}
            matches={alignedMatches?.slice(o, o + g.entries.length)}
            routes={routes}
            offset={o}
          />
        );
      })}
      {filtered.length === 0 && <small className="bv-empty">No requests match the filter.</small>}
      {capture.truncated && (
        <small className="bv-note">Capture truncated at the configured limit.</small>
      )}
    </div>
  );
}

/* ── Module graph ─────────────────────────────────────────────────── */

function fileTypeColor(path: string): string {
  if (/route|endpoint|api/i.test(path)) return 'var(--vscode-charts-blue, #3794ff)';
  if (/model|schema|db|database/i.test(path)) return 'var(--vscode-testing-iconPassed, #4caf7d)';
  if (/middleware|auth|guard/i.test(path)) return 'var(--vscode-editorWarning-foreground, #e5c07b)';
  if (/config|env|setting/i.test(path)) return 'var(--vscode-charts-purple, #b180d7)';
  if (/util|helper|lib|shared/i.test(path)) return 'var(--vscode-charts-foreground, #ccc)';
  return 'var(--vscode-descriptionForeground, #999)';
}

function Graph({ graph }: { graph: ModuleGraph }) {
  const [hovered, setHovered] = useState<string | null>(null);
  const layout = useMemo(() => {
    const nodes = graph.nodes.slice(0, 80);
    const incoming = new Map<string, number>();
    const outgoing = new Map<string, number>();
    for (const e of graph.edges) {
      incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
      outgoing.set(e.from, (outgoing.get(e.from) ?? 0) + 1);
    }
    const depth = new Map<string, number>();
    const queue = nodes.filter((n) => !incoming.has(n));
    for (const n of queue) depth.set(n, 0);
    const edges = graph.edges.filter((e) => nodes.includes(e.from) && nodes.includes(e.to));
    const adj = new Map<string, string[]>();
    for (const e of edges) adj.set(e.from, [...(adj.get(e.from) ?? []), e.to]);
    let guard = 0;
    const bfs = [...queue];
    while (bfs.length && guard++ < 5000) {
      const n = bfs.shift()!;
      for (const next of adj.get(n) ?? []) {
        const d = (depth.get(n) ?? 0) + 1;
        if ((depth.get(next) ?? -1) < d) {
          depth.set(next, d);
          bfs.push(next);
        }
      }
    }
    for (const n of nodes) if (!depth.has(n)) depth.set(n, 0);
    const layers = new Map<number, string[]>();
    for (const n of nodes) {
      const d = Math.min(depth.get(n) ?? 0, 8);
      layers.set(d, [...(layers.get(d) ?? []), n]);
    }
    const pos = new Map<string, { x: number; y: number; w: number; connections: number }>();
    for (const [d, list] of layers)
      list.forEach((n, i) => {
        const connections = (incoming.get(n) ?? 0) + (outgoing.get(n) ?? 0);
        const name = base(n);
        const w = Math.max(100, Math.min(180, name.length * 7 + 20));
        pos.set(n, { x: 24 + d * 200, y: 24 + i * 34, w, connections });
      });
    return { nodes, edges, pos, layers: layers.size };
  }, [graph]);

  const connectedTo = useMemo(() => {
    if (!hovered) return new Set<string>();
    const set = new Set<string>([hovered]);
    for (const e of layout.edges) {
      if (e.from === hovered) set.add(e.to);
      if (e.to === hovered) set.add(e.from);
    }
    return set;
  }, [hovered, layout.edges]);

  const height = Math.max(80, ...[...layout.pos.values()].map((p) => p.y + 30));
  return (
    <svg
      viewBox={`0 0 ${Math.max(400, layout.layers * 200 + 40)} ${height}`}
      role="img"
      aria-label="Module import graph"
      className="bv-graph"
    >
      <defs>
        <marker
          id="bv-arrow"
          viewBox="0 0 6 6"
          refX="5"
          refY="3"
          markerWidth="5"
          markerHeight="5"
          orient="auto-start-reverse"
        >
          <path
            d="M0,0 L6,3 L0,6"
            fill="none"
            stroke="var(--vscode-descriptionForeground, #888)"
            strokeWidth="1"
          />
        </marker>
      </defs>
      {layout.edges.map((e, i) => {
        const a = layout.pos.get(e.from);
        const b = layout.pos.get(e.to);
        if (!a || !b) return null;
        const dim = hovered && !(connectedTo.has(e.from) && connectedTo.has(e.to));
        const x1 = a.x + a.w;
        const y1 = a.y + 10;
        const x2 = b.x;
        const y2 = b.y + 10;
        const cx = (x1 + x2) / 2;
        return (
          <path
            key={i}
            d={`M${x1},${y1} C${cx},${y1} ${cx},${y2} ${x2},${y2}`}
            className={`bv-graph-edge ${dim ? 'dim' : ''}`}
            markerEnd="url(#bv-arrow)"
          />
        );
      })}
      {layout.nodes.map((n) => {
        const p = layout.pos.get(n)!;
        const dim = hovered && !connectedTo.has(n);
        return (
          <g
            key={n}
            onMouseEnter={() => setHovered(n)}
            onMouseLeave={() => setHovered(null)}
            className={`bv-graph-node-group ${dim ? 'dim' : ''}`}
          >
            <rect
              x={p.x}
              y={p.y}
              width={p.w}
              height={20}
              rx={4}
              className="bv-graph-node"
              style={{ fill: fileTypeColor(n) }}
              opacity={0.2}
            />
            <rect
              x={p.x}
              y={p.y}
              width={p.w}
              height={20}
              rx={4}
              className="bv-graph-node-border"
              style={{ stroke: fileTypeColor(n) }}
            />
            <text x={p.x + 8} y={p.y + 14} className="bv-graph-label">
              {base(n).length > 22 ? base(n).slice(0, 20) + '...' : base(n)}
            </text>
            {p.connections > 0 && (
              <text
                x={p.x + p.w - 8}
                y={p.y + 14}
                className="bv-graph-connections"
                textAnchor="end"
              >
                {p.connections}
              </text>
            )}
            <title>{n}</title>
          </g>
        );
      })}
    </svg>
  );
}

/* ── Endpoint list ────────────────────────────────────────────────── */

function EndpointList({
  endpoints,
  matchedRoutes
}: {
  endpoints: NonNullable<BackendState['endpoints']>;
  matchedRoutes?: Set<number>;
}) {
  const byFile = useMemo(() => {
    const map = new Map<string, typeof endpoints.routes>();
    for (let i = 0; i < endpoints.routes.length; i++) {
      const r = endpoints.routes[i];
      const existing = map.get(r.file) ?? [];
      existing.push({ ...r });
      map.set(r.file, existing);
    }
    return map;
  }, [endpoints.routes]);

  return (
    <div className="bv-endpoints">
      {[...byFile.entries()].map(([file, routes]) => (
        <div key={file} className="bv-endpoint-file">
          <div className="bv-endpoint-file-header">
            <span className="bv-endpoint-file-name">{base(file)}</span>
            <span className="bv-endpoint-file-count">
              {routes.length} route{routes.length !== 1 ? 's' : ''}
            </span>
          </div>
          {routes.map((r, i) => {
            const globalIdx = endpoints.routes.indexOf(r);
            const hit = matchedRoutes?.has(globalIdx);
            return (
              <div key={i} className={`bv-endpoint-row ${hit ? 'bv-endpoint-hit' : ''}`}>
                <span
                  className="bv-method-badge"
                  style={{ backgroundColor: methodColor(r.method) }}
                >
                  {r.method}
                </span>
                <code className="bv-endpoint-path">{r.path}</code>
                <span className="bv-endpoint-line">:{r.line}</span>
                {hit && <span className="bv-endpoint-hit-badge">hit</span>}
              </div>
            );
          })}
        </div>
      ))}
      {endpoints.notes.map((n, i) => (
        <small key={i} className="bv-note">
          {n}
        </small>
      ))}
      <small className="bv-note">
        Statically detected literal routes only; dynamic registration is not visible.
      </small>
    </div>
  );
}

/* ── Diff view ────────────────────────────────────────────────────── */

function DiffView({ diff }: { diff: NonNullable<BackendState['diff']> }) {
  const grouped = useMemo(() => {
    const added = diff.filter((d) => d.kind === 'added');
    const removed = diff.filter((d) => d.kind === 'removed');
    const changed = diff.filter((d) => d.kind === 'status' || d.kind === 'timing');
    return { added, removed, changed };
  }, [diff]);

  return (
    <div className="bv-diff">
      <div className="bv-diff-header">Changes vs previous checkpoint</div>
      {grouped.added.length > 0 && (
        <div className="bv-diff-section">
          <div className="bv-diff-section-label bv-diff-added-label">
            + {grouped.added.length} added
          </div>
          {grouped.added.slice(0, 8).map((d, i) => (
            <div key={i} className="bv-diff-row bv-diff-added">
              <span className="bv-diff-icon">+</span>
              <span className="bv-diff-key">{d.key}</span>
              <span className="bv-diff-val">{d.after}</span>
            </div>
          ))}
        </div>
      )}
      {grouped.removed.length > 0 && (
        <div className="bv-diff-section">
          <div className="bv-diff-section-label bv-diff-removed-label">
            - {grouped.removed.length} removed
          </div>
          {grouped.removed.slice(0, 8).map((d, i) => (
            <div key={i} className="bv-diff-row bv-diff-removed">
              <span className="bv-diff-icon">-</span>
              <span className="bv-diff-key">{d.key}</span>
              <span className="bv-diff-val">{d.before}</span>
            </div>
          ))}
        </div>
      )}
      {grouped.changed.length > 0 && (
        <div className="bv-diff-section">
          <div className="bv-diff-section-label bv-diff-changed-label">
            ~ {grouped.changed.length} changed
          </div>
          {grouped.changed.slice(0, 8).map((d, i) => (
            <div key={i} className="bv-diff-row bv-diff-changed">
              <span className="bv-diff-icon">~</span>
              <span className="bv-diff-key">{d.key}</span>
              <span className="bv-diff-val">
                {d.before} &rarr; {d.after}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Summary header ───────────────────────────────────────────────── */

function SummaryBar({ capture }: { capture: BackendCapture }) {
  const entries = capture.entries;
  const total = entries.length;
  const mutations = entries.filter((e) => e.mutation).length;
  const errors = entries.filter((e) => e.failure || (e.status != null && e.status >= 400)).length;
  const totalMs = entries.reduce((s, e) => s + (e.durationMs ?? 0), 0);
  const thirdParty = entries.filter((e) => !e.sameOrigin).length;

  return (
    <div className="bv-summary">
      <div className="bv-metric">
        <span className="bv-metric-value">{total}</span>
        <span className="bv-metric-label">Requests</span>
      </div>
      <div className="bv-metric">
        <span className="bv-metric-value">{fmtMs(totalMs)}</span>
        <span className="bv-metric-label">Total Time</span>
      </div>
      {mutations > 0 && (
        <div className="bv-metric bv-metric-warn">
          <span className="bv-metric-value">{mutations}</span>
          <span className="bv-metric-label">Mutation{mutations !== 1 ? 's' : ''}</span>
        </div>
      )}
      {errors > 0 && (
        <div className="bv-metric bv-metric-error">
          <span className="bv-metric-value">{errors}</span>
          <span className="bv-metric-label">Error{errors !== 1 ? 's' : ''}</span>
        </div>
      )}
      {thirdParty > 0 && (
        <div className="bv-metric">
          <span className="bv-metric-value">{thirdParty}</span>
          <span className="bv-metric-label">Third-Party</span>
        </div>
      )}
    </div>
  );
}

/* ── Main export ──────────────────────────────────────────────────── */

export function BackendView({ backend }: { backend: BackendState }) {
  if (backend.status === 'loading') return <small>Loading backend view...</small>;
  if (backend.status === 'error')
    return <small className="failure">{backend.message ?? 'Backend view failed.'}</small>;
  const capture = backend.capture;
  const matchedRoutes = useMemo(() => {
    if (!backend.matches || !backend.endpoints) return undefined;
    const set = new Set<number>();
    for (const m of backend.matches) if (m >= 0) set.add(m);
    return set;
  }, [backend.matches, backend.endpoints]);

  return (
    <div className="bv-root">
      {!capture && <small>{backend.message ?? 'No backend capture for this checkpoint.'}</small>}
      {capture && capture.entries.length === 0 && (
        <small>No requests observed during this render.</small>
      )}
      {capture && capture.entries.length > 0 && (
        <>
          <SummaryBar capture={capture} />
          {capture.entries.some((e) => e.mutation) && (
            <p className="bv-mutation-note">
              This render sent write request(s) to the preview server. The panel only observes.
            </p>
          )}
          <Waterfall
            capture={capture}
            matches={backend.matches}
            routes={backend.endpoints?.routes}
          />
          {backend.diff && backend.diff.length > 0 && <DiffView diff={backend.diff} />}
          <small className="bv-note">{capture.coverage.join(' ')}</small>
        </>
      )}
      {backend.endpoints && backend.endpoints.routes.length > 0 && (
        <details className="bv-section">
          <summary className="bv-section-header">
            Routes ({backend.endpoints.routes.length}
            {backend.endpoints.framework === 'express' ? ', Express' : ''})
          </summary>
          <EndpointList endpoints={backend.endpoints} matchedRoutes={matchedRoutes} />
        </details>
      )}
      {backend.graph && backend.graph.nodes.length > 0 && (
        <details className="bv-section">
          <summary className="bv-section-header">
            Module Imports ({backend.graph.nodes.length} files)
          </summary>
          <div className="bv-graph-scroll">
            <Graph graph={backend.graph} />
          </div>
          {backend.graph.truncated && (
            <small className="bv-note">Graph truncated for display.</small>
          )}
          <small className="bv-note">
            Static import structure from checkpoint source; not runtime call or data flow.
          </small>
        </details>
      )}
    </div>
  );
}
