# Multi-page preview and per-page element picking

Introduced on the `feature/multi-page` branch (0.9.0).

## What changed

- The panel shows a **Page** dropdown listing previewable pages: static HTML
  files discovered in the workspace (root `index.html` is `/` and sorts
  first), the configured `scrubline.previewRoute`, and any custom routes added
  through **Add page route…**. `node_modules`, hidden directories and common
  build outputs are skipped; discovery is capped at 200 pages and 8 levels.
- Selecting a page switches the active page. Scrubbing, Render history, Play,
  Open preview and Recheck all run against that page's route. Each page keeps
  its own render cache, because the cache key already binds the route;
  switching pages clears the in-memory rendered list but keeps both pages'
  cached screenshots on disk.
- The active page is remembered per workspace (`scrubline.activePage`) and
  survives panel reloads, extension restarts and settings refreshes. Custom
  routes persist in `scrubline.extraPages`.
- New or deleted `.html` files refresh the dropdown live.

## Cherry-picking on every page

- **Pick on page** opens the saved checkpoint rendered at the active page's
  route and maps the clicked element into that page's HTML document, whichever
  page is selected.
- **Hidden element ID** now defaults its document to the active page when that
  document is tracked in the checkpoint; the manual picker remains otherwise.
- **React framework pages get element-level cherry-picking.** When the
  active page has no tracked static HTML document (a framework route like
  `/dashboard`), Pick on page reads React development metadata from the
  clicked element's fiber: `_debugSource` on React 18 and earlier, the
  `_debugStack` creation-site stack on React 19. Bundle positions are
  resolved through the bundle's source map, fetched only from the local
  loopback preview origin. The matching JSX element is located in the
  tracked source file by TypeScript AST, and only its subtree (content,
  props, inline styles) is carried; external CSS and component internals
  stay current.
- **Element identity is strict.** The element is carried only when its
  component name and the component's full tag skeleton are identical in
  both checkpoints. Structural reorders, duplications, moves and renames
  change that identity and are refused. A swap of same-tag siblings
  (two buttons, three list items) leaves the skeleton unchanged, so such
  siblings are disambiguated further: when the picked element has an id
  or key, the element at the same position in current source must carry
  the same one; without id or key, its text must still match. Any
  disagreement refuses the pick rather than risk restoring onto the
  wrong sibling.
- **Dependency guard is presence-only.** Copied JSX that references
  identifiers not available in the current component or file is refused,
  naming the missing ones. A same-named binding whose meaning changed
  (a rewritten handler, a recomputed constant) is not detectable, so the
  review callout names every referenced identifier and those resolve to
  the current code, not the historical versions; the build/test gate
  then runs as usual.
  Untracked, absolute or outside-workspace source paths are refused.
- **File-level fallback remains for everything else.** Production builds
  carry no debug metadata, and non-React frameworks (Vue, Svelte, ...)
  have no metadata reader: Pick on page there automatically switches to
  exact-file selection from the checkpoint's changed files, using the same
  reviewed, conflict-guarded selective apply as Changed paths. Refused
  element picks also offer **Pick files instead**. So every page in the
  dropdown has a working cherry-pick: element-level on static HTML and
  React development builds, exact-file level otherwise. File-level
  candidates are the checkpoint's changed files, not filtered to the
  selected page's route. Main-timeline checkpoints compare against their
  parent; alternative checkpoints against their fork base. Every
  selection is reviewed as exact paths with conflicts shown and must be
  confirmed before apply, with the configured build/test gate and Undo.
- All existing element-eligibility limits are unchanged and apply per page:
  ambiguous identity, duplicate IDs, script-bearing pages, framework-generated
  DOM, embedded stylesheets and stylesheet-list changes are refused at
  element level, and shared CSS stays current. The pre/post apply
  build-test gate is unchanged. File-level cherry-picking restores whole
  files, not elements, and refuses when both sides changed the same file.

## Limits

- Page discovery sees static `.html` files only. Framework routes that exist
  purely in code (React Router and similar) are not detected; add them with
  **Add page route…**.
- Framework element picking is verified for React development builds only:
  React 18.3.1 (via `_debugSource`) end to end in a real browser, and
  React 19.3.1 (via `_debugStack`) at fiber, stack-parse and source-map
  level. It requires the JSX dev transform and source maps. Production
  builds, minified bundles without maps and non-React frameworks fall back
  to file-level cherry-picking.
- Discovery caps (200 pages, depth 8) mean very large sites can miss deeply
  nested pages; add those routes manually.
- Switching pages during an active render cancels it; the cancelled page's
  cache is intact and the render can be restarted.

## Verification

- Unit: route/document mapping, nested discovery, exclusions, empty workspaces,
  pickable-document detection for the element/file fallback decision,
  parent-base resolution for main-timeline cherry-picks, source-map decode,
  JSX extraction, reorder/duplicate/moved-element refusals, same-tag sibling
  swap refusal (unchanged skeleton, id and text variants), id-matched
  sibling edit acceptance, source path ambiguity refusal, dependency guard
  and end-to-end framework candidates.
- UI (framework): a real React 18 dev bundle served over HTTP, picked in
  Chromium: fiber metadata extraction, exact JSX element resolution from
  source positions, and component-created elements resolving to their own
  component source.
- UI: dropdown rendering and option order, `set-page` / `add-page` messages,
  hidden-until-known behavior, axe accessibility, evidence screenshot
  (`docs/evidence/panel_page_select.png`).
- Not run for this change: the VS Code extension-host suite and the headed
  Chromium picker window (require a display); Windows CI gates.
