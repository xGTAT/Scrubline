# Scrubline

A source timeline for agent-edited frontends. M4 captures disk states, renders isolated previews, reviews restore/Undo, and builds redacted manual-paste context from visual selections.

## What works

- Baseline capture, save/watcher events, bounded debounce and hash reconciliation in one trusted local folder.
- SHA-256 blobs and versioned manifests outside the repository; restart recovery and isolated byte reconstruction.
- .gitignore and built-in exclusions, visible limits/errors, unsaved-buffer label.
- Real timeline, changed paths, honest Unattributed or exact-content hook match.

## Preview and restore

Configure `scrubline.previewCommand` (workspace-relative command, `{port}` placeholder) and `scrubline.previewPort`. Optional `scrubline.chromiumPath` points to installed Chromium for screenshots, with no runtime browser download. Select a checkpoint to render an isolated copy, open preview, then Review restore and confirm the exact paths. Drift or unsaved buffers block restore. Undo refuses later edits. See [M2 notes](docs/m2-preview-restore.md) for command/isolation and recovery limits.

## Visual context

Select a rendered checkpoint, then **Select element** to open an opt-in Chromium targeting window. Review the redacted packet before copying it for manual paste. Stale selectors are refused, not retargeted. Crops are sanitized clones, not exact page pixels. See [M3 notes](docs/m3-targeting-context.md) for redaction limits and setup.

## Local MCP

**Scrubline: Start Local MCP** opens client configuration for two tools: list checkpoints and request restore review. MCP never applies files; confirm exact paths in the Scrubline panel. See [M3 notes](docs/m3-targeting-context.md) for setup and local-access limits.

## Alternatives

Fork a checkpoint into an isolated folder, capture edits, compare rendered alternatives, then choose exact files to review. Three-way overlap is blocked. A narrow standalone static navbar prototype is included; shared CSS and embedded/framework ownership are refused. A configured build/test command must pass before and after selective apply. See [M4 notes](docs/m4-branches-selective.md).

## What does not work yet

Replay export and general hunk/framework element apply. Preview commands requiring excluded dependencies may not reproduce; labelled screenshots are the fallback. Not lossless capture of every transient edit. Antigravity runtime needs a live check; Windows FS results need Windows CI verification.

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

## Release 0.6.0

Install the unsigned VSIX locally. Run Scrubline: Open Panel in a trusted single-folder workspace. Configure previewCommand and optional chromiumPath in Settings for rendered history. [Release gates and Human checks](docs/m6-release.md).

Shipped-build dark/light/high-contrast screenshots are included in the release evidence patch; binary publication through GitHub upload is unavailable in this session.

Retention keeps every checkpoint until explicit deletion. Run Compact unused history data to remove orphan blobs, or Delete workspace history to erase this workspace's store after confirmation. Additional exclusions: scrubline.ignoreAdditions. No telemetry; no runtime browser download.

Replay sharing is on hold. M5 files are an inert prototype, not a shipped feature. The release is private/UNLICENSED; Open VSX publication and licence selection remain the owner's decision.
