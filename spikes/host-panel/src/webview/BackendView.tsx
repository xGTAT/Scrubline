import React, { useMemo, useState } from 'react';
import type { BackendState, BackendCapture, ModuleGraph } from '../backend/types';

const base = (p: string) => p.split('/').pop() ?? p;

function Waterfall({
  capture,
  matches,
  routes
}: {
  capture: BackendCapture;
  matches?: number[];
  routes?: { method: string; path: string; file: string; line: number }[];
}) {
  const [open, setOpen] = useState<number | null>(null);
  const entries = capture.entries.slice(0, 100);
  const end = Math.max(
    1,
    ...entries.map((e) => (e.startedAt >= 0 ? e.startedAt + (e.durationMs ?? 0) : 0))
  );
  const rowH = 20;
  const labelW = 300;
  const width = 720;
  return (
    <div className="backend-waterfall">
      <svg
        viewBox={`0 0 ${width} ${entries.length * rowH + 4}`}
        role="img"
        aria-label="Backend request waterfall"
      >
        {entries.map((e, i) => {
          const x =
            e.startedAt >= 0 ? labelW + ((width - labelW - 60) * e.startedAt) / end : labelW;
          const w =
            e.durationMs != null && e.startedAt >= 0
              ? Math.max(2, ((width - labelW - 60) * e.durationMs) / end)
              : 2;
          const statusClass = e.failure
            ? 'status-failed'
            : e.status == null
              ? 'status-failed'
              : e.status < 300
                ? 'status-ok'
                : e.status < 400
                  ? 'status-redirect'
                  : 'status-error';
          return (
            <g
              key={i}
              className={`waterfall-row ${open === i ? 'open' : ''}`}
              onClick={() => setOpen(open === i ? null : i)}
            >
              <text x={4} y={i * rowH + 14} className="waterfall-label">
                {e.method} {e.path}
                {e.queryKeys.length > 0 ? ` ?${e.queryKeys.join(',')}` : ''}
              </text>
              <rect
                x={x}
                y={i * rowH + 5}
                width={w}
                height={10}
                rx={2}
                className={`waterfall-bar ${statusClass} ${e.mutation ? 'mutation' : ''}`}
              />
              <text x={width - 56} y={i * rowH + 14} className="waterfall-status">
                {e.failure ?? e.status ?? '—'}
              </text>
            </g>
          );
        })}
      </svg>
      {open != null && entries[open] && (
        <div className="waterfall-detail">
          <p>
            {entries[open].method} {entries[open].host}
            {entries[open].path} · {entries[open].resourceType} ·{' '}
            {entries[open].durationMs != null ? `${entries[open].durationMs}ms` : 'no timing'}
            {!entries[open].sameOrigin && ' · third-party'}
          </p>
          {matches && routes && matches[open] >= 0 && (
            <p>
              Handler (static match): {routes[matches[open]].file}:{routes[matches[open]].line}
            </p>
          )}
          {matches && matches[open] === -1 && <p>No static route match in checkpoint source.</p>}
        </div>
      )}
      {capture.truncated && <small>Capture truncated at the configured request limit.</small>}
    </div>
  );
}

