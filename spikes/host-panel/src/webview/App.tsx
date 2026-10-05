import React from 'react';
import { ClockCounterClockwise } from '@phosphor-icons/react';
import type { HostInfo } from '../host-info';

declare global {
  interface Window {
    __SCRUBLINE_HOST_INFO__?: HostInfo;
  }
}

export const App: React.FC = () => {
  const hostInfo = window.__SCRUBLINE_HOST_INFO__;

  return (
    <div className="panel">
      <header className="header">
        <strong className="title">Scrubline</strong>
        <span className="badge">M0.1</span>
      </header>

      <section className="empty" aria-live="polite">
        <ClockCounterClockwise size={28} strokeWidth={1.5} aria-hidden="true" />
        <p className="emptyTitle">No checkpoints yet</p>
        <p className="emptyHint">Capture arrives with the M1 timeline.</p>
      </section>

      <footer className="footer">
        <span>
          {hostInfo ? `${hostInfo.appName} · v${hostInfo.vscodeVersion}` : 'Detecting host…'}
        </span>
      </footer>
    </div>
  );
};
