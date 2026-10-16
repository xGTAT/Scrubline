## Unreleased

- Backend visuals: a new **Backend** tab in the checkpoint panel shows the HTTP requests the page made during rendering (waterfall), API routes found by static source scan, a backend import graph, and a request-count diff against the parent checkpoint.
- Capture is metadata-only: paths, status, timing and protocol only; bodies, headers, cookies and query values are never stored. Heuristic redaction of token-looking path segments and secret-looking query keys (bounded, not guaranteed - see docs/backend-visuals.md).
- Observed browser requests are labeled separately from static scan results; neither claims server-side or database causality.
- New settings: scrubline.backendCapture (default on), scrubline.backendCaptureFilter, scrubline.backendMaxRequests (default 60), scrubline.backendDiagrams.
- Waterfall scrolls internally at narrow panel widths.

## 0.10.0

- Multi-checkpoint composition: check any number of checkpoint cards (cap `scrubline.multiSelectLimit`, default 20, max 50), order them in the selection tray, and review one combined candidate.
- Three modes: Combine changes (ordered per-checkpoint deltas onto the current workspace; divergence is a whole-file conflict), Revert changes (latest-first inverse deltas; dependent later changes are named and block), Pick per file (mosaic winner per touched file, current kept otherwise).
- Composition plugs into the existing review/apply/Undo transaction: exact-path review, drift/dirty/concurrent-edit guards, safety snapshot, journal crash recovery, post-apply verification, and Undo of the whole combined apply.
- Combined candidate renders a preview with a receipt before confirmation; the review names the checkpoint set, order and mode, degrades to the per-file table when rendering is unavailable.
- Dependency hints name unselected checkpoints a selected change sits on, with one-click Add; composition conflicts disable confirmation.
- Selection persists across panel reloads; shift-click extends ranges.
- Read-only MCP `review_checkpoints` tool composes and opens the same review; apply stays panel-confirmed.
- Mosaic element picks for static HTML: per-file optional element id narrows the winner to that subtree plus paired id-scoped CSS, with the existing refusal rules; a refusal conflicts only that file.
- Composition identity binding: changing the set, order, mode or overrides after review disables Confirm and refuses apply with a stale-review error.
- Limits: one element pick per file (static HTML only), combine folds whole files (no hunk merge).

## 0.9.1

- Advisor chatbot in the panel (read-only; answers from timeline, preview and targeting context, never mutates the workspace).
- Output verification before restore: structural and visual invariant checks block a failing restore and show violations plus visual diff highlights.
- Multi-element cherry-picking: pick several elements in one pass; the review lists applied elements with owned files; ownership conflicts are refused.

- The changes badge and "Read-only screenshot" caption no longer overlay the preview: they live in a bar below the frame, so short or content-filled pages are never covered at any panel width or change count.
- Checkpoints and render history are now page-scoped: a checkpoint only appears (and renders) on pages whose own files changed. Page file sets cover the HTML document plus its local stylesheets, scripts and media, including recursive CSS @import/url() targets; changes to shared assets still appear on every page that uses them, and changes no page maps (config, framework sources) stay visible everywhere. Server-rendered routes without a static document keep the full timeline.

## 0.9.0

- Element pick and selective apply now cover framework sources: JSX/TSX (React, Preact, Solid, Next.js), Vue, Svelte and Astro single-file components, and Angular templates through the static HTML path.
- Static analysis only: exact byte ranges from @babel/parser and masked-template parsing; no build, bundler plugin or node_modules required, including on historical snapshots.
- Picked elements resolve by unique id/data-testid or a scored tag/text/name match; ambiguity and structural drift refuse instead of guessing.
- Paired exclusive styles extend to imported .css/.scss/.less stylesheets and SFC <style> blocks; SCSS/Less nesting and unsupported selectors are never rolled back.
- CSS-in-JS (styled-components/emotion) is detected and disclosed: markup restores, component styles stay current.
- New framework-lab fixture sites (React TSX, Vue, Svelte, Astro, Angular, styled-components) with unit coverage.
- Page dropdown lists discovered static HTML pages, the configured preview route and custom routes; the active page persists per workspace.
- Scrubbing, render history, interactive preview and rechecks run against the selected page with per-page render caches.
- Pick on page and Hidden element ID cherry-pick against the active page's document; existing static-HTML eligibility refusals are unchanged per page.
- React development builds get element-level cherry-picking on framework routes: fiber debug metadata (React <=18 `_debugSource`, React 19 `_debugStack`) resolved through loopback-only source maps into a TypeScript-AST JSX element carry, with strict component/skeleton identity (reorder, duplicates, moves and renames refused) and a missing-identifier dependency guard.
- Other framework and server-rendered pages get automatic exact-file cherry-picking (same reviewed selective apply as Changed paths) when element picking is unavailable or refused.
- Live dropdown refresh on HTML file create/delete; discovery skips dependency/build folders and caps at 200 pages.

