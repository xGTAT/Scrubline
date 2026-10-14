# Scrubline

A local source timeline for agent-edited frontends. Capture disk checkpoints, inspect rendered history, review changes, restore selected files or eligible static HTML elements, and Undo without guessing which source produced a screenshot.

## Install 0.8.7

The unsigned VSIX is in [`releases/scrubline-panel-0.8.7.vsix`](releases/scrubline-panel-0.8.7.vsix). In VS Code or Antigravity, run **Extensions: Install from VSIX**, choose the file, then reload the IDE. Open a trusted, single-folder workspace and run **Scrubline: Open Timeline Panel**.

0.8.7 includes the stable MCP runtime update from 0.8.5, review/menu fixes from 0.8.6, mouse element picking, and decoded-frame navigation without screenshot crossfades. Slow scrubbing, Prev, Next and Play all use the same renderer. The last complete image stays visible while the requested image loads; stale decode results cannot replace newer requests. Screenshot transitions are intentionally instantaneous after decoding, avoiding overlapping text and moving crops. Optional change highlights remain available.

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

This first version supports static HTML source, including elements with no ID. The clicked DOM path identifies the saved source node; tag, stable attributes and ancestor identity must map uniquely into current source. Unrelated current markup stays current. Content and inline styles travel with the subtree. Simple tag/class/ID descendant rules in linked local CSS travel only when every matched element belongs to that subtree. Shared rules must be unchanged, and owned selector order must match; replacements stay at their original CSS positions.

Use the secondary **Hidden element ID** path for source elements you cannot point to on the page. Choose the tracked HTML file and a unique ID without `#`.

Safety limits: ambiguous/missing identity, duplicate IDs, script-bearing pages, active selected markup, framework-generated DOM, embedded stylesheets, stylesheet-list changes, complex selectors, CSS at-rules, shared custom properties/URLs and differing shared CSS are refused. Inherited shared styles remain current. This is not arbitrary React/Vue/component rollback. The older standalone navbar prototype and whole-file review remain available. See [Alternatives notes](docs/m4-branches-selective.md).

## Alternatives and layout investigation

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
node scripts/verify-packaged-mcp.cjs scrubline-panel-0.8.7.vsix
```

The extension-host test downloads VS Code and needs a display (`xvfb-run` on Linux). Windows CI runs the portable checks. 0.8.7 was also tested in Antigravity on Linux against `xGTAT/web-lab` source `299a8e6cfc2b810d8a4f4ba2793c100bee8bb7a5`: no-ID navbar mouse selection, content/CSS restore with newer footer retained, Undo, slow navigation, rapid seeks, and Play. Checked-in navbar image fixtures support the ghost-layer regression; they are test data, not an external-state guarantee.

- `spikes/host-panel`: extension, panel, storage and tests
- `fixtures`: test sites and captured regression images
- `.agents`: sanitized hook recorder; [configuration](docs/hooks.md)
- `docs`: implementation limits and milestone notes
- `releases`: locally installable VSIX builds
