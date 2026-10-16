# Backend visuals

Adds a **Backend** tab to the checkpoint panel showing what the page asked of
its backend during rendering, plus static backend-structure views derived from
the workspace source.

## What it shows

- **Waterfall** — the HTTP(S) requests the renderer issued while rendering
  the checkpoint (method, URL path, status, duration), oldest first, capped at
  `scrubline.backendMaxRequests` per render. Observed from the real Chromium
  renderer via page request events, so it reflects the browser's view: it is
  not evidence of server-side behavior, database access, or ordering beyond
  what the browser observed. WebSocket/SSE traffic and requests served
  entirely by a service worker are not captured; requests fired after the
  screenshot (lazy or interaction-triggered) are absent. The same bounds are
  stated in the artifact's own coverage field.
- **Routes** — API-style routes declared in the workspace source, from a
  static scan of common frameworks (Express-style `.get`/`.post`/..., fetch
  and axios call sites, and similar literal patterns). Static analysis only:
  dynamic or computed routes are not listed, and listed routes are not proven
  reachable at runtime. Where a scanned route matches an observed request path
  it is marked **observed**; everything else is marked **static**.
- **Import graph** — a diagram of backend-ish source files and their import
  edges. This is the static import structure, not runtime execution flow.
- **Diff vs parent** — request-count comparison against the parent checkpoint
  (added, removed, and changed endpoints), useful for spotting when an edit
  changed which backend calls a page makes.

The waterfall scrolls internally at narrow panel widths so rows stay readable
instead of compressing into each other.

## Privacy and redaction

Capture is metadata-only by design. For each request the artifact stores the
method, host, URL **path segments**, status, timing and protocol — never
response or request bodies, headers, cookies, or query parameter values.

Path segments and query keys are heuristically redacted: segments that look
like tokens (JWTs, UUIDs, long hex, high-entropy strings) are replaced with
placeholders, and common secret-looking query keys (`token`, `key`, `secret`,
`auth`, `sig`, ...) keep their name but drop their value.

**Honest limit:** this redaction is heuristic. A path or query key that does
not match the token patterns can still carry an identifier or secret. The
artifact stays in the extension's workspace-scoped storage under the editor's
user-data directory (outside the project folder; see Storage below), and this
feature does not upload it anywhere - but rendering itself executes live
network requests, and the file should not be treated as guaranteed
secret-free. Requests with userinfo
in the URL are rejected outright (never recorded). Fragments are never sent
over the wire, but the recorder strips them regardless.

Capture is bounded: at most `scrubline.backendMaxRequests` requests per
render (default 200, maximum 1000); when the cap is hit the artifact is marked
truncated. Same-origin entries are distinguished from third-party hosts.
Failed and aborted requests are recorded with a fixed-vocabulary failure class
(`failed` or `aborted`) rather than silently dropped; the class never includes
server-provided text.

Webview rendering escapes all captured strings before inserting them into the
panel (no raw HTML from capture data).

## Settings

- `scrubline.backendCapture` (default `true`) — record the backend artifact
  alongside each render screenshot.
- `scrubline.backendCaptureFilter` — optional glob (for example
  `**/api/**`); when set, only requests whose URL matches are recorded.
- `scrubline.backendMaxRequests` (default `200`, maximum `1000`) — per-render
  request cap.
- `scrubline.backendDiagrams` (default `true`) — compute the routes and
  import-graph views.

## Storage

The sanitized artifact is written next to each render screenshot as
`screenshots/<renderKey>/<checkpointId>.backend.json` inside the extension's
workspace-scoped storage (VS Code `storageUri`, falling back to
`globalStorageUri`, keyed by a hash of the workspace path). That storage lives
under the editor's user-data directory, outside the project folder, so the
artifact never enters the user's git repository and cannot be committed by
accident. Interactive renders and pre-rendered history both land there; the
panel reads that file on demand, computes the static route scan, import graph
and parent diff, and caches the result per checkpoint.

## Evidence

- `docs/evidence/backend_panel_wide.png` — Backend tab at a wide panel.
- `docs/evidence/backend_panel_narrow.png` — the same tab at a narrow width
  with internal scrolling.

## Not included

- Historical backend replay (re-running old server states) is out of scope.
- The routes view and import graph do not model runtime behavior; the
  waterfall does not prove server or database causality.
