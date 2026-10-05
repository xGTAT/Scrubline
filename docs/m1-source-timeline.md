# M1: Reliable source timeline

## Storage decision

Use SHA-256 blobs, one versioned JSON manifest per checkpoint, and a rebuildable JSON index in extension workspace storage. No SQLite or native dependency. Accepted manifests only reference synced, checksum-verified blobs. A single-writer lock prevents two editor windows from forking the chain. A dead writer's lock is reclaimed on restart; PID reuse may require manual lock removal after all editor windows close.

File writes use exclusive temporary files, fsync, then rename. Manifests are the commit point; recovery ignores incomplete temporary files and rebuilds the index. Linux crash tests kill a child before and after manifest rename and verify complete recovered history. Windows CI runs the same tests. Node cannot fsync a Windows directory, so process-crash safety is tested; power-loss durability is not claimed. Windows storage spike and filesystem results need confirmation from the Windows CI run, not inference from Linux.

## What is captured

One trusted local workspace folder. Baseline on activation; VS Code watcher create/change/delete and saves; 300ms debounce bounded at 2s; 30s hash reconciliation. Two matching scans reject common mid-edit races. This is stable on-disk history, not every transient edit or a transactional snapshot across unrelated concurrent writers. Unsaved buffers are labelled and not captured.

Built-in exclusions: .git, node_modules, dist, build, out, .next, coverage, .snapshots, .env*, hook-events.jsonl. Nested .gitignore rules use the pure-JS `ignore` parser. External symlinks are rejected. In-workspace file symlinks capture target bytes as ordinary files; directory symlinks are rejected to avoid loops. Excluded targets cannot leak through symlinks. Case-colliding paths are rejected on every platform. File count, per-file and total size limits reject the entire capture with a warning; store quota does the same. Settings expose these limits.

## Attribution

Unattributed unless a new sanitised hook record matches both the workspace fingerprint and exact current bytes of a changed target file. No timestamp overlap inference. Hook match refers only to the matching path listed in manifest attribution, not authorship of every changed file. Existing logs at activation are not reused. Configure `scrubline.hookLog` and `SCRUBLINE_HOOK_LOG` to the same file outside the repository. Deletions and directory/tool-command changes without exact disk evidence stay Unattributed. A live Antigravity hook run remains unverified.

## Checks performed in the Linux sandbox

- 21 Vitest tests: exact byte reconstruction after restart, deterministic random-byte checkpoint property, CRLF/binary data, rename/delete/atomic replacement, nested ignores, symlink exclusions, limits/quota, corruption, schema migration rejection, single writer, debounce, reconcile, exact attribution and kill-process recovery.
- VS Code 1.96.4 extension-host test: real activation, baseline, actual watcher edit capture, command/panel creation. No substituted host API.
- 9 Playwright checks: empty/loading/error/limit/populated states, narrow 280px panel, changed paths, dirty-buffer label, word budget and zero serious/critical axe violations. Screenshots reviewed.
- Typecheck, lint, formatting, build, no-placeholder gate.

## Limits / remaining checks

Windows drive/case behaviour, long paths, file locks and atomic rename must pass Windows CI. Symlink tests requiring elevated Windows privilege currently run on Linux only. Antigravity hook runtime and editor-panel feel need a human check. There is no workspace restore yet; `materialize` only creates an isolated empty snapshot directory for byte verification. Preview/restore is M2. Retention/compaction is M6; until then quota stops new captures rather than deleting history. Timeline uses a bounded three-row page to keep the sidebar concise, not an unbounded list.

## Bug pass

B8 closed: shipped capture/store code and reproducible checkpoint tests replace the old spike measurements. B12 (new): exact status locator failed when dirty text shared its parent; split the status into a separate span, regression passes. B13 (new): file symlink could expose .env bytes; fail excluded targets, regression passes. B14 (new): multiple windows could fork a chain; single writer with a regression and dead-process recovery test.
