# M2: Preview, read-only scrub and reviewed restore

## Implemented

- Trusted local preview command, configured port and bounded startup timeout. No command or browser installed automatically. PORT and {port} select the isolated process port. Windows taskkill /T shuts down the process tree; Unix process groups do the same.
- Historical checkpoints materialize under extension storage, never as a workspace checkout. Separate process, serial preview queue, source-hash isolation test. Missing command/dependencies can fall back to a previously captured screenshot labelled Screenshot. Without a screenshot, a visible preview error remains.
- Optional installed Chromium path captures checkpoint-ID-bound screenshots through playwright-core. Browser download occurs in tests/CI only, not extension runtime. Default preview is off until a command is configured. Each new stable checkpoint can render in an isolated copy when a panel is attached and configuration permits it.
- Native keyboard range with Prev/Next, persisted selection and bounded one-row timeline. Scrubbing only renders isolated copies; it does not restore files. Open preview opens the active loopback URL in the browser.
- Review shows the exact file set; confirm action is separate from review. VS Code diff opens base-to-disk and base-to-selected views for three-way comparison. Drift blocks restore. Dirty editor buffers block review/apply.
- Safety checkpoint first, staged target bytes, persistent transaction journal and per-path backup. Exclusive file creates avoid replacing concurrent creates. Checks reject changed files before and after writes. On failure, backups restore only files still matching transaction output; concurrent bytes are preserved and unresolved recovery blocks further actions.
- Undo applies the safety checkpoint only if workspace bytes still match the completed restore, even when a watcher already captured later edits. Restart recovers interrupted transactions before capture begins.

## Verified in Linux

30 Vitest tests across history/hooks/restore/preview/crash. Restore then Undo exact bytes, unchanged ignored .env, drift and dirty buffers, late concurrent edits, symlink blocking, two distinct historical renders with unchanged workspace hashes, port busy/process failure/timeout/trust, screenshot fallback. Kill tests interrupt a restore after backup and after writing and verify safety bytes on recovery.

15 Playwright checks across all panel states including preview/rendering/error/review/conflict/Undo, keyboard Home/End, concise default visible copy and axe zero serious/critical. Reduced-motion disables transitions. Actual historical screenshots and 280px panel screenshots inspected. Real VS Code 1.96.4 host test verifies watcher capture, review/apply/Undo and panel command. Build/typecheck/lint/format/no-placeholder all pass locally. Windows CI must verify this milestone after publication.

## Honest limits

- Process-crash journal recovery is covered; power-loss durability and concurrent adversarial writers are not claimed. Node provides no portable filesystem compare-and-swap. A writer deliberately changing a file during the final microsecond check/write gap cannot be fully excluded. Unexpected concurrent bytes cause a stop/recovery state rather than an overwrite during rollback.
- Isolated cwd is not an OS sandbox. User-configured project commands may access arbitrary filesystem/network resources. Configure commands that use workspace-relative output, not absolute writes. Untrusted workspaces never launch commands. Dependency-heavy projects may not reproduce without excluded dependencies; screenshot fallback is labelled.
- Screenshots are optional: no browser download at runtime, set scrubline.chromiumPath to an installed Chromium executable. The panel embeds the screenshot, not running project code; Open preview shows the active local rendering. Per-snapshot thumbnail scheduling is serial and not yet performance-tuned (M6).
- Undo availability is session-local. History persists and any checkpoint can still be reviewed after restart. A recovery conflict requires preserving edits and resolving recovery before further restore.
- Native diff uses empty content for an absent side and supports binary diff behavior of the host. No custom merge UI or automatic conflict resolution.
- The final professional UI/animation release gate is M6. Current M2 structure is functional, reduced-motion aware, not presented as final polish.

## Bugs fixed with regressions

B17: Undo previously used the newest observed checkpoint and could overwrite a later captured edit. Undo now compares against the completed restore, regression passes.
B18: restore interruption between copy and journal update could leave a created file during recovery. Durable write intent precedes copy, with kill-process regressions.
B19: slider selection and one-row page could disagree. Choosing via keyboard now updates row page, UI regression checks selection.

## Packaging/publication

playwright-core is a pure-JS runtime dependency and is included in VSIX; the UI icon library is bundled. Tests and VS Code download are excluded. Evidence PNGs remain in the binary patch because the remote upload form returned HTTP 400 in M1. Do not delete original binary assets when auditing the tree. Check both filenames and all contents, not just intended text files.
