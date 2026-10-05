# Scrubline

A source timeline for agent-edited frontends. M1 captures stable disk states; preview and safe workspace restore are next.

## What works

- Baseline capture, save/watcher events, bounded debounce and hash reconciliation in one trusted local folder.
- SHA-256 blobs and versioned manifests outside the repository; restart recovery and isolated byte reconstruction.
- .gitignore and built-in exclusions, visible limits/errors, unsaved-buffer label.
- Real timeline, changed paths, honest Unattributed or exact-content hook match.

## What does not work yet

Live preview, workspace restore/Undo, targeting, branches and replay export. Not lossless capture of every transient edit. Antigravity runtime needs a live check; Windows FS results need Windows CI verification.

## Build and test

```bash
cd spikes/host-panel
npm ci
npm run build
npm run typecheck
npm run lint
npm run format
npm test
npm run check:nomock
npx playwright install chromium
npm run test:ui
npm run test:host # downloads VS Code, requires a display (xvfb-run on Linux)
```

Windows CI runs these checks. Source and limits: [M1 notes](docs/m1-source-timeline.md). Screenshots are supplied with each milestone patch; GitHub web-editor delivery cannot upload the PNGs.

## Layout

- spikes/host-panel: extension host, React panel, store/capture and tests
- fixtures/sample-web: test-only two-state site
- .agents: sanitised hook recorder; [configuration](docs/hooks.md)
- docs: limitations and verification
