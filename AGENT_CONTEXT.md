# Active State
- Focus: M3 targeting/context implemented locally. Next: branch publication and Windows gate, then M4 selective apply.
- Disk SHA-256 is capture authority. Hooks add only exact-content-matched metadata.
- One trusted local workspace folder, store outside repo, no native modules.

# Recent Changes
- M0.1: honest spike, sanitised hooks, reproducible build and Windows CI.
- M1: versioned manifests/blobs/index, writer lock, bounded debounce, hash reconciliation, ignore/limit checks, real host timeline and changed paths. Unit/crash/UI and real VS Code host tests.

# Pickup Point
- Read docs/m1-source-timeline.md before extending the capture/store.
- B8 closed by real capture and reconstruction tests; B12-B14 found and fixed with regressions.
- Windows CI storage/FS results must be checked. Live Antigravity hooks and rendered-panel evidence remain human checks (B1/B2/B7/B9).
- M2 must add safety/drift/transaction checks before any workspace restore. Current materialize only accepts empty isolated destinations.
- M1/M2 Windows gates passed. M3 gate must be checked after publication.
- B15/B16: remote malformed-path debris removed, full text tree verified; LF checkout/Prettier fixed Windows format gate. Original PNGs recovered and included in patch but remote upload HTTP 400 prevents restoration; parent has original-image attachments.
- Dev-only Vitest moderate advisory remains documented, revisit M6.

# Owner UI steering (October 5)
- Final UI must look modern and professional with industry-level animation (owner Slack DM thread 1791206598.330939, message 1791216692.507039). Apply mainly in M6, with M2/M3 preparing clean layout and interaction.
- Motion must explain state: scrub crossfade; View Transitions only with verified element identity. No gratuitous movement; honor prefers-reduced-motion. Keep the existing concise copy, theme tokens and accessibility gates.

# M2 progress
- M1 Windows gate PASS: https://github.com/xGTAT/Scrubline/actions/runs/37337350515 (latest 90072f3).
- M2 local implementation: preview runner, historical copies/screenshots, keyboard scrub, native diff, reviewed restore/Undo and journal recovery. Read docs/m2-preview-restore.md for exact limits.
- B17-B19 fixed with tests. Local 30 unit/FS/crash/preview tests, 15 UI tests, real VS Code host restore/Undo pass. M2 Windows PASS: https://github.com/xGTAT/Scrubline/actions/runs/37342736022 (7ec0766).

# M3 progress
- Opt-in same-origin overlay, unique selector/fingerprint, separate Chromium window, Escape/Stop, sanitized crop, deterministic redacted context and review-before-copy. Optional MCP approved Oct 5 23:09:52 and included as stdio listing/review-only restore.
- Init-script test caught document.body timing and transpiler helper issues; fixed. Actual session tests cover reload, stale replacement, crop and edit/new checkpoint.
- Local 38 unit tests, 19 UI tests, host regression, VSIX package pass. Windows result pending publication. Read docs/m3-targeting-context.md for redaction and selection limits.

# M4 progress
- Main M0.1-M3 gate PASS: https://github.com/xGTAT/Scrubline/actions/runs/37357088937 @ 3e07c9e.
- Local M4 snapshot forks, DAG restart, captured side-by-side renders, file three-way merge/review/Undo, candidate+post-build checks and narrow standalone navbar HTML/CSS ownership. No worktrees/hunks/general component mapping.
- 47 unit tests, 20 UI, host, package pass; publication and Windows gate pending. Read docs/m4-branches-selective.md.

# M6 release status
- M4 Windows passed #134 at fea3fb2. M5 deferred by owner; no replay command/UI in release.
- M6 v0.6.0: 1000-row virtualization, theme/icon/motion polish, compaction/delete commands, ignore additions, Vitest4.1.11 audit clean. 50 units/24 UI/host/install checks local PASS. Windows release run pending.
- Read docs/m6-release.md for benchmark, exact limits and Human checks; no claim of Antigravity support or owner-machine benchmark.

# v0.7 playback and consistency
- Explicit sequential Render history and config-keyed PNG cache, progress/cancel, cache-only750ms playback. Card/slider/changed paths/preview share selection.
- Folder-scoped preview settings refresh without restart. Canonical-folder storage binding preserves unbound legacy history without guessing a migration.
- Read docs/v07-release.md for operational bounds and gates.
