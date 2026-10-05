# Active State
- Focus: M1 source timeline implemented. Next: M2 preview, read-only scrub, safe restore.
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
- Publication follow-up: latest M1 Windows CI run https://github.com/xGTAT/Scrubline/actions/runs/37336794990 was in progress. Do not begin M2 execution until checked.
- B15/B16: remote malformed-path debris removed, full text tree verified; LF checkout/Prettier fixed Windows format gate. Original PNGs recovered and included in patch but remote upload HTTP 400 prevents restoration; parent has original-image attachments.
- Dev-only Vitest moderate advisory remains documented, revisit M6.
