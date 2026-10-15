import { InvestigationView } from './InvestigationView';
import { BreakpointMap } from './BreakpointMap';
import React, { useEffect, useState, useRef } from 'react';
import {
  ClockCounterClockwise,
  ArrowLeft,
  ArrowRight,
  Play,
  GitBranch,
  ShieldCheck
} from '@phosphor-icons/react';
import { FrameView } from './Frame';
import type { HostInfo } from '../host-info';
import type { TimelineState, TimelineOutbound, TimelineInbound } from '../bridge/timeline';
declare global {
  interface Window {
    __SCRUBLINE_HOST_INFO__?: HostInfo;
    __SCRUBLINE_FULLSCREEN__?: boolean;
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
  const [fullscreen, setFullscreen] = useState(window.__SCRUBLINE_FULLSCREEN__ ?? false);
  const [frame, setFrame] = useState<
    import('./Frame').Frame & {
      label?: string;
      receipt?: import('../evidence/types').RenderReceipt;
    }
  >();
  useEffect(() => {
    const p = state.preview;
    if (p?.status === 'ready' && p.image && p.checkpoint && p.checkpoint === selected)
      setFrame({
        checkpoint: p.checkpoint,
        image: p.image,
        regions: p.regions,
        comparison: p.comparison,
        label: p.label,
        receipt: p.receipt
      });
  }, [state.preview, selected]);
  const [scrubbing, setScrubbing] = useState(false);
  const [sliderPosition, setSliderPosition] = useState<number>();
  const pendingSeek = useRef<string>();
  const seekTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(seekTimer.current), []);
  const toggleFullscreen = () => {
    if (!fullscreen && !frame && state.rows.length) {
      const id = selected ?? state.rows.at(-1)!.id;
      setSelected(id);
      bridge?.postMessage({ type: 'select-checkpoint', id });
    }
    if (!bridge || window.__SCRUBLINE_HOST_INFO__?.appHost === 'harness')
      setFullscreen((old) => !old);
    bridge?.postMessage({ type: 'fullscreen', active: !fullscreen });
  };
  useEffect(() => {
    const escape = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && fullscreen) toggleFullscreen();
    };
    document.addEventListener('keydown', escape);
    return () => document.removeEventListener('keydown', escape);
  }, [fullscreen]);
  const choose = (id: string, playback = false) => {
    if (!playback) setPlaying(false);
    setSelected(id);
    bridge?.setState({ selected: id });
    pendingSeek.current = id;
    if (!seekTimer.current) {
      seekTimer.current = setTimeout(() => {
        seekTimer.current = undefined;
        const next = pendingSeek.current;
        pendingSeek.current = undefined;
        if (next) bridge?.postMessage({ type: 'select-checkpoint', id: next });
      }, 32);
    }
  };
  useEffect(() => {
    if (!selected && state.selected) setSelected(state.selected);
  }, [state.selected]);
  const reviewArea = useRef<HTMLElement>(null);
  useEffect(() => {
    if (state.review) reviewArea.current?.scrollIntoView({ block: 'nearest' });
  }, [state.review?.token]);
  const openReview = (id: string) => {
    clearTimeout(seekTimer.current);
    seekTimer.current = undefined;
    pendingSeek.current = undefined;
    setPlaying(false);
    setSelected(id);
    bridge?.setState({ selected: id });
    bridge?.postMessage({ type: 'review-checkpoint', id });
    reviewArea.current?.scrollIntoView({ block: 'start' });
  };
  const row = state.rows.find((r) => r.id === selected);
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    for (const src of [state.preview?.preload, state.preview?.preloadPrevious]) {
      if (src) {
        const image = new Image();
        image.src = src;
        void image.decode().catch(() => {});
      }
    }
  }, [state.preview?.preload, state.preview?.preloadPrevious]);
  const [playMessage, setPlayMessage] = useState('');
  useEffect(() => {
    if (!playing) return;
    const timer = setInterval(() => {
      const index = state.rows.findIndex((r) => r.id === selected);
      const next = state.rows[index + 1];
      if (!next) {
        setPlaying(false);
        return;
      }
      if (!state.rendered?.includes(next.id)) {
        setPlaying(false);
        setPlayMessage('Next frame not rendered.');
        return;
      }
      choose(next.id, true);
    }, 750);
    return () => clearInterval(timer);
  }, [playing, selected, state.rows, state.rendered]);
  useEffect(() => {
    const stop = () => {
      if (document.hidden) setPlaying(false);
    };
    document.addEventListener('visibilitychange', stop);
    return () => document.removeEventListener('visibilitychange', stop);
  }, []);
  const visible = row ? [row] : state.rows.slice(-1);
  return (
    <main className={`panel ${fullscreen ? 'fullscreen' : ''}`}>
      <header className="header">
        <strong>
          <ClockCounterClockwise size={18} strokeWidth={1.5} aria-hidden="true" />
          Scrubline
        </strong>
        {fullscreen ? (
          <button onClick={toggleFullscreen}>Exit fullscreen</button>
        ) : (
          <span aria-label="Storage location">Local</span>
        )}
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
        <details className="render-controls" name="scrubline-tools">
          <summary>
            Render history ({state.rows.filter((r) => state.rendered?.includes(r.id)).length}/
            {state.rows.length})
          </summary>
          <p>Local screenshots. No sharing.</p>
          <InvestigationView
            rows={state.rows}
            value={state.investigation}
            send={(message) => bridge?.postMessage(message)}
          />
          <BreakpointMap
            rows={state.rows}
            matrix={state.layout}
            send={(message) => bridge?.postMessage(message)}
            choose={openReview}
          />
          {state.rendering?.running ? (
            <>
              <span aria-live="polite">
                {state.rendering.done}/{state.rendering.total} · {state.rendering.failed} failed
              </span>
              <button onClick={() => bridge?.postMessage({ type: 'cancel-render' })}>
                Cancel render
              </button>
            </>
          ) : (
            <>
              <button onClick={() => bridge?.postMessage({ type: 'render-history' })}>
                Render history
              </button>
              <button onClick={() => bridge?.postMessage({ type: 'refresh-renders' })}>
                Clear render cache
              </button>
            </>
          )}
          {state.rendering?.message && <p className="failure">{state.rendering.message}</p>}
        </details>
      )}
      {row?.alternative && (
        <section className="alternative-selection" aria-label="Alternative selection">
          <span>Alternative: {row.alternative}</span>
          <button
            onClick={() => {
              setPlaying(false);
              choose(state.rows.filter((r) => !r.alternative).at(-1)!.id);
            }}
          >
            Back to timeline
          </button>
        </section>
      )}
      {state.rows.length > 0 && !row?.alternative && (
        <section className="scrub" aria-label="Read-only scrub">
          <label htmlFor="scrub">Checkpoint</label>
          <input
            id="scrub"
            type="range"
            disabled={state.rows.length < 2}
            min={0}
            max={Math.max(0, state.rows.length - 1)}
            step="any"
            value={
              sliderPosition ??
              Math.max(
                0,
                state.rows.findIndex((r) => r.id === selected)
              )
            }
            onPointerDown={() => {
              setScrubbing(true);
            }}
            onPointerUp={() => {
              setScrubbing(false);
              setSliderPosition(undefined);
            }}
            onPointerCancel={() => {
              setScrubbing(false);
              setSliderPosition(undefined);
            }}
            onBlur={() => {
              setScrubbing(false);
              setSliderPosition(undefined);
            }}
            aria-valuetext={`Checkpoint ${
              Math.max(
                0,
                state.rows.findIndex((r) => r.id === selected)
              ) + 1
            } of ${state.rows.length}, ${row ? new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(new Date(row.createdAt)) : ''}`}
            onChange={(e) => {
              setPlaying(false);
              const position = Number(e.target.value);
              setSliderPosition(scrubbing ? position : undefined);
              choose(state.rows[Math.round(position)].id);
            }}
          />
          <nav>
            <button
              disabled={!selected || state.rows.findIndex((r) => r.id === selected) <= 0}
              onClick={() =>
                choose(state.rows[state.rows.findIndex((r) => r.id === selected) - 1].id)
              }
            >
              <ArrowLeft size={14} strokeWidth={1.5} aria-hidden="true" />
              Prev
            </button>
            <button
              disabled={
                Math.max(
                  0,
                  state.rows.findIndex((r) => r.id === selected)
                ) >=
                state.rows.length - 1
              }
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
              <ArrowRight size={14} strokeWidth={1.5} aria-hidden="true" />
            </button>
            <button
              disabled={
                state.rows.length < 2 || !state.rendered?.length || state.rendering?.running
              }
              onClick={() => {
                setPlayMessage('');
                if (!playing) {
                  const index = state.rows.findIndex((r) => r.id === selected);
                  if (index < 0 || index === state.rows.length - 1) {
                    const first = state.rows[0];
                    if (!state.rendered?.includes(first.id)) {
                      setPlayMessage('First frame not rendered.');
                      return;
                    }
                    choose(first.id);
                  }
                }
                setPlaying(!playing);
              }}
            >
              {playing ? 'Pause' : 'Play'}
            </button>
          </nav>
          <small role="status">
            {state.rows.length < 2
              ? 'Save changes for another checkpoint.'
              : state.rendering?.running
                ? 'Rendering history before playback.'
                : !state.rendered?.length
                  ? 'Render history first.'
                  : playMessage}
          </small>
        </section>
      )}
      <section className="preview" aria-live="polite">
        {frame && <FrameView frame={frame} requested={selected ?? frame.checkpoint} />}
        {state.rows.length > 0 && !state.review && !fullscreen && (
          <button className="fullscreen-button" onClick={toggleFullscreen}>
            {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          </button>
        )}
        {frame ||
        (state.preview?.status === 'ready' &&
          (!selected || state.preview.checkpoint === selected)) ? (
          <>
            <span>{frame?.label ?? state.preview?.label}</span>
            {(frame?.receipt ?? state.preview?.receipt) && (
              <details className="render-receipt">
                <summary>Render receipt</summary>
                <p>
                  {(frame?.receipt ?? state.preview?.receipt)!.viewport.width} x{' '}
                  {(frame?.receipt ?? state.preview?.receipt)!.viewport.height} · Chromium{' '}
                  {(frame?.receipt ?? state.preview?.receipt)!.browserVersion}
                </p>
                <p>
                  Captured {(frame?.receipt ?? state.preview?.receipt)!.capturedAt}. Tracked source
                  only; dependencies and backend state are not frozen.
                </p>
                <p>
                  Repeatability:{' '}
                  {(frame?.receipt ?? state.preview?.receipt)!.repeatability ?? 'not-rechecked'}.
                </p>
                <button
                  disabled={state.preview?.status === 'loading'}
                  title="Runs the trusted preview command twice in isolated source copies. Does not freeze server-side effects."
                  onClick={() => bridge?.postMessage({ type: 'recheck-render', id: selected! })}
                >
                  Recheck twice
                </button>
              </details>
            )}
            {row && (
              <small>
                Selected{' '}
                {new Intl.DateTimeFormat(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                  second: '2-digit'
                }).format(new Date(row.createdAt))}
              </small>
            )}
            {state.preview?.status === 'ready' && state.preview.message && (
              <span className="preview-message">{state.preview.message}</span>
            )}
            {(frame || state.preview?.checkpoint) && (
              <button onClick={toggleFullscreen}>Open preview</button>
            )}
            {state.preview?.status === 'error' && (
              <div role="alert">
                <small className="failure">{state.preview.message}</small>
                <button
                  onClick={() =>
                    selected && bridge?.postMessage({ type: 'select-checkpoint', id: selected })
                  }
                >
                  Retry preview
                </button>
              </div>
            )}
          </>
        ) : state.preview?.status === 'loading' ? (
          <span>Rendering…</span>
        ) : state.preview?.status === 'error' ? (
          <>
            <span>Preview unavailable</span>
            <small className="failure">{state.preview.message}</small>
            <button
              onClick={() =>
                selected && bridge?.postMessage({ type: 'select-checkpoint', id: selected })
              }
            >
              Retry preview
            </button>
          </>
        ) : state.rows.length > 0 ? (
          <button onClick={() => bridge?.postMessage({ type: 'start-preview' })}>
            <Play size={14} strokeWidth={1.5} aria-hidden="true" />
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
                    setPlaying(false);
                    choose(r.id);
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
              <button
                disabled={state.rows.findIndex((r) => r.id === selected) >= state.rows.length - 1}
                onClick={() => {
                  setPlaying(false);
                  choose(
                    state.rows[
                      Math.min(
                        state.rows.length - 1,
                        Math.max(
                          0,
                          state.rows.findIndex((r) => r.id === selected)
                        ) + 1
                      )
                    ].id
                  );
                }}
              >
                Newer
              </button>
              <button
                disabled={state.rows.findIndex((r) => r.id === selected) <= 0}
                onClick={() => {
                  setPlaying(false);
                  choose(
                    state.rows[Math.max(0, state.rows.findIndex((r) => r.id === selected) - 1)].id
                  );
                }}
              >
                Older
              </button>
            </nav>
          )}
        </>
      )}
      {row && (
        <section aria-label="Review" ref={reviewArea}>
          <button disabled={state.unsaved} onClick={() => openReview(row.id)}>
            <ShieldCheck size={14} strokeWidth={1.5} aria-hidden="true" />
            Review restore
          </button>
          <details>
            <summary>Changed paths ({row.changedPaths.length})</summary>
            <button onClick={() => bridge?.postMessage({ type: 'pick-element', id: row.id })}>
              Pick on page
            </button>{' '}
            <button
              disabled={state.unsaved}
              onClick={() =>
                bridge?.postMessage({
                  type: 'review-element',
                  id: row.id,
                  document: '',
                  element: ''
                })
              }
            >
              Hidden element ID
            </button>
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
        <section role="region" aria-label="Restore confirmation" className="restore-confirmation">
          {state.review.note && <p className="element-review-note">{state.review.note}</p>}
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
              {state.rollback && (
                <section aria-label="Rollback review">
                  <p role="status">{state.rollback.message}</p>
                  {state.rollback.changes?.map((u) => (
                    <p key={u.path + u.key}>
                      <code>
                        {u.path}: {u.selector} / {u.property}
                      </code>{' '}
                      {u.after} → {u.before}
                    </p>
                  ))}
                </section>
              )}
              <span>
                {state.review.paths.length ? (
                  <>
                    Restore {state.review.paths.length} file
                    {state.review.paths.length === 1 ? '' : 's'}?
                  </>
                ) : (
                  'No content or exclusive CSS changes to restore.'
                )}
              </span>
              <details>
                <summary>Files</summary>
                <ul className="paths">
                  {state.review.paths.map((p) => (
                    <li key={p} title={p}>
                      {p}
                      <button
                        onClick={() =>
                          bridge?.postMessage({
                            type: 'open-diff',
                            id: state.review!.checkpoint,
                            path: p
                          })
                        }
                      >
                        Review exact diff
                      </button>
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
      {row && (
        <button onClick={() => bridge?.postMessage({ type: 'fork-checkpoint', id: row.id })}>
          <GitBranch size={14} strokeWidth={1.5} aria-hidden="true" />
          Fork checkpoint
        </button>
      )}
      {!!state.branches?.length && (
        <details className="alternatives-menu" name="scrubline-tools">
          <summary>Alternatives ({state.branches.length})</summary>
          <ul className="paths">
            {state.branches.map((b) => (
              <li key={b.id}>
                <strong title={b.directory}>
                  {b.name} · {b.id.slice(0, 8)}
                </strong>
                <small>
                  Base {b.base.slice(0, 8)} · Saved {b.checkpoint.slice(0, 8)}
                </small>
                <button
                  onClick={() => bridge?.postMessage({ type: 'pick-element', id: b.checkpoint })}
                >
                  Pick on page
                </button>
                <button
                  onClick={() =>
                    bridge?.postMessage({
                      type: 'review-element',
                      id: b.checkpoint,
                      document: '',
                      element: ''
                    })
                  }
                >
                  Hidden element ID
                </button>
                <button
                  title="Prototype: standalone static HTML navbar only. Framework components and shared CSS are not supported."
                  onClick={() =>
                    bridge?.postMessage({ type: 'review-navbar', id: b.checkpoint, document: '' })
                  }
                >
                  Static navbar
                </button>
                <button
                  onClick={() => bridge?.postMessage({ type: 'capture-branch', branch: b.id })}
                >
                  Capture
                </button>
                <button
                  onClick={() => bridge?.postMessage({ type: 'compare-branch', branch: b.id })}
                >
                  Compare
                </button>
                <button
                  onClick={() => {
                    setPlaying(false);
                    setSelected(b.checkpoint);
                    bridge?.postMessage({ type: 'select-checkpoint', id: b.checkpoint });
                  }}
                >
                  Inspect
                </button>
                <button
                  onClick={() =>
                    bridge?.postMessage({ type: 'review-selective', id: b.checkpoint, paths: [] })
                  }
                >
                  Choose files
                </button>
              </li>
            ))}
          </ul>
        </details>
      )}
      {state.comparison && (
        <details open>
          <summary>Rendered comparison</summary>
          <div className="comparison">
            <figure>
              <figcaption>Workspace</figcaption>
              {state.comparison.left && <img src={state.comparison.left} alt="Workspace render" />}
            </figure>
            <figure>
              <figcaption>Alternative</figcaption>
              {state.comparison.right && (
                <img src={state.comparison.right} alt="Alternative render" />
              )}
            </figure>
          </div>
          {state.comparison.message && <small>{state.comparison.message}</small>}
        </details>
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
      {state.measuredPacket && (
        <details className="measured-packet">
          <summary>Review measured repair packet</summary>
          <p>
            {state.measuredPacket.bytes} UTF-8 bytes · token estimate at most{' '}
            {state.measuredPacket.tokenUpperEstimate} (not tokenizer measured)
          </p>
          <pre>{state.measuredPacket.body}</pre>
          <button
            disabled={state.unsaved}
            onClick={() =>
              bridge?.postMessage({
                type: 'copy-measured-packet',
                identity: state.measuredPacket!.identity
              })
            }
          >
            Copy reviewed measured packet
          </button>
        </details>
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
