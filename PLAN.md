# Scrubline: research verdict and implementation plan

*Prepared September 25, 2026. A build handoff for Antigravity IDE.*

## Verdict

Build the timeline, but change its foundation. The proposed TypeScript extension, React panel, file watcher, checkpoints and local metadata store can deliver a useful MVP. **They do not deliver lossless agent-event replay, continuous visual morphing, reliable per-prompt blame or general element-level cherry-pick.** Source snapshots, not DOM events, must be the authority. Keep the agent as an independent editor and reconcile its disk writes. The distinctive product is rendered review with safe, selective application, not merely another undo slider.

Two corrections to earlier guidance:

1. Antigravity **does document hooks**: `PreToolUse`, `PostToolUse`, `PreInvocation`, `PostInvocation`, `Stop`, including conversation IDs and known file-edit tool names. Test them as an optional source of attribution, not as proof that every changed byte was captured. [Antigravity hooks](https://antigravity.google/docs/ide/hooks/).
2. No documented third-party API has been established for submitting prompts into the Antigravity IDE chat or for running a VS Code extension *inside Antigravity Desktop*. Google's [IDE extensions page](https://antigravity.google/docs/ide/extensions/) is primarily Antigravity **as an extension inside other editors**. Do not promise automatic paste, session pairing or a native desktop panel before an installation/API compatibility spike. A VS Code extension alongside Google's Antigravity extension is a plausible fallback. Hooks or an [MCP plugin](https://antigravity.google/docs/ide/mcp/) can complement it, not replace that proof.

## What exists nearby

| Product | Already does | Scrubline must do differently |
| --- | --- | --- |
| [VS Code chat checkpoints](https://code.visualstudio.com/docs/chat/chat-checkpoints) | Per-chat-request source snapshots, restore/redo, fork conversation. | Show the rendered app at each saved state, and apply a reviewed selection safely. |
| [VS Code Timeline](https://code.visualstudio.com/docs/sourcecontrol/history) | Git commits and local saves for individual files. | Project-wide, rendered multi-file change history rather than file-only history. |
| [Playwright Trace Viewer](https://playwright.dev/docs/trace-viewer) | Time slider with DOM snapshots for recorded test actions. | Work during normal agent editing and return a chosen version to the project. |
| [Storybook/Chromatic visual testing](https://storybook.js.org/docs/writing-tests/visual-testing/) | Compare rendered component screenshots to baselines. | Interactive exploration and review of successive agent edits, not just visual regression. |
| [Git worktrees](https://git-scm.com/docs/git-worktree) | Isolated branch working directories. | Use as a mechanism for independent preview and alternatives, not as the full UX. |

Do not market "timeline" or "branching" alone as novel. Validate the harder rendered-selective-apply UX with users before building a server.

## Revised architecture

- **Host:** TypeScript extension host plus a React/TypeScript [webview](https://code.visualstudio.com/api/extension-guides/webview) for the history panel. First verify whether the installed Antigravity desktop loads a third-party VS Code-style extension. If not, build the extension for supported VS Code and run Antigravity's VS Code integration beside it, while exploring a separate Antigravity plugin with hooks. Do not depend on undocumented internal APIs.
- **Capture:** use workspace file watchers **and** editor save/document events, then debounce bursts, scan relevant files and hash content to reconcile missed/coalesced events. Include create, rename, deletion, unsaved-buffer policy, external writes and atomic file replacement. Respect `.gitignore` plus a Scrubline exclusion list; exclude `node_modules`, builds, `.git`, secrets and its own store. Confirm symlinks stay inside workspace. Capture source files and needed public assets, not dependencies. Label snapshots "on disk" versus "unsaved changes not captured". A bounded size/file limit with visible warnings is mandatory.
- **State model:** immutable, content-addressed file blobs and a checkpoint manifest (path, hash, mode, timestamp, parent ID); SQLite for checkpoint/event metadata and transaction integrity, with a schema version and crash recovery. SQLite [WAL](https://sqlite.org/wal.html) is an implementation option, not a substitute for syncing blob writes and manifest commits. Keep metadata/blobs in extension-controlled user storage, outside the repo; optional export, retention policy and quota settings. Git may remain the user's source control, never hidden commits or `git add .`.
- **Agent correlation:** hooks can add `conversationId`, tool name, step index and completion boundaries, if actual installed behavior verifies payloads and availability. Independent manual edits must show "unattributed". A prompt entered into Scrubline should generate a copyable, selected-element context packet. **Manual copy/send to Antigravity** until a supported submission API is proved. Never infer exact prompt ownership from mere timestamp overlap.
- **Preview:** a trusted-workspace local dev server, explicit command/port selection, bounded startup, status/error panel. Live preview of current workspace is straightforward; historical rendered preview requires an isolated snapshot/worktree with its own process/port or a deliberately labeled captured screenshot fallback. Treat screenshot and source state as linked artifacts but not interchangeable. Keep historical preview scripts from modifying current files. Capture viewport, route, relevant app data and whether the rendering failed; avoid claiming deterministic pixel replay when remote APIs, fonts or random data differ. [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust) should gate code execution.
- **Review and restore:** scrubbing must be read-only. Show checkpoint, changed file list, time and attribution confidence. "Apply" compares the current manifest with the last observed manifest; if files drifted, show a three-way conflict and stop. Before any apply, save a recoverable safety checkpoint; write changes transactionally where possible, handle deletion/rename, reload preview and offer Undo. Never overwrite changes without an explicit conflict decision.
- **Animation:** adjacent rendered states can fade or use [View Transitions](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using) when element identities and layouts match. If not, use immediate change/crossfade. CSS/FLIP is presentation only; it cannot reconstruct earlier source. Honor reduced-motion settings. Do not promise continuous animation through every intermediate agent token.
- **Cherry-pick:** DOM diffs alone cannot tell which React component, CSS declaration, asset or shared state owns an element. For v1, support a narrow static HTML/CSS fixture or a demonstrably mapped single component with source ownership, then three-way diff, explicit conflict review, rebuild and tests. Otherwise offer file/hunk-level apply. No silent multi-element "smart merge" promise.
- **Sharing:** no remote service in MVP. For a later replay, publish only a scrubbed, explicit export of selected screenshots/metadata; exclude project source, local URLs, API payloads, secrets and prompts by default. Expiring links, deletion and recipient access need design before any upload.

## Milestones for Antigravity to implement

### 0. Feasibility spike: host and boundaries

Create a disposable sample web project and test: (a) install a minimal third-party extension in the user's Antigravity desktop; (b) if unsupported, install the extension alongside Google's Antigravity integration in VS Code; (c) configure a `PostToolUse`/`Stop` hook and inspect real payloads for file-edit and command writes; (d) test browser preview isolation for two source snapshots. Record exact IDE versions, supported API, screenshots and failures in `docs/feasibility.md`. Decide the actual host from evidence, not branding. **Done when:** a real extension panel opens in a supported host, an Antigravity edit produces a trustworthy disk checkpoint, and no test writes into the original project during historical preview. If the desktop extension fails, switch to the VS Code host explicitly.

### 1. MVP A: reliable source timeline

Scaffold extension host, typed event/checkpoint schema, blob store and SQLite metadata. Implement baseline capture, watcher reconciliation, bounded debounce, ignore rules, file limits, schema migration and crash recovery. Show checkpoint cards with timestamps, changed paths and source hashes. Distinguish manual edits from verified hook attribution. Unit/integration tests: rapid multi-file edits, rename, delete, atomic replacement, missed watcher notification, large/binary asset, unsaved buffer, crash mid-write, restart, Windows paths. **Done when:** every accepted checkpoint restores the exact tracked bytes after restart; exclusions are honored; failures are surfaced, not silently skipped.

### 2. MVP B: live preview, read-only scrub and safe restore

Launch configured dev server only in a trusted workspace; show current live preview and errors. Capture a thumbnail of each stable checkpoint and bind it to manifest ID. Make slider load these historical thumbnails first. Test isolated historical rendering on the sample app; use it where reproducible, otherwise keep a clearly labeled screenshot view. Add review UI, changed-file comparison, Apply/Undo with safety checkpoint and drift/conflict detection. Preserve current source while moving slider. **Done when:** a user watches an agent edit, sees ordered rendered states, selects an earlier one, reviews affected files, restores it and undoes the restore; a concurrently edited file triggers a conflict instead of data loss. This is the first shippable demo.

### 3. v0.2: visual targeting and useful explanations

Add click-to-select on same-origin local preview via an opt-in injected overlay or browser automation, returning a stable selector, accessible name, DOM snippet, route and screenshot crop. Do not rely on screen coordinates alone; selectors can become stale and component source mapping is best-effort. Produce a copyable prompt packet for manual paste into Antigravity. Add deterministic "changed files + visible area" summary; one-line natural-language narration is optional and must cite the source diff, never invent hidden agent reasoning. **Done when:** a selected button is highlighted, packet is accurate and redacts private data, editing it yields a new checkpoint, and a stale selector is reported rather than targeting another element.

### 4. v1: branch comparison and narrow selective apply

Use manifests with parent pointers for lightweight branch graph. For parallel agent activity, use isolated Git worktrees only for clean Git-backed projects after testing untracked/ignored file handling; otherwise use isolated snapshot copies and clearly label limitations. Show two rendered alternatives side by side. Implement source-level hunk apply, then element apply **only** for tested static HTML/CSS or explicitly mapped component ownership. Three-way merge and post-merge build/tests are required; reject unresolved conflicts. **Done when:** alternatives do not touch each other's original workspace, choosing one does not erase the other, a supported navbar change can be applied without replacing the footer, and an ambiguous CSS/shared-component case is blocked with explanation.

### 5. Later: replay export and refined motion

Only after the local workflow proves useful: design redacted, opt-in export; expiration/deletion/access control; optional network service; playback without execution of uploaded project code. Add animation only if performance and element identity warrant it. **Done when:** replay works on another device without exposing secrets, source or private URLs and can be revoked; large timelines stay responsive and reduced-motion users get stable states.

## Antigravity handoff rules

Implement **only one milestone at a time**. For each: inspect this plan and actual installed APIs; write a small design note if the API differs; produce tests and a short demo; stop and report the "done when" result and any blocker before moving on. Do not claim unsupported native IDE integration or agent chat automation. Do not create scratch files in the repo; delete any before committing. Do not commit `.env`, generated snapshots, history blobs, credentials or a blanket `git add .`. Ask for approval before any new remote service or public share.

## Open questions to test, not quietly assume

- Does the particular Antigravity desktop build actually expose a compatible third-party extension host? The cited extensions page does **not** establish this.
- Do hooks fire for edits from all relevant tools, subagents, terminal scripts and IDE paths? Reconcile against disk; never rely on hooks alone.
- Are historical renders reproducible for this app's framework, route and API data? Screenshot fallback may be the honest MVP.
- What is the first supported framework for source-level element mapping? Pick one after an instrumented prototype; general React/HTML/CSS cherry-pick is not a v1 claim.

## Source references

[User's original Scrubline concept](https://app.notion.com/p/scrubline-idea-v2-7b14a2d1bcea82a3b10101bc5cf090b4) · [Antigravity hooks](https://antigravity.google/docs/ide/hooks/) · [Antigravity plugins](https://www.antigravity.google/docs/ide/plugins/) · [Antigravity IDE extensions](https://antigravity.google/docs/ide/extensions/) · [Antigravity MCP](https://antigravity.google/docs/ide/mcp/) · [VS Code webviews](https://code.visualstudio.com/api/extension-guides/webview) · [VS Code API](https://code.visualstudio.com/api/references/vscode-api) · [Workspace Trust](https://code.visualstudio.com/api/extension-guides/workspace-trust) · [VS Code checkpoints](https://code.visualstudio.com/docs/chat/chat-checkpoints) · [VS Code Timeline](https://code.visualstudio.com/docs/sourcecontrol/history) · [Playwright traces](https://playwright.dev/docs/trace-viewer) · [Playwright screenshot limits](https://playwright.dev/docs/test-snapshots) · [Storybook visual testing](https://storybook.js.org/docs/writing-tests/visual-testing/) · [Git worktrees](https://git-scm.com/docs/git-worktree) · [SQLite WAL](https://sqlite.org/wal.html) · [View Transitions](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API/Using).
