# Active State
- **Focus:** Completed M0 feasibility spike validating host boundaries, extension packaging, React webview panel, on-disk checkpointing, and isolated preview rendering.
- **Conventions:** Target standard VS Code Extension API (`engines: { vscode: ^1.80.0 }`), rely on disk hashing (SHA-256) rather than lifecycle hooks for authoritative state, isolate historical previews in dedicated process directories.

# Recent Changes
- [Antigravity]: Implemented M0 feasibility spike with sample-web fixture, TypeScript extension with React webview panel, lifecycle hook auditor, and full feasibility findings report (`fixtures/sample-web/*`, `spikes/host-panel/*`, `.agents/hooks.json`, `docs/feasibility.md`, `docs/evidence/*`, `.gitignore`).

# Pickup Point
- Proceed to Milestone 1 (MVP A: reliable source timeline) by implementing the workspace file watcher, debouncer, SQLite metadata schema, and content-addressed blob store.
