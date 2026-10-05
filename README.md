# Scrubline

Timeline scrubbing for agent-edited frontends: capture every on-disk state, scrub back through it, keep what you like. Currently a stabilised M0 spike (M0.1).

## What works today

- The `spikes/host-panel` extension installs in VS Code and Antigravity and opens a sidebar plus an editor panel showing an honest empty state.
- `fixtures/sample-web`, a zero-dependency two-state demo page used by the smoke tests.
- A sanitised Antigravity hook recorder (`.agents/scripts/hook-recorder.js`): allowlisted fields only, hashed conversation ID, log written outside the repo.

![Empty-state panel](docs/evidence/panel_empty_state.png)

## What does not work yet

- No checkpoint capture, storage, or replay. The real timeline arrives in M1.
- No live preview, restore, targeting, or branching.
- The hook recorder is verified against the documented payload contract; a live Antigravity hook run is still a pending human check.

## Build and test

```bash
cd spikes/host-panel
npm ci
npm run build        # esbuild -> dist/
npm run typecheck    # tsc --noEmit
npm run lint         # eslint
npm test             # vitest unit tests (hook recorder)
npm run check:nomock # fail on mock markers in src/ or dist/
npm run test:ui      # playwright smoke (panel empty state + sample-web)
```

CI (GitHub Actions, Windows runner) runs the same steps on every push.

## Layout

- `spikes/host-panel/` - the extension (TypeScript host + React webview)
- `fixtures/sample-web/` - demo fixture (test-only data)
- `.agents/` - Antigravity hook configuration and recorder
- `docs/` - feasibility findings and hook notes