function Graph({ graph }: { graph: ModuleGraph }) {
  const layout = useMemo(() => {
    const nodes = graph.nodes.slice(0, 60);
    const incoming = new Map<string, number>();
    for (const e of graph.edges) incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
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
    const pos = new Map<string, { x: number; y: number }>();
    for (const [d, list] of layers)
      list.forEach((n, i) => pos.set(n, { x: 20 + d * 170, y: 20 + i * 26 }));
    return { nodes, edges, pos, layers: layers.size };
  }, [graph]);
  const height = Math.max(60, ...[...layout.pos.values()].map((p) => p.y + 20));
  return (
    <svg
      viewBox={`0 0 ${Math.max(360, layout.layers * 170)} ${height}`}
      role="img"
      aria-label="Module import graph"
      className="backend-graph"
    >
      {layout.edges.map((e, i) => {
        const a = layout.pos.get(e.from);
        const b = layout.pos.get(e.to);
        if (!a || !b) return null;
        return (
          <line
            key={i}
            x1={a.x + 110}
            y1={a.y + 8}
            x2={b.x}
            y2={b.y + 8}
            className="backend-graph-edge"
          />
        );
      })}
      {layout.nodes.map((n) => {
        const p = layout.pos.get(n)!;
        return (
          <g key={n}>
            <rect x={p.x} y={p.y} width={110} height={16} rx={3} className="backend-graph-node" />
            <text x={p.x + 4} y={p.y + 12} className="backend-graph-label">
              {base(n).slice(0, 18)}
            </text>
            <title>{n}</title>
          </g>
        );
      })}
    </svg>
  );
}

export function BackendView({ backend }: { backend: BackendState }) {
  if (backend.status === 'loading') return <small>Loading backend view…</small>;
  if (backend.status === 'error')
    return <small className="failure">{backend.message ?? 'Backend view failed.'}</small>;
  const capture = backend.capture;
  const mutations = capture?.entries.filter((e) => e.mutation).length ?? 0;
  return (
    <div className="backend-view">
      {!capture && <small>{backend.message ?? 'No backend capture for this checkpoint.'}</small>}
      {capture && capture.entries.length === 0 && (
        <small>No requests observed during this render.</small>
      )}
      {capture && capture.entries.length > 0 && (
        <>
          {mutations > 0 && (
            <p className="backend-mutation">
              This render sent {mutations} write request{mutations === 1 ? '' : 's'} (not GET) to
              the preview server. Renders execute the page; the panel only observes.
            </p>
          )}
          <Waterfall
            capture={capture}
            matches={backend.matches}
            routes={backend.endpoints?.routes}
          />
          {backend.diff && backend.diff.length > 0 && (
            <div className="backend-diff">
              <small>vs previous checkpoint:</small>
              <ul>
                {backend.diff.slice(0, 12).map((d, i) => (
                  <li key={i}>
                    {d.kind === 'added' && `+ ${d.key} (${d.after})`}
                    {d.kind === 'removed' && `- ${d.key} (was ${d.before})`}
                    {d.kind === 'status' && `${d.key}: ${d.before} -> ${d.after}`}
                    {d.kind === 'timing' && `${d.key}: ${d.before} -> ${d.after}`}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <small className="backend-coverage">{capture.coverage.join(' ')}</small>
        </>
      )}
      {backend.endpoints && backend.endpoints.routes.length > 0 && (
        <details className="backend-endpoints">
          <summary>
            Backend routes ({backend.endpoints.routes.length}
            {backend.endpoints.framework === 'express' ? ', Express' : ''})
          </summary>
          <ul>
            {backend.endpoints.routes.slice(0, 50).map((r, i) => (
              <li key={i}>
                <code>{r.method}</code> {r.path}{' '}
                <small>
                  {r.file}:{r.line}
                </small>
              </li>
            ))}
          </ul>
          {backend.endpoints.routes.length > 50 && (
            <small>Showing 50 of {backend.endpoints.routes.length}.</small>
          )}
          {backend.endpoints.notes.map((n, i) => (
            <small key={i} className="backend-note">
              {n}
            </small>
          ))}
          <small className="backend-coverage">
            Statically detected literal routes only; dynamic registration is not visible.
          </small>
        </details>
      )}
      {backend.graph && backend.graph.nodes.length > 0 && (
        <details className="backend-modules">
          <summary>Module imports ({backend.graph.nodes.length} files)</summary>
          <Graph graph={backend.graph} />
          {backend.graph.truncated && <small>Graph truncated for display.</small>}
          <small className="backend-coverage">
            Static import structure from checkpoint source; not runtime call or data flow.
          </small>
        </details>
      )}
    </div>
  );
}
