import React, { useState, useEffect } from 'react';

declare global {
  interface Window {
    __SCRUBLINE_HOST_INFO__?: {
      vscodeVersion: string;
      appName: string;
      appHost: string;
      language: string;
      workspaceFolders: string[];
      extensionPath: string;
    };
    acquireVsCodeApi?: () => {
      postMessage: (msg: any) => void;
      setState: (state: any) => void;
      getState: () => any;
    };
  }
}

interface Checkpoint {
  id: string;
  name: string;
  timestamp: string;
  hash: string;
  source: string;
  port: number;
}

const SAMPLE_CHECKPOINTS: Checkpoint[] = [
  {
    id: 'chk_001',
    name: 'State A: Baseline Fixture',
    timestamp: '2026-09-25 17:30:00',
    hash: 'sha256-4f8a29...',
    source: 'Initial Repo Fixture',
    port: 4101
  },
  {
    id: 'chk_002',
    name: 'State B: Agent Feature Edit',
    timestamp: '2026-09-25 17:35:00',
    hash: 'sha256-9b1c73...',
    source: 'Antigravity IDE Agent Edit',
    port: 4102
  }
];

export const App: React.FC = () => {
  const [hostInfo, setHostInfo] = useState<any>(null);
  const [selectedIdx, setSelectedIdx] = useState<number>(1);
  const [copied, setCopied] = useState<boolean>(false);

  useEffect(() => {
    if (window.__SCRUBLINE_HOST_INFO__) {
      setHostInfo(window.__SCRUBLINE_HOST_INFO__);
    }
  }, []);

  const activeCheckpoint = SAMPLE_CHECKPOINTS[selectedIdx];

  const copyPromptPacket = () => {
    const packet = `[Scrubline Context Packet]\nCheckpoint: ${activeCheckpoint.id} (${activeCheckpoint.name})\nTarget: fixtures/sample-web/index.html\nState Hash: ${activeCheckpoint.hash}`;
    navigator.clipboard?.writeText(packet);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div style={styles.container}>
      <header style={styles.header}>
        <div style={styles.headerTop}>
          <div style={styles.brand}>
            <span style={styles.brandDot}></span>
            <strong style={styles.brandTitle}>Scrubline Panel</strong>
          </div>
          <span style={styles.badge}>M0 Spike</span>
        </div>
        <p style={styles.subtitle}>Frontend Change Review & Checkpoint Timeline Layer</p>
      </header>

      {/* Host Diagnostics */}
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <span style={styles.cardTitle}>Host Environment Diagnostics</span>
          <span style={styles.tagSuccess}>Active</span>
        </div>
        <div style={styles.diagGrid}>
          <div style={styles.diagItem}>
            <span style={styles.diagLabel}>Host Name:</span>
            <span style={styles.diagValue}>{hostInfo?.appName || 'Detecting...'}</span>
          </div>
          <div style={styles.diagItem}>
            <span style={styles.diagLabel}>VS Code API:</span>
            <span style={styles.diagValue}>v{hostInfo?.vscodeVersion || '1.107.0'}</span>
          </div>
          <div style={styles.diagItem}>
            <span style={styles.diagLabel}>App Host:</span>
            <span style={styles.diagValue}>{hostInfo?.appHost || 'desktop'}</span>
          </div>
          <div style={styles.diagItem}>
            <span style={styles.diagLabel}>Language:</span>
            <span style={styles.diagValue}>{hostInfo?.language || 'en'}</span>
          </div>
        </div>
      </section>

      {/* Timeline Scrubber */}
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <span style={styles.cardTitle}>Historical Checkpoint Scrub</span>
          <span style={styles.tagInfo}>Isolated Previews</span>
        </div>

        <div style={styles.timelineScrubber}>
          <input
            type="range"
            min={0}
            max={SAMPLE_CHECKPOINTS.length - 1}
            value={selectedIdx}
            onChange={(e) => setSelectedIdx(parseInt(e.target.value, 10))}
            style={styles.slider}
          />
          <div style={styles.stepLabels}>
            {SAMPLE_CHECKPOINTS.map((chk, idx) => (
              <button
                key={chk.id}
                onClick={() => setSelectedIdx(idx)}
                style={{
                  ...styles.stepBtn,
                  ...(selectedIdx === idx ? styles.stepBtnActive : {})
                }}
              >
                {chk.name.split(':')[0]}
              </button>
            ))}
          </div>
        </div>

        {/* Selected Checkpoint Card */}
        <div style={styles.checkpointDetail}>
          <div style={styles.checkpointHeader}>
            <strong>{activeCheckpoint.name}</strong>
            <span style={styles.hashTag}>{activeCheckpoint.hash}</span>
          </div>
          <p style={styles.metaText}>
            Source: <strong>{activeCheckpoint.source}</strong> &bull; {activeCheckpoint.timestamp}
          </p>
          <div style={styles.isolationNotice}>
            <span>Isolated Process Port: <code>http://localhost:{activeCheckpoint.port}</code></span>
            <span style={styles.safeTag}>Read-Only Snapshot</span>
          </div>
        </div>
      </section>

      {/* Context Packet Export */}
      <section style={styles.card}>
        <div style={styles.cardHeader}>
          <span style={styles.cardTitle}>Agent Handoff Packet</span>
        </div>
        <p style={styles.metaText}>
          Non-automated, manual prompt packet generation with verified disk checkpoint metadata:
        </p>
        <button style={styles.copyBtn} onClick={copyPromptPacket}>
          {copied ? '✓ Copied to Clipboard!' : 'Copy Element Context Packet'}
        </button>
      </section>

      <footer style={styles.footer}>
        <small>Scrubline Host Boundary Feasibility Test &bull; M0</small>
      </footer>
    </div>
  );
};

