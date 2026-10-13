import React, { useState } from 'react';
import type { TimelineRow, TimelineInbound } from '../bridge/timeline';
import type { LayoutMatrix, LayoutCell } from '../layout/types';
export function BreakpointMap({
  rows,
  matrix,
  send,
  choose
}: {
  rows: TimelineRow[];
  matrix?: LayoutMatrix;
  send: (message: TimelineInbound) => void;
  choose: (id: string) => void;
}) {
  const [widths, setWidths] = useState('390, 768, 960');
  const [count, setCount] = useState(2);
  const [kind, setKind] = useState<'horizontal-overflow' | 'containment'>('horizontal-overflow');
  const [selector, setSelector] = useState('');
  const [container, setContainer] = useState('');
  const [tolerance, setTolerance] = useState(1);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<LayoutCell>();
  const main = rows.filter((r) => !r.alternative);
  const start = () => {
    const parsed = widths.split(',').map((v) => Number(v.trim()));
    if (
      !parsed.length ||
      parsed.length > 8 ||
      parsed.some((w) => !Number.isInteger(w) || w < 240 || w > 3840) ||
      new Set(parsed).size !== parsed.length ||
      parsed.length * Math.min(count, main.length) > 24
    ) {
      setError('Use distinct widths from 240 to 3840, up to 24 probes.');
      return;
    }
    if (kind === 'containment' && (!selector.trim() || !container.trim())) {
      setError('Enter unique target and ancestor selectors.');
      return;
    }
    setError('');
    setSelected(undefined);
    send({
      type: 'layout-sweep',
      widths: parsed,
      checkpoints: main.slice(-count).map((r) => r.id),
      guard: { kind, tolerance, ...(kind === 'containment' ? { selector, container } : {}) }
    });
  };
  return (
    <details className="breakpoint-map">
      <summary>Breakpoint history</summary>
      <p>
        Run the trusted preview command at explicit widths. Intentional overflow may be valid;
        approve an assertion first. Backend state is not frozen.
      </p>
      <label>
        Widths (CSS px)
        <input value={widths} onChange={(e) => setWidths(e.target.value)} />
      </label>
      <label>
        Latest checkpoints
        <input
          type="number"
          min="1"
          max="5"
          value={count}
          onChange={(e) => setCount(Math.max(1, Math.min(5, Number(e.target.value) || 1)))}
        />
      </label>
      <label>
        Assertion
        <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
          <option value="horizontal-overflow">No page horizontal overflow</option>
          <option value="containment">Element stays inside ancestor</option>
        </select>
      </label>
      {kind === 'containment' && (
        <>
          <label>
            Element selector
            <input value={selector} onChange={(e) => setSelector(e.target.value)} />
          </label>
          <label>
            Ancestor selector
            <input value={container} onChange={(e) => setContainer(e.target.value)} />
          </label>
        </>
      )}
      <label>
        Tolerance (px)
        <input
          type="number"
          min="0"
          max="100"
          value={tolerance}
          onChange={(e) => setTolerance(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
        />
      </label>
      <button disabled={matrix?.running || !main.length} onClick={start}>
        Run approved assertion
      </button>
      {matrix?.running && (
        <button onClick={() => send({ type: 'cancel-layout' })}>Cancel map</button>
      )}
      <p role="status">
        {error ||
          (matrix
            ? `${matrix.done}/${matrix.total} probes${matrix.cancelled ? ' · cancelled' : ''}. ${matrix.message ?? ''}`
            : 'Unsampled widths are unknown.')}
      </p>
      {matrix && (
        <div className="map-scroll">
          <table>
            <caption>Checkpoint / sampled viewport width</caption>
            <thead>
              <tr>
                <th>Checkpoint</th>
                {matrix.widths.map((w) => (
                  <th key={w}>{w}px</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.checkpoints.map((id) => (
                <tr key={id}>
                  <th>
                    {main.find((r) => r.id === id)?.createdAt.slice(11, 19) ?? id.slice(0, 8)}
                  </th>
                  {matrix.widths.map((width) => {
                    const cell = matrix.cells.find((c) => c.checkpoint === id && c.width === width);
                    return (
                      <td key={width}>
                        <button
                          className={`map-cell map-${cell?.result.outcome ?? 'unknown'}`}
                          disabled={!cell}
                          onClick={() => setSelected(cell)}
                          aria-label={`${id.slice(0, 8)} at ${width}: ${cell?.result.outcome ?? 'unsampled'}`}
                        >
                          {cell?.result.outcome ?? 'unknown'}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {selected && (
        <section aria-label="Selected map evidence">
          <p>
            {selected.width}px: {selected.result.message}
          </p>
          {selected.image && (
            <img
              src={selected.image}
              alt="Selected historical viewport evidence"
              style={{ maxWidth: '100%', maxHeight: 400, objectFit: 'contain' }}
            />
          )}
          <button onClick={() => choose(selected.checkpoint)}>Open checkpoint for review</button>
          {(() => {
            const position = matrix?.checkpoints.indexOf(selected.checkpoint) ?? -1;
            const previousGood = matrix?.checkpoints
              .slice(0, position)
              .reverse()
              .find((id) =>
                matrix.cells.some(
                  (c) =>
                    c.checkpoint === id && c.width === selected.width && c.result.outcome === 'pass'
                )
              );
            return previousGood ? (
              <button onClick={() => choose(previousGood)}>Open previous passing checkpoint</button>
            ) : (
              <p>No earlier passing sample in this map.</p>
            );
          })()}
          <p>
            Source review uses the configured timeline viewport. This map image is evidence at{' '}
            {selected.width}px.
          </p>
        </section>
      )}
    </details>
  );
}
