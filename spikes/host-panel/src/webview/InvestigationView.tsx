import React, { useState } from 'react';
import type { TimelineRow, TimelineInbound } from '../bridge/timeline';
import type { Investigation } from '../investigation/types';
export function InvestigationView({
  rows,
  value,
  send
}: {
  rows: TimelineRow[];
  value?: Investigation;
  send: (message: TimelineInbound) => void;
}) {
  const [open, setOpen] = useState(false);
  const main = rows.filter((r) => !r.alternative);
  const [good, setGood] = useState('');
  const [bad, setBad] = useState('');
  const [budget, setBudget] = useState(16);
  const [kind, setKind] = useState<'horizontal-overflow' | 'containment'>('horizontal-overflow');
  const [selector, setSelector] = useState('');
  const [container, setContainer] = useState('');
  return (
    <details className="breakpoint-map" onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary>CSS culprit investigation</summary>
      {open && (
        <>
          <p>
            Static CSS value changes only. Fresh probes of 2-5 saved states; explicit assertion, not
            visual blame. Runs trusted commands. No source files applied.
          </p>
          <label>
            Last-known-good checkpoint
            <select value={good} onChange={(e) => setGood(e.target.value)}>
              <option value="">Choose</option>
              {main.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.createdAt} · {r.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Failing checkpoint
            <select value={bad} onChange={(e) => setBad(e.target.value)}>
              <option value="">Choose</option>
              {main.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.createdAt} · {r.id.slice(0, 8)}
                </option>
              ))}
            </select>
          </label>
          <label>
            Investigation assertion
            <select value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="horizontal-overflow">No page horizontal overflow</option>
              <option value="containment">Element inside ancestor</option>
            </select>
          </label>
          {kind === 'containment' && (
            <>
              <label>
                Investigation element
                <input value={selector} onChange={(e) => setSelector(e.target.value)} />
              </label>
              <label>
                Investigation ancestor
                <input value={container} onChange={(e) => setContainer(e.target.value)} />
              </label>
            </>
          )}
          <label>
            Subset probe budget
            <input
              type="number"
              min="1"
              max="32"
              value={budget}
              onChange={(e) => setBudget(Math.min(32, Math.max(1, Number(e.target.value) || 1)))}
            />
          </label>
          <button
            disabled={!good || !bad || good === bad || value?.running}
            onClick={() =>
              send({
                type: 'investigate-css',
                request: {
                  good,
                  bad,
                  budget,
                  guard: {
                    kind,
                    tolerance: 1,
                    ...(kind === 'containment' ? { selector, container } : {})
                  }
                }
              })
            }
          >
            Investigate approved assertion
          </button>
          {value?.running && (
            <button onClick={() => send({ type: 'cancel-investigation' })}>
              Cancel investigation
            </button>
          )}
          {value && (
            <section aria-label="Investigation evidence">
              <p role="status">{value.message}</p>
              <p>
                {value.probes} fresh probes · {value.transitions.length} passing-to-failing
                transitions.
              </p>
              <ul>
                {value.observations.map((o) => (
                  <li key={o.checkpoint}>
                    {o.checkpoint.slice(0, 8)}: {o.outcome}
                  </li>
                ))}
              </ul>
              <ul>
                {value.units.map((u) => (
                  <li key={u.path + u.key}>
                    <code>
                      {u.path}: {u.selector} / {u.property}
                    </code>
                    <p>
                      {u.before} → {u.after}
                    </p>
                  </li>
                ))}
              </ul>
              <p>
                Results apply only to this assertion/environment. No unique root cause or AI-turn
                attribution claimed.
              </p>
            </section>
          )}
        </>
      )}
    </details>
  );
}
