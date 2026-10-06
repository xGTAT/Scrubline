# v0.7 local playback

Render history prepares ordinary timeline checkpoints sequentially. Existing cache hits are reused. Scrubbing cached frames does not launch a preview command or Chromium. Play advances prepared screenshots every750ms, preloads the adjacent frame, and stops at the end, a missing frame, manual selection or a hidden tab. Interactive Open preview remains explicit.

Progress reports processed frames and failures. Cancel finishes the current bounded frame, discards its result, stops its process and leaves previous completed frames available. It is not instant cancellation of a browser startup. New captures do not steal the selected checkpoint and are not automatically pre-rendered.

Command, Chromium path, renderer version, viewport and timeout form the cache identity. Changing preview settings refreshes the runner and invalidates stale images without reopening. Settings use the active folder even in a saved workspace. Clear render cache deletes only render generations; snapshots and legacy screenshots stay. Cached generations total at most200MB and refuse further writes rather than silently evicting frames. Background render scratch screenshots are removed after the batch. Commands should use PORT or {port}; the background renderer uses previewPort+3.

The selected card, slider, Changed paths and screenshot refer to one checkpoint. Changed paths is the delta from its parent, not the complete snapshot inventory. Preview errors are visible in the panel and Scrubline Output.

History storage is bound to the canonical folder path. Unbound history from older versions is preserved at its old location and is not guessed into a current folder. v0.7 begins new folder-bound history and reports this in Output and an information notice. Moving/renaming a folder also starts another binding. No automatic migration or history deletion occurs.

## Verification

Local source and installed unsigned VSIX checks include unit/FS/render/cache/scoping tests, UI/axe tests at narrow width, and VS Code host activation, real pre-render PNG persistence/reuse, saved-workspace folder settings, cancellation, settings invalidation and recovery, MCP review-only, restore/Undo and alternatives. Windows CI is a separate release gate and must be checked before claiming completion.

## Limits

Still screenshots, not captured interaction/video. Historical commands use isolated working directories, not an OS sandbox. Excluded dependencies, APIs and nondeterminism can prevent an exact historical render. Render history needs configured command and installed Chromium. Cached content does not prove Antigravity compatibility or owner-hardware performance. See M6 release notes for retained human checks. Replay sharing remains deferred.