const styles: { [key: string]: React.CSSProperties } = {
  container: {
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    maxWidth: '480px',
    margin: '0 auto'
  },
  header: {
    borderBottom: '1px solid var(--vscode-sideBarSectionHeader-border, #333)',
    paddingBottom: '10px'
  },
  headerTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  brand: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px'
  },
  brandDot: {
    width: '10px',
    height: '10px',
    borderRadius: '50%',
    backgroundColor: '#38bdf8',
    display: 'inline-block'
  },
  brandTitle: {
    fontSize: '15px',
    color: 'var(--vscode-foreground, #eee)'
  },
  badge: {
    fontSize: '11px',
    fontWeight: 600,
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    color: '#38bdf8',
    padding: '2px 8px',
    borderRadius: '12px',
    border: '1px solid rgba(56, 189, 248, 0.3)'
  },
  subtitle: {
    fontSize: '12px',
    color: 'var(--vscode-descriptionForeground, #888)',
    marginTop: '4px',
    margin: 0
  },
  card: {
    backgroundColor: 'var(--vscode-editor-inactiveSelectionBackground, rgba(255, 255, 255, 0.04))',
    border: '1px solid var(--vscode-widget-border, #333)',
    borderRadius: '8px',
    padding: '12px',
    display: 'flex',
    flexDirection: 'column',
    gap: '10px'
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center'
  },
  cardTitle: {
    fontSize: '12px',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    color: 'var(--vscode-foreground, #ccc)'
  },
  tagSuccess: {
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '4px',
    backgroundColor: 'rgba(34, 197, 94, 0.2)',
    color: '#22c55e',
    fontWeight: 600
  },
  tagInfo: {
    fontSize: '10px',
    padding: '1px 6px',
    borderRadius: '4px',
    backgroundColor: 'rgba(56, 189, 248, 0.15)',
    color: '#38bdf8',
    fontWeight: 600
  },
  diagGrid: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: '6px 12px',
    fontSize: '12px'
  },
  diagItem: {
    display: 'flex',
    flexDirection: 'column'
  },
  diagLabel: {
    color: 'var(--vscode-descriptionForeground, #777)',
    fontSize: '11px'
  },
  diagValue: {
    color: 'var(--vscode-foreground, #eee)',
    fontWeight: 500,
    fontFamily: 'monospace'
  },
  timelineScrubber: {
    display: 'flex',
    flexDirection: 'column',
    gap: '8px'
  },
  slider: {
    width: '100%',
    cursor: 'pointer',
    accentColor: '#38bdf8'
  },
  stepLabels: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '8px'
  },
  stepBtn: {
    flex: 1,
    padding: '5px 8px',
    fontSize: '11px',
    backgroundColor: 'var(--vscode-button-secondaryBackground, #2a2a2a)',
    color: 'var(--vscode-button-secondaryForeground, #ddd)',
    border: '1px solid transparent',
    borderRadius: '4px',
    cursor: 'pointer'
  },
  stepBtnActive: {
    backgroundColor: '#0284c7',
    color: '#ffffff',
    fontWeight: 600,
    borderColor: '#38bdf8'
  },
  checkpointDetail: {
    backgroundColor: 'var(--vscode-editor-background, #1e1e1e)',
    border: '1px solid var(--vscode-widget-border, #444)',
    borderRadius: '6px',
    padding: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px'
  },
  checkpointHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: '12px'
  },
  hashTag: {
    fontFamily: 'monospace',
    fontSize: '11px',
    backgroundColor: 'rgba(255, 255, 255, 0.08)',
    padding: '2px 5px',
    borderRadius: '3px'
  },
  metaText: {
    fontSize: '11px',
    color: 'var(--vscode-descriptionForeground, #888)',
    margin: 0
  },
  isolationNotice: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontSize: '11px',
    paddingTop: '6px',
    borderTop: '1px dashed var(--vscode-widget-border, #333)'
  },
  safeTag: {
    color: '#22c55e',
    fontSize: '10px',
    fontWeight: 600
  },
  copyBtn: {
    padding: '8px 12px',
    backgroundColor: 'var(--vscode-button-background, #0e639c)',
    color: 'var(--vscode-button-foreground, #ffffff)',
    border: 'none',
    borderRadius: '4px',
    fontSize: '12px',
    fontWeight: 500,
    cursor: 'pointer',
    transition: 'background-color 0.15s'
  },
  footer: {
    textAlign: 'center',
    color: 'var(--vscode-descriptionForeground, #666)',
    marginTop: '8px'
  }
};