## 0.8.2

- Static CSS culprit investigation scans selected ancestry with an approved geometry assertion.
- Value-only declaration candidates are tested outside the original workspace with a bounded subset budget.
- Reports observed transitions and conditional single-removal minimality, not unique root cause or AI authorship.
- Refuses structural/ambiguous CSS, unknown probes and mismatched pass/fail endpoints.

## 0.8.1

- Opt-in breakpoint/history map for up to five checkpoints and 24 sampled probes.
- Approved page-overflow or unique ancestor-containment assertions with numeric tolerances.
- Pass/fail/unknown results, serial cancellation, sampled-width evidence and links to checkpoint review.
- Unsampled intervals remain unknown; no framework ownership or automatic repair claimed.

## 0.8.0

- Configurable local route, viewport and optional visible readiness selector.
- Browser executable/runtime-bound render cache with integrity-checked source/environment receipts.
- Two fresh render probes classify exact evidence as repeatable-in-two-probes or unstable, without claiming frozen dependencies/backends.
- Actual image dimensions drive transitions and highlights; portrait previews stay readable.
- Preserved screenshot fallback carries its original provenance instead of pretending to be a fresh render.

## 0.7.10

- Persistent region outlines compare selected rendered checkpoints with their saved parent.
- Current and previous positions, additions/removals and size-only changes; toggle and reduced-motion support.
- Link and SVG sampling with stable IDs/hashed unique accessible labels; 1,000 candidate and 80 visible-mark limits.
- New render-cache key regenerates comparison metadata.

# Changelog

## 0.8.6

- Interrupted scrub fades paint outgoing composites before the next browser paint and avoid duplicate region motion.
- Breakpoint checkpoint actions now open actual restore review, with confirmation kept beside review and in view above expanded forks.
- Plain HTML element cherry-pick restores a unique id subtree, inline style and exclusively id-scoped local CSS through exact diff, isolated validation and Undo. Ambiguous/shared/scripted ownership is refused.
- Distinct fork/base/saved identities, mutually exclusive major tools and compact progressive disclosure reduce panel crowding. Includes unpushed 0.8.5 stable MCP runtime fix.

## 0.8.5

- MCP setup now uses a verified stable runtime in extension storage instead of a versioned install folder. The runtime refreshes on activation after upgrades.
- Existing MCP entries pointing to deleted extension folders must be replaced once using Scrubline: Start Local MCP.
- Added packaged stdio initialize/tool-list verification and runtime upgrade regression coverage.

## 0.8.4

- Measured repair context extends manual-paste packets with source-bound CSS declaration spans, historical transition, assertion, complete counterfactual outcomes, and matching receipt when available.
- Deterministic UTF-8 byte budget, whole-section omissions, secret redaction, explicit byte-based token estimate, and text-only review.
- Rechecks immutable source, specification and selected DOM before copying; no inferred component ownership or automatic model submission.

## 0.8.3

- Guarded CSS inverse rollback for uniquely owned min/max width/height values, rebased against current source while retaining unrelated edits.
- Repair and optional keep geometry assertions checked twice; exact inverse/diff review and settings/dirty/drift checks before apply.
- Post-apply live-source assertion checks inside the recovery journal; failed checks roll back safely, concurrent bytes are preserved, successful apply supports Undo.
- Shorthand/shared-token/structural/duplicate CSS ownership is refused rather than guessed.

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

## 0.8.7

