import React, { useEffect, useState } from 'react';
import { ClockCounterClockwise } from '@phosphor-icons/react';
import type { HostInfo } from '../host-info';
import type { TimelineState, TimelineOutbound, TimelineInbound } from '../bridge/timeline';
declare global {
  interface Window {
    __SCRUBLINE_HOST_INFO__?: HostInfo;
    acquireVsCodeApi?: () => {
      postMessage: (m: TimelineInbound) => void;
      getState: () => { selected?: string } | undefined;
      setState: (s: { selected?: string }) => void;
    };
  }
}
const bridge = window.acquireVsCodeApi?.();
export const App: React.FC = () => {
  const [state, setState] = useState<TimelineState>({
    status: 'loading',
    rows: [],
    unsaved: false
  });
  const [selected, setSelected] = useState<string | undefined>(bridge?.getState()?.selected);
  useEffect(() => {
    const handler = (event: MessageEvent<TimelineOutbound>) => {
      if (event.data.type === 'timeline') setState(event.data.data);
    };
    window.addEventListener('message', handler);
    bridge?.postMessage({ type: 'request-timeline' });
    return () => window.removeEventListener('message', handler);
  }, []);
  const row = state.rows.find((r) => r.id === selected);
  const [page, setPage] = useState(0);
  const visible = state.rows
    .slice()
    .reverse()
    .slice(page * 3, page * 3 + 3);
  return (
    <main className="panel">
      <header className="header">
        <strong>Scrubline</strong>
        <span className="badge">M1</span>
      </header>
      <section className="status" aria-live="polite">
        <span>
          {state.status === 'loading'
            ? 'Capturing…'
            : state.status === 'empty'
              ? 'No checkpoints yet'
              : state.status === 'error'
                ? 'Capture failed'
                : state.status === 'limit'
                  ? 'Limit reached'
                  : `${state.rows.length} checkpoint${state.rows.length === 1 ? '' : 's'}`}
        </span>
        {state.unsaved && <span>Unsaved changes not captured</span>}
      </section>
      {(state.status === 'empty' || state.status === 'loading') && (
        <section className="empty">
          <ClockCounterClockwise size={28} strokeWidth={1.5} aria-hidden="true" />
          <p>{state.message ?? 'Watching this folder'}</p>
          <button onClick={() => bridge?.postMessage({ type: 'retry-capture' })}>
            Capture now
          </button>
        </section>
      )}
      {(state.status === 'error' || state.status === 'limit') && (
        <section role="alert">
          <p className="failure" title={state.message}>
            {state.message}
          </p>
          <button onClick={() => bridge?.postMessage({ type: 'retry-capture' })}>Retry</button>
        </section>
      )}
      {visible.length > 0 && (
        <>
          <ol className="timeline" aria-label="Checkpoints">
            {visible.map((r) => (
              <li key={r.id}>
                <button
                  className="row"
                  aria-pressed={selected === r.id}
                  onClick={() => {
                    setSelected(r.id);
                    bridge?.setState({ selected: r.id });
                  }}
                >
                  <time>
                    {new Intl.DateTimeFormat(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit'
                    }).format(new Date(r.createdAt))}
                  </time>
                  <span>{r.changedPaths.length} files changed</span>
                  <small>{r.attribution.kind === 'hook' ? 'Hook matched' : 'Unattributed'}</small>
                </button>
              </li>
            ))}
          </ol>
          {state.rows.length > 3 && (
            <nav aria-label="Timeline pages">
              <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                Newer
              </button>
              <button
                disabled={(page + 1) * 3 >= state.rows.length}
                onClick={() => setPage(page + 1)}
              >
                Older
              </button>
            </nav>
          )}
        </>
      )}
      {row && (
        <section aria-label="Changed paths">
          <h2>Changed paths</h2>
          <ul className="paths">
            {row.changedPaths.map((p) => (
              <li key={p} tabIndex={0} title={p}>
                {p}
              </li>
            ))}
          </ul>
        </section>
      )}
      <footer className="footer">
        {window.__SCRUBLINE_HOST_INFO__?.appName ?? 'Detecting host…'}
      </footer>
    </main>
  );
};
