# Scrubline

A local source timeline for agent-edited frontends. Capture disk checkpoints, inspect rendered history, review changes, restore selected files or eligible static HTML elements, and Undo without guessing which source produced a screenshot.

## Install 0.8.10

The unsigned VSIX is in [`releases/scrubline-panel-0.8.10.vsix`](releases/scrubline-panel-0.8.10.vsix). In VS Code or Antigravity, run **Extensions: Install from VSIX**, choose the file, and follow any IDE reload prompt. Open a trusted, single-folder workspace and run **Scrubline: Open Timeline Panel**.

0.8.10 restores continuous, full-frame 200ms dissolves between cached decoded screenshots. The page does not reload during cached scrubbing. One canvas blends the current visible composite toward the next screenshot; an interrupted fade starts from those on-screen pixels, not an older unblended frame. There are no moving element crops, local masks or fade-through-background steps. The compositor is removed after completion, leaving the exact decoded screenshot.

A true dissolve briefly blends both versions, including changed text, during the transition. This natural overlap is different from persistent ghost layers or misaligned moving crops; it cannot be eliminated while retaining a full-frame crossfade. Identical images, reduced motion and mismatched dimensions use immediate decoded swaps. Cached playback requires Render history first; uncached interactive preview can still start a preview process. Optional change highlights remain available.

### Updating in Antigravity

New activations drain the old capture queue, release its writer, close previews and dispose old commands/webviews before taking ownership. A same-IDE-session endpoint handoff also handles separate extension-host instances. A different IDE window cannot take over an active writer.

The already-installed 0.8.7 runtime cannot gain this handoff protocol retroactively. When upgrading from that older build, one **Developer: Reload Window** may still be needed. Later updates between handoff-capable builds do not require a full IDE quit/restart for Scrubline's writer ownership. If the IDE itself asks for a window reload to load extension code, follow that prompt; Scrubline cannot override the IDE's installer lifecycle.

## Capture and preview

- Baseline and disk-save checkpoints, bounded debounce, hash reconciliation, `.gitignore` and built-in exclusions.
- SHA-256 blobs and versioned manifests outside the repository, restart recovery, changed paths and explicit unsaved-buffer warnings.
- Attribution is Unattributed unless an exact-content hook record matches. A checkpoint is not proof of who authored an edit.

Configure workspace settings:

```json
{
  "scrubline.previewCommand": "node server.cjs --port {port}",
  "scrubline.previewPort": 4100,
  "scrubline.chromiumPath": "/path/to/installed/chromium",
  "scrubline.previewRoute": "/navbar.html",
  "scrubline.previewWidth": 960,
  "scrubline.previewHeight": 600,
  "scrubline.postApplyCommand": "npm test"
}
```

Use a command appropriate for your project. `{port}` and the `PORT` environment variable carry the selected port. Optional `scrubline.previewReadySelector` waits for a unique visible element before capture. No browser is downloaded at runtime.

**Render history** prepares local screenshots. Scrub, Prev, Next or Play through cached history; missing frames render on demand. **Open preview** explicitly opens interactive source. Render receipts bind evidence to source, route, viewport and browser/runtime. Two fresh probes can check repeatability, not freeze dependencies, backends or time.

Preview commands run in disposable historical folders, but are not OS security sandboxes. Excluded dependencies and external state are not captured. Only run trusted commands. See [preview and restore notes](docs/m2-preview-restore.md).

## Review, restore and Undo

**Review restore** shows exact paths before confirmation. Breakpoint history's **Open checkpoint for review** opens that same review. Unsaved buffers, source drift, unsafe paths and concurrent changes block writes. Undo refuses intervening edits.

Confirmation lives directly under Review, before forks, and is viewport-bounded. Render history and Alternatives use mutually exclusive sections to reduce panel crowding. Tools are disclosed when needed rather than removed.

## Pick an element from a saved webpage

1. Select a saved checkpoint, open **Changed paths**, and choose **Pick on page**. Each saved Alternative also offers **Pick on page**.
2. A local Chromium window opens the saved webpage at the configured preview route. Hover to see the target boundary and click the element to keep. Escape stops picking.
3. Return to Scrubline, inspect **Files** and the exact diff, then **Confirm restore**. A configured build/test command must pass before and after selective apply. Undo restores the previous bytes.

Static HTML source elements can be picked without IDs. The exact clicked source node is resolved first. Unique IDs or stable semantic anchors can map into current source even when ancestor CSS classes changed; repeated headings/cards use their source position only when the tag/ID skeleton is unchanged. Ambiguous structural drift is refused rather than silently selecting another card. Unrelated current markup stays current.

