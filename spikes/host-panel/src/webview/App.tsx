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
  const [packetReviewed, setPacketReviewed] = useState(false);
  useEffect(() => setPacketReviewed(false), [state.targeting?.packet]);
  const [selected, setSelected] = useState<string | undefined>(bridge?.getState()?.selected);
  useEffect(() => {
    const handler = (event: MessageEvent<TimelineOutbound>) => {
      if (event.data.type === 'timeline') setState(event.data.data);
    };
    window.addEventListener('message', handler);
    bridge?.postMessage({ type: 'request-timeline' });
    return () => window.removeEventListener('message', handler);
  }, []);
  const choose = (id: string) => {
    setSelected(id);
    const index = state.rows.findIndex((r) => r.id === id);
    setPage(Math.max(0, state.rows.length - 1 - index));
    bridge?.setState({ selected: id });
    bridge?.postMessage({ type: 'select-checkpoint', id });
  };
  const row = state.rows.find((r) => r.id === selected);
  const [page, setPage] = useState(0);
  const visible = state.rows
    .slice()
    .reverse()
    .slice(page * 1, page * 1 + 1);
  return (
    <main className="panel">
      <header className="header">
        <strong>Scrubline</strong>
        <span className="badge">M3</span>
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
      {state.rows.length > 0 && (
        <section className="scrub" aria-label="Read-only scrub">
          <label htmlFor="scrub">Checkpoint</label>
          <input
            id="scrub"
            type="range"
            min={0}
            max={Math.max(0, state.rows.length - 1)}
            value={Math.max(
              0,
              state.rows.findIndex((r) => r.id === selected)
            )}
            aria-valuetext={`Checkpoint ${
              Math.max(
                0,
                state.rows.findIndex((r) => r.id === selected)
              ) + 1
            } of ${state.rows.length}, ${row ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(row.createdAt)) : ''}`}
            onChange={(e) => choose(state.rows[Number(e.target.value)].id)}
          />
          <nav>
            <button
              disabled={!selected || state.rows.findIndex((r) => r.id === selected) <= 0}
              onClick={() =>
                choose(state.rows[state.rows.findIndex((r) => r.id === selected) - 1].id)
              }
            >
              Prev
            </button>
            <button
              disabled={state.rows.findIndex((r) => r.id === selected) >= state.rows.length - 1}
              onClick={() =>
                choose(
                  state.rows[
                    Math.max(
                      0,
                      state.rows.findIndex((r) => r.id === selected)
                    ) + 1
                  ].id
                )
              }
            >
              Next
            </button>
          </nav>
        </section>
      )}
      <section className="preview" aria-live="polite">
        {state.preview?.status === 'loading' ? (
          <span>Rendering…</span>
        ) : state.preview?.status === 'error' ? (
          <>
            <span title={state.preview.message}>Preview unavailable</span>
            <button
              onClick={() =>
                selected && bridge?.postMessage({ type: 'select-checkpoint', id: selected })
              }
            >
              Retry preview
            </button>
          </>
        ) : state.preview?.status === 'ready' ? (
          <>
            <span>{state.preview.label}</span>
            {state.preview.message && (
              <span className="preview-message">{state.preview.message}</span>
            )}
            {state.preview.image && <img src={state.preview.image} alt="Checkpoint screenshot" />}
            {state.preview.url && (
              <button onClick={() => bridge?.postMessage({ type: 'open-preview' })}>
                Open preview
              </button>
            )}
          </>
        ) : state.rows.length > 0 ? (
          <button onClick={() => bridge?.postMessage({ type: 'start-preview' })}>
            Start preview
          </button>
        ) : null}
      </section>
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
                    bridge?.postMessage({ type: 'select-checkpoint', id: r.id });
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
          {state.rows.length > 1 && (
            <nav aria-label="Timeline pages">
              <button disabled={page === 0} onClick={() => setPage(page - 1)}>
                Newer
              </button>
              <button
                disabled={(page + 1) * 1 >= state.rows.length}
                onClick={() => setPage(page + 1)}
              >
                Older
              </button>
            </nav>
          )}
        </>
      )}
      {row && (
        <section aria-label="Review">
          <button
            disabled={state.unsaved}
            onClick={() => bridge?.postMessage({ type: 'review-checkpoint', id: row.id })}
          >
            Review restore
          </button>
          <details>
            <summary>Changed paths ({row.changedPaths.length})</summary>
            <ul className="paths">
              {row.changedPaths.map((p) => (
                <li key={p}>
                  <button
                    title={p}
                    onClick={() => bridge?.postMessage({ type: 'open-diff', id: row.id, path: p })}
                  >
                    {p}
                  </button>
                </li>
              ))}
            </ul>
          </details>
        </section>
      )}
      {state.review && (
        <section role="region" aria-label="Restore confirmation">
          {state.review.conflicts.length > 0 ? (
            <>
              <span>Workspace drift. Restore blocked.</span>
              <details>
                <summary>Three-way conflicts</summary>
                <ul className="paths">
                  {state.review.conflicts.map((p) => (
                    <li key={p}>
                      <button
                        title={p}
                        onClick={() =>
                          bridge?.postMessage({
                            type: 'open-diff',
                            id: state.review!.checkpoint,
                            path: p
                          })
                        }
                      >
                        {p}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            </>
          ) : (
            <>
              <span>
                Restore {state.review.paths.length} file{state.review.paths.length === 1 ? '' : 's'}
                ?
              </span>
              <details>
                <summary>Confirmed files</summary>
                <ul className="paths">
                  {state.review.paths.map((p) => (
                    <li key={p} title={p}>
                      {p}
                    </li>
                  ))}
                </ul>
              </details>
              <button
                disabled={state.unsaved || state.review.paths.length === 0}
                onClick={() =>
                  bridge?.postMessage({
                    type: 'apply-reviewed',
                    id: state.review!.checkpoint,
                    token: state.review!.token
                  })
                }
              >
                Confirm restore
              </button>
            </>
          )}
        </section>
      )}
      {state.preview?.status === 'ready' &&
        state.preview.url &&
        state.preview.checkpoint &&
        (!state.targeting || state.targeting.status === 'off') && (
          <button onClick={() => bridge?.postMessage({ type: 'start-targeting' })}>
            Select element
          </button>
        )}
      {state.targeting && state.targeting.status !== 'off' && (
        <section aria-label="Target context">
          <span>
            {state.targeting.status === 'on'
              ? 'Targeting on'
              : state.targeting.status === 'stale'
                ? 'Target changed'
                : state.targeting.status === 'error'
                  ? 'Targeting unavailable'
                  : 'Element selected'}
          </span>
          {state.targeting.status === 'ready' && state.targeting.crop && (
            <img className="target-crop" src={state.targeting.crop} alt="Sanitized element crop" />
          )}
          {state.targeting.packet && (
            <details
              onToggle={(e) => {
                if (e.currentTarget.open) setPacketReviewed(true);
              }}
            >
              <summary>Review packet</summary>
              <pre>{state.targeting.packet}</pre>
            </details>
          )}
          {state.targeting.status === 'ready' && (
            <button onClick={() => bridge?.postMessage({ type: 'validate-target' })}>
              Check target
            </button>
          )}
          {state.targeting.message && <small>{state.targeting.message}</small>}
          {state.targeting.status === 'ready' && (
            <button
              disabled={!packetReviewed}
              onClick={() => bridge?.postMessage({ type: 'copy-packet' })}
            >
              Copy packet
            </button>
          )}
          <button onClick={() => bridge?.postMessage({ type: 'stop-targeting' })}>
            Stop targeting
          </button>
        </section>
      )}
      {state.canUndo && (
        <button onClick={() => bridge?.postMessage({ type: 'undo-restore' })}>Undo restore</button>
      )}
      <footer className="footer">
        {window.__SCRUBLINE_HOST_INFO__?.appName ?? 'Detecting host…'}
      </footer>
    </main>
  );
};
