# Active State
- **Focus:** M0.1 stabilisation of the M0 spike: honest empty-state panel, sanitised hook recorder, real README/docs, reproducible build, CI on a Windows runner.
- **Conventions:** VS Code Extension API (`engines: { vscode: ^1.80.0 }`). Disk hashing (SHA-256) is the capture authority; Antigravity hooks are attribution metadata only. No mock data outside `test/` and `fixtures/` (enforced by `npm run check:nomock`).

# Recent Changes
- [M0.1]: Replaced the fake-checkpoint panel with an empty state; rewrote the hook recorder with allowlist sanitisation (B1, B2, B9); real README; `.gitignore` no longer hides `package-lock.json`; feasibility doc links are relative and the Antigravity evidence claim is corrected; added ESLint, Prettier, Vitest, Playwright smoke tests, `check:nomock`, and a Windows GitHub Actions workflow.

# Pickup Point
- Next milestone: M1 reliable source timeline (watcher + debounce, content-addressed blob store, checkpoint manifests).
- Open bugs: B8 (spike capture numbers stay non-reproducible until M1 replaces them).
- Pending human checks: live Antigravity hook run producing one sanitised log line (B1/B2/B9), Antigravity panel screenshot for the evidence claim (B7), one look at the empty-state panel.
