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
- All existing element-eligibility limits are unchanged and apply per page:
  ambiguous identity, duplicate IDs, script-bearing pages, framework-generated
  DOM, embedded stylesheets and stylesheet-list changes are refused, and
  shared CSS stays current. The pre/post apply build-test gate is unchanged.
  A page whose route has no matching static HTML document in the checkpoint
  (a server-rendered route, for example) previews and renders normally, but
  element picking refuses with an explanatory error instead of guessing.

## Limits

- Page discovery sees static `.html` files only. Framework routes that exist
  purely in code (React Router and similar) are not detected; add them with
  **Add page route…**. Cherry-picking such routes hits the refusal above.
- Discovery caps (200 pages, depth 8) mean very large sites can miss deeply
  nested pages; add those routes manually.
- Switching pages during an active render cancels it; the cancelled page's
  cache is intact and the render can be restarted.

## Verification

- Unit: route/document mapping, nested discovery, exclusions, empty workspaces.
- UI: dropdown rendering and option order, `set-page` / `add-page` messages,
  hidden-until-known behavior, axe accessibility, evidence screenshot
  (`docs/evidence/panel_page_select.png`).
- Not run for this change: the VS Code extension-host suite and the headed
  Chromium picker window (require a display); Windows CI gates.
