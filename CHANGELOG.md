# Changelog

## 0.7.5

- Writer leases verify the owning instance, not only its process ID; abandoned leases recover safely.
- Restart waits briefly for an outgoing writer, and capture ownership is released before preview cleanup.
- Retry reopens history and runs restore recovery before capturing. Live competing windows remain protected.

## 0.7.4

- Fullscreen opens a retained editor preview instead of hiding the sidebar through Zen mode.
- Exit fullscreen closes only the preview; reopening works after close, reload or disposal.
- Fullscreen creation failures surface in a notification and Scrubline Output.

## 0.7.3

- Fullscreen read-only preview stays inside Antigravity with scrub and playback controls.
- Scrubbing retains decoded frames, coalesces rapid seeks, and ignores outdated preview responses.
- Changed element regions flow in/out using screenshot overlays; reduced-motion mode switches without animation.
- Screenshot region signatures contain no page text or input values. Older renders regenerate once for region metadata.

## 0.7.2

- Playback explains missing renders and single-checkpoint history instead of silent disabled controls.
- Render and screenshot failures include checkpoint IDs in Scrubline Output.

## 0.7.1

- Preview failures show one concise panel error; full child stderr moves to the Scrubline Output channel.
- Selection crops keep the element's inherited background, so light text on dark pages stays readable.

## 0.7.0

- Explicit sequential Render history, progress/cancel, persistent PNG cache and cache-only Play/Pause.
- One checkpoint selection drives cards, slider, changed paths and preview. Captures no longer steal selection.
- Folder-scoped preview settings refresh without restart; errors visible in panel and Scrubline Output.
- Canonical-folder storage binding prevents cross-folder saved-workspace history reuse. Older unbound history preserved, not automatically migrated.

## 0.6.0

- Theme-native compact panel, Phosphor icons, reduced-motion-safe feedback and keyboard/contrast checks.
- 1000-checkpoint virtualised timeline and faster ancestry load.
- Orphan blob compaction, confirmed workspace-history deletion and additional ignore patterns.
- Dependency audit clean; release and clean-profile install checks.
- Replay sharing deferred by owner. Earlier local prototype remains inert.

## 0.4.0

Isolated alternatives, file selective apply with three-way conflicts, static-navbar ownership review, candidate/post-apply checks and Windows cleanup/render fixes.

## 0.3.0

Opt-in targeting, redacted manual context packets and review-only MCP restore.

## 0.2.0

Historical previews, reviewed restore/Undo and transaction recovery.

## 0.1.0

Source snapshots, ignore/limit checks, watcher reconciliation and crash recovery.