- Remove screenshot crossfades and cropped-region motion at every navigation speed. Keep the last decoded frame until the requested image is ready, then swap once.
- Mouse-based element picking from saved webpages, including uniquely source-mapped static elements without IDs. Typed IDs remain a secondary path for invisible elements.
- Support exclusively owned simple tag/class/ID descendant CSS rules, preserving their cascade positions; refuse shared/ambiguous ownership.
- Test no-ID navbar content/style apply and Undo against live web-lab source; add captured-image navigation regression.
- Refresh README for current setup, MCP upgrade, review, Alternatives, element workflow and safety limits.

## 0.8.8

- Restore smooth single-state veil transitions: fade out, swap the decoded screenshot only under opaque cover, fade in. Coalesce rapid requests and honor reduced motion.
- Resolve clicked source nodes directly; allow stable repeated-element positions when page identity structure is unchanged, with specific drift refusals.
- Parse CSS selectors, preserve unchanged shared tokens and support exclusive rules under media/supports/container/layer conditions without changing cascade positions.
- Drain and dispose prior activations, with same-IDE-session writer handoff and genuine cross-window exclusion. Older installed runtimes may need one window reload to adopt the protocol.
- Add rich web-lab index fixture, responsive picker, fade opacity, hot activation and writer-handoff regressions.

## 0.8.9

- Keep unchanged screenshot areas still. Group actual pixel differences into local fade covers with surrounding-surface fills; skip identical-image fades and use atomic swaps for incompatible images.
- Resolve descendants across ancestor class/theme edits using semantic anchors and guarded source positions. Support self-closing SVG shapes.
- Preserve current shared/unmatched CSS instead of refusing every element pick. State the selective-style scope in review, and explain no-change selections without offering confirmation.
- Add current Studio source regressions, local-cover color/unchanged-area checks and real Alternatives picker/apply/Undo plus paused-mid-fade verification.

## 0.8.10

- Restore full-frame cached screenshot dissolves without background dips, local masks or moving region crops. Interrupted fades continue from current composite pixels, then clear to the exact decoded frame.
- Clarify that Capture updates a fork and Compare is workspace vs one selected alternative. No two-item storage/menu cap was found; real Studio testing showed four entries, with six-entry persistence/UI regressions.
- Keep Studio picker fixes and selective-style review limits.

## 0.8.11

- Fix a verified slow same-session writer handoff failure: wait up to 60 seconds for the previous instance's in-flight queue instead of misreporting another window after three seconds. Show automatic-opening progress while waiting, with a distinct timeout message.
- Keep different-window writer exclusion. Add safe PID/session-match diagnostics in Scrubline Output without lock tokens.
- Add a real Timeline queue regression with a 4.2-second in-flight operation; it fails before the fix and passes afterward. Final gates: 87 unit, 45 UI, native Antigravity host and packaged MCP pass.
- Verify literal native file-dialog upgrades from 0.8.9 to 0.8.10 and 0.8.10 to 0.8.11 on Linux Antigravity 2.5.5, retaining History. The exact Windows every-update/no-restart error remains un-reproduced; this release does not claim its specific trigger is established.

## 0.8.12

- Fix investigation false refusals: custom properties, var()/url() values and duplicated ownership are now rejected only when the changed unit actually involves them, not for their mere presence in the file.
- Fix identical investigation reruns crashing with EEXIST. Records are content-addressed: an identical stored record is a no-op, different content under the same name is still refused, and the 20-record limit no longer counts an already-stored identical record. New same-investigation-twice unit test.
- Fix preview errors going invisible after any settings change: the settings-refresh rebuild of the preview runner wires the same error callback as activation, so a failing preview shows 'Preview unavailable' with Retry.
- Fix one settings write firing the configuration refresh twice (two scopes). Refreshes are single-flight with coalescing; a trailing refresh no longer wipes fresh preview state.
- Fix webview messages (for example Start preview) being silently dropped during a settings refresh; they now wait for the refresh before running.
- Timeline selection: host-initiated reviews move the panel selection through an explicit select message and stale webview acknowledgements are ignored again, keeping fullscreen seeking immune to stale acks. New UI regression covers both directions.
- Round-6 full feature audit against the real web-lab repository in Antigravity 2.5.5: every feature exercised end-to-end with intended-output assertions; per-row results in README.
- Gates: 89 unit, 47 UI, typecheck, eslint, prettier; native Antigravity host verification of the audit fixes.