Content and inline styles travel with the subtree. Complete SVGs and self-closing SVG shapes are supported. Paired, unambiguous local CSS rules travel only when each rule matches elements exclusively inside the selected subtree in both versions. This includes common selectors and scoped `@media`, `@supports`, `@container` and `@layer` rules; their positions and conditions stay intact.

Shared CSS changes no longer veto every pick. Shared rules, theme variables, unmatched/unsupported rules and unrelated current edits stay current. The review states this limit before confirmation: a selective element restore is not a promise of the complete historical appearance. Use whole-file review if you intend to restore shared styling too. A matching element with no content or paired exclusive-style delta shows a no-change review with confirmation disabled.

Use the secondary **Hidden element ID** path for source elements you cannot point to on the page. Choose the tracked HTML file and a unique ID without `#`.

Safety limits: ambiguous/missing source identity, duplicate IDs, script-bearing pages, active selected markup, framework-generated DOM, embedded stylesheets and stylesheet-list changes are refused. Shared and unsupported rules are preserved, not silently rolled back. Complex dynamic selector ownership and arbitrary React/Vue/component rollback are not claimed. Whole-file review and the older standalone navbar prototype remain available. See [Alternatives notes](docs/m4-branches-selective.md).

## Alternatives and layout investigation

Alternatives are saved forks, not automatically generated suggestions. **Fork checkpoint** creates another; **Capture** updates the selected fork. The list has no two-item cap. **Compare** intentionally shows two images: the current workspace and one selected alternative. Other saved alternatives remain in the menu for picking, inspection or a separate comparison. If your menu still shows only two after creating more forks, that specific state needs investigation; it was not reproduced on the Studio test workspace.

Fork a saved checkpoint into a separate folder, capture edits, compare rendered results, and choose files or an eligible element for review. Branch/base/saved identities distinguish same-name alternatives. Fork folders are not security sandboxes; dependencies and backend state are not cloned.

Render history contains opt-in breakpoint/history sampling, bounded static-CSS culprit investigation and guarded inverse rollback. Pass/fail/unknown results describe the approved assertion at sampled widths, not universal correctness. Measured repair packets are reviewed text for manual paste, not automatic repairs. General hunk/framework apply and replay export are not shipped.

## Visual context and Local MCP

**Select element** is the separate visual-context workflow: point at the rendered page, review a redacted packet, then copy it for manual paste. Sanitized crops are not exact page pixels. Stale selectors are refused. See [targeting notes](docs/m3-targeting-context.md).

**Scrubline: Start Local MCP** generates client configuration. MCP can list checkpoints and request restore review, never apply files. The runtime is copied to stable global storage on activation, so extension upgrades do not invalidate a versioned extension-directory path. If your existing client configuration points inside an old extension version, replace it once with the newly generated configuration and restart that MCP client.

## Storage and limits

History is bound to the canonical folder path; moving a folder starts a new binding. Old unbound history is not silently assigned to a new workspace. Retention keeps checkpoints until explicit deletion. **Compact unused history data** removes orphan blobs; **Delete workspace history** erases the bound store after confirmation. Additional exclusions use `scrubline.ignoreAdditions`. No telemetry. Private/UNLICENSED; marketplace publication and license choice remain the owner's decision.

## Build and test

```bash
cd spikes/host-panel
npm ci
npm run typecheck
npm run lint
npm run format
npx playwright install chromium
npm test
npm run build
npm run check:nomock
npm run test:ui
npm run test:host
npm run package
node scripts/verify-packaged-mcp.cjs scrubline-panel-0.8.10.vsix
```

The extension-host test downloads VS Code and needs a display (`xvfb-run` on Linux). Windows CI runs the portable checks. 0.8.10 was tested on the actual Studio route in Antigravity: slow Prev/Next, 16 rapid inputs and Play settled on the expected cached frames, using at most one compositor and none after settling. Midpoint and final screenshots were inspected. Four separately created alternatives were visible in the real menu; tests cover six fork/capture/reopen entries and six accessible picker entries. The earlier Studio picker/Undo checks and source regressions remain.

Source tests cover SVG shapes, repeated elements and current shared-CSS preservation. UI tests cover full-frame intermediate blending, interrupted seeking, compositor cleanup, reduced motion and six-entry Alternatives rendering. Native Antigravity host tests cover activation, replacement ownership, capture, render, review/apply/Undo and panel reopen. These tests do not establish behavior for the owner's exact unshared checkpoint history or every framework page. Checked-in webpage/image fixtures are regression data, not an external-state guarantee.

- `spikes/host-panel`: extension, panel, storage and tests
- `fixtures`: test sites and captured regression images
- `.agents`: sanitized hook recorder; [configuration](docs/hooks.md)
- `docs`: implementation limits and milestone notes
- `releases`: locally installable VSIX builds
