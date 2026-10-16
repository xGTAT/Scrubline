# UI Simplification (`standard` / `dev` Mode Split)

- **Branch:** `ui-simplification` (base `main` @ `721da8c`)
- **Status:** Implemented and validated locally; **uncommitted working tree**

## What's Done

### 1. Architecture & State Sync
- **`spikes/host-panel/src/bridge/timeline.ts`:** Added `uiMode?: 'standard' | 'dev'` to `TimelineState` and `{ type: 'set-ui-mode'; mode: 'standard' | 'dev' }` to inbound messages.
- **`spikes/host-panel/src/extension.ts`:** `activate()` reads `context.globalState.get('scrubline.uiMode')` (default `'standard'`), seeds it into the initial `TimelineState`, includes `uiMode` in every `publish()`, and handles `set-ui-mode` by persisting via `globalState.update` and republishing.

### 2. Webview UI & Styling
- **`spikes/host-panel/src/webview/App.tsx`:**
  - Added header `[ Standard | Dev ]` segmented toggle (`role="group"`, `aria-pressed`) and `<main data-mode="standard|dev">`.
  - Derived `dev = (modeOverride ?? state.uiMode ?? 'standard') === 'dev'` (`modeOverride` provides instant toggle feedback until the next host state sync).
  - **Standard mode (default) keeps:** Header + mode toggle, `Page` selector, status strip, empty/error/limit/lock-drift alerts, scrub slider + Prev/Next/Play, compact `Render history` button (shown only when >1 checkpoint has unrendered frames), `FrameView` preview, timeline cards (timestamp + file count) with pagination, and single-checkpoint restore review/confirm/undo.
  - **Dev mode gates:** Detailed render controls (`Clear render cache`, CSS investigation, breakpoint map, render receipt), `ChatbotView` (UI Advisor), multi-checkpoint row checkboxes/tray/mosaic table, perf badges/diffs, `Pick on page`, `Fork checkpoint` & Alternatives menu, `Select element`/target context/measured repair packet, `Lock element`/locked elements panel, raw verification violations/CSS rollback dumps, and footer diagnostics.
- **`spikes/host-panel/src/webview/styles.css`:** Added `.header-tools`, `.mode-switch`, `.render-quick`, and `.panel[data-mode='standard']` spacing rules; moved pre-existing orphaned `table-layout: fixed` into `.multi-table`.

### 3. Tests & Visual Evidence (All Green Locally)
- **`spikes/host-panel/test/ui/ui-mode.spec.ts` (New):** 5 Playwright tests covering Standard default surface, bidirectional `set-ui-mode` toggle messages, host-published `uiMode` restore, compact render action, and word-budget/axe/screenshot checks.
- **Updated existing UI specs:** Seeded `uiMode: 'dev'` into injected states that test Dev-only controls across `test/ui/panel.spec.ts` (9 states + footer assertion update), `test/ui/multi.spec.ts`, and `test/ui/motion089.spec.ts`.
- **`docs/evidence/`:** Regenerated PNG screenshots including new `panel_standard_mode.png` and `panel_dev_mode.png`.
- **Gates passed:** `npm run typecheck`, `npm run lint`, `npm run format`, `npm run check:nomock`, `npm run build`, Vitest unit suite (31 files / 201 tests), and Playwright UI suite (76 tests).

## What's Left

1. **Clean working tree before committing:**
   - Exclude untracked `.aider.*` files at repo root (`.aider.chat.history.md`, `.aider.input.history`, `.aider.tags.cache.v4/`).
   - Verify whether the two untracked motion recordings in `docs/evidence/motion/*.webm` should be committed alongside the regenerated PNGs or removed.
2. **Commit & push branch:**
   - Stage `spikes/host-panel/src/*`, `spikes/host-panel/test/ui/*`, and `docs/evidence/*.png` and commit to `ui-simplification`.
3. **Run release & host gates:**
   - Run real VS Code host integration tests (`npm run test:host` inside `spikes/host-panel`).
   - Run `vsce package` and verify the Windows CI gate on push/PR.
