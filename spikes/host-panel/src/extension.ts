import { DualVerificationEngine } from './verification/engine';
import { diffPerf } from './preview/perf';
import { replaceActivation } from './lifecycle';
import { ChatbotController } from './chatbot/controller';
import { DesignAdvisorService } from './chatbot/advisor';
import { AgyCliAdvisorProvider, listAgyModels } from './advisor/agy-cli';
import { AntigravityLmAdvisorProvider, ChainedAdvisorProvider } from './advisor/lm';
import { LockRegistry } from './locks/registry';
import { ElementPicker } from './branches/picker';
import {
  composeLockedDocument,
  elementCandidate,
  extractAncestorContext,
  extractElementBySelector,
  extractElementOuterHtml,
  extractStylesheetHrefs
} from './branches/element';
import {
  frameworkElementCandidate as staticElementCandidate,
  isFrameworkDocument
} from './framework/candidate';
import {
  frameworkElementCandidate,
  resolveTrackedSource,
  resolveViaSourceMap
} from './branches/framework';
import { installMcpRuntime } from './mcp/install';
import { measuredPacket } from './targeting/measured';
import { specification, specificationKey } from './preview/spec';
import {
  listPages,
  routeToDocument,
  isPickableDocument,
  pageFiles,
  rowRelevantToPage
} from './pages';
import { prepareRollback, applyRollback, type RollbackCandidate } from './investigation/rollback';
import { investigate } from './investigation/run';
import { sweep } from './layout/sweep';
import { validateGuard, validateSweep } from './layout/types';
import { repeatability } from './preview/repeatability';
import { atomicWrite } from './store/store';
import { identifyBrowser } from './preview/spec';
import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import * as path from 'node:path';
import * as http from 'node:http';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import { RenderCache, renderKey, prepareHistory } from './preview/cache';
import { scopedStore } from './store/identity';
import { Alternatives, mainlineBase, mergeFiles } from './branches/alternatives';
import { composeCheckpoints } from './branches/multi';
import { changedPaths } from './capture/scanner';
import { scanEndpoints, matchRoute } from './backend/endpoints';
import { buildImportGraph } from './backend/graph';
import { diffCaptures } from './backend/diff';
import type { BackendCapture } from './backend/types';
import { applySelective } from './branches/apply';
import { staticSectionPaths } from './branches/static-mapping';
import {
  resolveElementFiles,
  mergeMultiElements,
  type ElementSelection
} from './branches/multi-merge';
import { McpBridge } from './mcp/bridge';
import { redact } from './targeting/redact';
import { TargetSession } from './targeting/session';
import { makePacket } from './targeting/packet';
import { envValues } from './targeting/redact';
import { Restore } from './review/restore';
import { PreviewRunner } from './preview/runner';
import { Timeline } from './capture/timeline';
import { HistoryStore, safePath } from './store/store';
import type { HostInfo } from './host-info';
import type { TimelineState, TimelineInbound } from './bridge/timeline';

export async function activate(context: vscode.ExtensionContext) {
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await cleanup?.();
      for (const d of context.subscriptions.splice(0))
        try {
          d.dispose();
        } catch {
          /* Already disposed by host. */
        }
    })());
  const unregister = await replaceActivation(close);
  shutdown = async () => {
    await close();
    unregister();
  };

  const mcpRuntime = await installMcpRuntime(
    context.extensionPath,
    context.globalStorageUri.fsPath
  );
  const hostInfo: HostInfo = {
    vscodeVersion: vscode.version,
    appName: vscode.env.appName,
    appHost: vscode.env.appHost,
    language: vscode.env.language,
    workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    extensionPath: context.extensionPath
  };
  const views = new Set<vscode.Webview>();

  // Combined-candidate preview: one render of the synthetic target, receipt
  // bound to its exact content; the label names set/order/mode. Degrades to
  // the per-file review table when no panel view exists, the runner is
  // unavailable, or the render fails. Caller publishes after.
  const renderCombinedPreview = async (
    target: import('./bridge/timeline').Checkpoint,
    count: number,
    mode: 'combine' | 'revert' | 'mosaic'
  ) => {
    const view = [...views][0];
    if (!view || !runner || !vscode.workspace.isTrusted) return;
    try {
      const rendered = await timeline!.exclusive(() => runner!.historical(target, true));
      preview = rendered.screenshot
        ? {
            status: 'ready',
            checkpoint: target.id,
            image: view.asWebviewUri(vscode.Uri.file(rendered.screenshot)).toString(),
            label: `Combined candidate: ${count} checkpoint${count === 1 ? '' : 's'} (${mode}), in selection order`,
            receipt: rendered.receipt
          }
        : {
            status: 'error',
            checkpoint: target.id,
            message: `${rendered.error ?? 'Preview unavailable.'} Review the file table.`
          };
    } catch (e) {
      preview = {
        status: 'error',
        checkpoint: target.id,
        message: `Preview failed: ${e instanceof Error ? e.message : String(e)}. Review the file table.`
      };
    }
  };
  let state: TimelineState = {
    status: 'empty',
    rows: [],
    unsaved: false,
    message: 'Open a folder to begin.'
  };
  // Panel presentation mode, persisted across reloads in globalState so the
  // user's Standard/Dev choice survives window restarts. Published with every
  // timeline so all views (sidebar, editor panel) stay in sync.
  const readUiMode = (): 'standard' | 'dev' =>
    context.globalState.get<string>('scrubline.uiMode') === 'dev' ? 'dev' : 'standard';
  let uiMode: 'standard' | 'dev' = readUiMode();
  // Seed the first published state with the persisted mode so a request-timeline
  // answered before any capture still restores the user's choice.
  state.uiMode = uiMode;
  let preview: TimelineState['preview'];
  let review: TimelineState['review'];
  let selection: TimelineState['selection'];
  /** Composition conflicts for the pending multi review; blocks apply. */
  let multiConflicts: string[] = [];
  let multiAttribution: import('./bridge/timeline').Attribution | undefined;
  let canUndo = false;
  let alternatives: Alternatives | undefined;
  let layout: import('./layout/types').LayoutMatrix | undefined;
  let cancelLayout = false;
  let cancelInvestigation = false;
  let investigation: import('./investigation/types').Investigation | undefined;
  let layoutJob: Promise<unknown> | undefined;
  let measured: TimelineState['measuredPacket'];
  let rollbackCandidate: RollbackCandidate | undefined;
  let rollback: TimelineState['rollback'];
  let selectiveTarget: import('./bridge/timeline').Checkpoint | undefined;
  let verificationReport: TimelineState['verificationReport'];
  let selectiveMeta:
    | {
        targetSelector?: string;
        documentPath?: string;
        indices?: number[];
        sourceCheckpointId?: string;
        sourceBranch?: string;
      }
    | undefined;

  /** Re-renders the open Locked Elements Preview after lock changes. */
  let locksPreviewRefresh: (() => void) | undefined;

  /** Opens a separate preview page rendering each current document with its locked elements' pinned content applied. */
  async function openLocksPreview(): Promise<void> {
    if (!lockRegistry || !workspaceRoot) {
      void vscode.window.showInformationMessage('Open a workspace with locked elements first.');
      return;
    }
    const previewPanel = vscode.window.createWebviewPanel(
      'scrubline.locksPreview',
      'Locked Elements Preview',
      vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );
    const contentType = (rel: string): string =>
      rel.endsWith('.html')
        ? 'text/html; charset=utf-8'
        : rel.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : rel.endsWith('.js')
            ? 'text/javascript; charset=utf-8'
            : rel.endsWith('.svg')
              ? 'image/svg+xml'
              : 'application/octet-stream';
    const server = http.createServer((req, res) => {
      void (async () => {
        try {
          const pathname = new URL(req.url ?? '/', 'http://locks.local').pathname;
          const rel = decodeURIComponent(pathname.replace(/^\/+/, ''));
          if (!rel || !safePath(rel)) {
            res.statusCode = 400;
            res.end();
            return;
          }
          // Isolated locked-element card: the pinned element rendered with the
          // document's own stylesheets and a highlight frame.
          const card = rel.match(/^__lock__\/(\d+)$/);
          if (card) {
            const lock = lockRegistry!.list()[Number(card[1])];
            if (!lock?.pinnedHtml) {
              res.statusCode = 404;
              res.end('no pinned content');
              return;
            }
            let links = '';
            let context = { bodyAttrs: [], open: [], close: [] } as ReturnType<
              typeof extractAncestorContext
            >;
            try {
              const docText = (
                await fs.readFile(path.join(workspaceRoot!, lock.document))
              ).toString('utf8');
              links = extractStylesheetHrefs(docText)
                .map(
                  (h) =>
                    `<link rel="stylesheet" href="/${lock.document.split('/').slice(0, -1).concat(h).join('/')}">`
                )
                .join('');
              // Keep the element's ancestor context so contextual styles
              // (colors, backgrounds) survive the isolated render.
              context = extractAncestorContext(docText, lock.selector);
            } catch {
              links = '';
            }
            const bodyAttrs = context.bodyAttrs
              .map((a) => ` ${a.name}="${a.value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}"`)
              .join('');
            res.setHeader('Content-Type', 'text/html; charset=utf-8');
            res.end(
              `<!doctype html><html><head><meta charset="utf-8">${links}<style>` +
                `body{margin:0;padding:16px}` +
                `.scrubline-lock-frame{outline:3px solid #e5a00d;outline-offset:2px;box-shadow:0 0 0 6px rgba(229,160,13,0.25);display:inline-block;max-width:100%}` +
                `.scrubline-lock-badge{position:fixed;top:6px;right:8px;background:#e5a00d;color:#000;font:600 11px/1.6 sans-serif;padding:2px 8px;border-radius:3px;z-index:9999}` +
                `</style></head><body${bodyAttrs}><span class="scrubline-lock-badge">LOCKED</span>${context.open.join('')}<div class="scrubline-lock-frame">${lock.pinnedHtml}</div>${context.close.join('')}</body></html>`
            );
            return;
          }
          const docLocksForSource = lockRegistry!.list().filter((l) => l.document === rel);
          const sourceCpId = docLocksForSource.find(
            (l) => l.sourceCheckpointId
          )?.sourceCheckpointId;
          let body: Buffer;
          if (sourceCpId && timeline) {
            // Locks were made from a specific checkpoint (e.g. an alternative
            // fork). Serve the document as it was at that checkpoint so the
            // page context matches where the locks came from, not the current
            // workspace state which may have diverged.
            const cp = timeline.store.checkpoints.find((c) => c.id === sourceCpId);
            const tracked = cp?.files.find((f) => f.path === rel);
            if (tracked) {
              body = await timeline.store.readBlob(tracked.hash);
            } else {
              try {
                body = await fs.readFile(path.join(workspaceRoot!, rel));
              } catch {
                res.statusCode = 404;
                res.end('not found');
                return;
              }
            }
          } else {
            try {
              body = await fs.readFile(path.join(workspaceRoot!, rel));
            } catch {
              res.statusCode = 404;
              res.end('not found');
              return;
            }
          }
          if (rel.endsWith('.html')) {
            const docLocks = lockRegistry!.list().filter((l) => l.document === rel && l.pinnedHtml);
            if (docLocks.length) {
              const composed = composeLockedDocument(body.toString('utf8'), docLocks, {
                highlight: true
              });
              body = Buffer.from(composed.html, 'utf8');
            }
          }
          res.setHeader('Content-Type', contentType(rel));
          res.end(body);
        } catch {
          res.statusCode = 500;
          res.end();
        }
      })();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    previewPanel.onDidDispose(() => server.close());
    const esc = (v: string): string =>
      v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const renderHtml = (): string => {
      const locks = lockRegistry!.list();
      const docs = [...new Set(locks.map((l) => l.document))];
      const cards = locks
        .map(
          (l, i) =>
            `<section style="margin:0 0 20px;border:1px solid #555;border-radius:6px;padding:10px">` +
            `<header style="margin-bottom:8px"><code>${esc(l.selector)}</code> in <code>${esc(l.document)}</code>` +
            (l.sourceBranch ? ` (from <strong>${esc(l.sourceBranch)}</strong>)` : '') +
            ` <button data-unlock data-s="${esc(l.selector)}" data-d="${esc(l.document)}">Unlock</button></header>` +
            (l.pinnedHtml
              ? `<iframe src="http://127.0.0.1:${port}/__lock__/${i}?v=${Date.now()}" style="width:100%;height:180px;border:1px solid #e5a00d;border-radius:4px;background:#fff"></iframe>`
              : '<em>Advisory only - nothing pinned; pick the element again to pin its content.</em>') +
            `</section>`
        )
        .join('');
      const frames = docs
        .map(
          (d) =>
            `<h3>${esc(d)}</h3><iframe src="http://127.0.0.1:${port}/${encodeURI(d)}?v=${Date.now()}" style="width:100%;height:420px;border:1px solid #555;background:#fff"></iframe>`
        )
        .join('');
      return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src http://127.0.0.1:${port}; style-src 'unsafe-inline'; script-src 'unsafe-inline';"></head><body>
<h2>Locked elements (${locks.length})</h2>
<p>These elements must not change. Each one is shown below with its pinned content highlighted.</p>
${cards || '<p>No locked elements yet. Pick an element and use Lock element.</p>'}
<details style="margin-top:16px"><summary>Page context (locked elements outlined in their source page)</summary>
${frames}
</details>
<script>const vscode = acquireVsCodeApi(); document.querySelectorAll('[data-unlock]').forEach((b) => b.addEventListener('click', () => vscode.postMessage({ type: 'unlock', selector: b.getAttribute('data-s'), document: b.getAttribute('data-d') })));</script>
</body></html>`;
    };
    previewPanel.webview.html = renderHtml();
    locksPreviewRefresh = () => {
      previewPanel.webview.html = renderHtml();
    };
    previewPanel.onDidDispose(() => {
      locksPreviewRefresh = undefined;
    });
    previewPanel.webview.onDidReceiveMessage(async (m) => {
      if (m?.type === 'unlock' && lockRegistry) {
        await lockRegistry.remove(m.selector, m.document);
        publish(state);
        previewPanel.webview.html = renderHtml();
      }
    });
  }
  // Tracks the element pick behind a pending selective review so a second,
  // conflicting pick of the same element from a different alternative is
  // refused instead of silently replacing the pending one. Keyed by the
  // selectiveTarget checkpoint id, so any other review flow invalidates it.
  let selectivePick:
    | {
        targetId: string;
        branchId?: string;
        branchName?: string;
        document: string;
        indices?: number[];
        elementId?: string;
      }
    | undefined;
  const isIndexPrefix = (a: number[], b: number[]) =>
    a.length < b.length && a.every((v, i) => v === b[i]);
  const reportConflictingPick = (
    candidate: import('./bridge/timeline').Checkpoint,
    document: string,
    branchId: string | undefined,
    branchName: string,
    elementMatches: boolean
  ): boolean => {
    if (
      !selectivePick ||
      !selectiveTarget ||
      selectivePick.targetId !== selectiveTarget.id ||
      selectivePick.branchId === branchId ||
      selectivePick.document !== document ||
      !elementMatches
    )
      return false;
    const pendingDoc = selectiveTarget.files.find((f) => f.path === document);
    const newDoc = candidate.files.find((f) => f.path === document);
    if (!pendingDoc || !newDoc || pendingDoc.hash === newDoc.hash) return false;
    void vscode.window.showErrorMessage(
      `Conflicting element picks: this element in ${document} was already picked from '${selectivePick.branchName ?? 'main'}' and the pick from '${branchName}' differs. Apply or undo the pending pick first.`
    );
    return true;
  };
  let comparison: TimelineState['comparison'];
  const branchPreviews = new Map<
    string,
    { checkpoint: string; renderKey: string; image?: string; message?: string }
  >();
  let previewingBranches = false;
  /** Opening the Alternatives menu lazily renders at most this many alternative
   * webpages, sequentially, through the same isolated preview path as scrubbing.
   * Beyond the cap no preview command is executed. */
  const MAX_BRANCH_PREVIEWS = 8;
  let backend: TimelineState['backend'];
  const backendCache = new Map<string, TimelineState['backend']>();
  let mcpBridge: McpBridge | undefined;
  let lockRegistry: LockRegistry | undefined;
  /**
   * Element-level lock enforcement: when a checkpoint's touched files contain
   * a locked element whose current markup no longer matches the pinned
   * version, warn and offer to restore the locked markup in place.
   */
  const checkLockedElementDrift = async (paths: readonly string[]): Promise<void> => {
    if (!lockRegistry || !paths.length || !workspaceRoot) return;
    const touched = lockRegistry.list().filter((l) => l.pinnedHtml && paths.includes(l.document));
    for (const lock of touched) {
      try {
        const file = path.join(workspaceRoot, lock.document);
        const current = await fs.readFile(file, 'utf8');
        const now = extractElementBySelector(current, lock.selector);
        if (now === null || now === lock.pinnedHtml) continue;
        diagnostics.appendLine(`locked element drift: ${lock.selector} in ${lock.document}`);
        const pick = await vscode.window.showWarningMessage(
          `Locked element "${lock.label || lock.selector}" in ${lock.document} was modified.`,
          'Restore locked version'
        );
        if (pick !== 'Restore locked version') continue;
        const next = composeLockedDocument(current, [lock]);
        if (next.applied.length) {
          await atomicWrite(file, Buffer.from(next.html));
          void vscode.window.showInformationMessage(
            `Restored the locked element in ${lock.document}.`
          );
        }
      } catch (e) {
        diagnostics.appendLine(`lock drift check failed for ${lock.selector}: ${e}`);
      }
    }
  };

  let lockDrift: TimelineState['lockDrift'];
  let lastNewestRowId: string | undefined;
  let chatbotController: ChatbotController | undefined;
  const elementPicker = new ElementPicker();
  let elementRunner: PreviewRunner | undefined;
  let targetSession: TargetSession | undefined;
  let targeting: TimelineState['targeting'] = { status: 'off' };
  let cache: RenderCache | undefined;
  let rendered: string[] = [];
  let rendering: TimelineState['rendering'];
  let cancelRender = false;
  let renderJob: Promise<void> | undefined;
  let generation = 0;
  let refreshing = false;
  let refreshQueued = false;
  let refreshPromise: Promise<void> | undefined;
  const diagnostics = vscode.window.createOutputChannel('Scrubline');
  context.subscriptions.push(diagnostics);
  let shutdownPreview = false;
  let fullscreenPanel: vscode.WebviewPanel | undefined;
  const publish = (next: TimelineState) => {
    const newest = next.rows.at(-1);
    if (lockRegistry && newest && newest.id !== lastNewestRowId) {
      lastNewestRowId = newest.id;
      const touched = lockRegistry.touchedBy(newest.changedPaths);
      lockDrift = touched.length
        ? touched.map((l) => ({ selector: l.selector, document: l.document, label: l.label }))
        : undefined;
      void checkLockedElementDrift(newest.changedPaths);
    }
    const branchList = alternatives?.list();
    const branchRenderKey = runner ? specificationKey(runner.config) : undefined;
    for (const [id, entry] of branchPreviews) {
      const branch = branchList?.find((b) => b.id === id);
      if (
        !branch ||
        branch.checkpoint !== entry.checkpoint ||
        (branchRenderKey !== undefined && entry.renderKey !== branchRenderKey)
      )
        branchPreviews.delete(id);
    }
    state = {
      ...next,
      locks: lockRegistry?.list().slice() ?? [],
      lockDrift,
      rows: [
        ...visibleRows(
          next.rows.filter(
            (row) => !timeline?.store.checkpoints.some((c) => c.id === row.id && c.branch)
          )
        ),
        ...(selected && timeline?.store.checkpoints.some((c) => c.id === selected && c.branch)
          ? (timeline?.store.checkpoints
              .filter((c) => c.id === selected && c.branch)
              .map((c) => ({
                id: c.id,
                alternative: c.branch?.name,
                createdAt: c.createdAt,
                attribution: c.attribution,
                changedPaths: changedPaths(
                  timeline!.store.checkpoints.find((parent) => parent.id === c.parentId)?.files ??
                    [],
                  c.files
                ),
                perf: c.perf,
                perfDelta: diffPerf(
                  timeline!.store.checkpoints.find((parent) => parent.id === c.parentId)?.perf,
                  c.perf
                )
              })) ?? [])
          : [])
      ],
      selected,
      layout,
      investigation,
      rollback,
      measuredPacket: measured,
      rendered,
      rendering,
      preview,
      review,
      selection,
      canUndo,
      targeting,
      branches: branchList,
      comparison,
      branchPreviews: Object.fromEntries(branchPreviews),
      backend,
      pages,
      activePage,
      chatbot: chatbotController?.getState(),
      verificationReport,
      uiMode
    };
    for (const view of views) {
      try {
        void view
          .postMessage({ type: 'timeline', data: state })
          .then(undefined, () => views.delete(view));
      } catch {
        views.delete(view);
      }
    }
  };
  const publishSelection = (id: string) => {
    for (const view of views) {
      try {
        void view.postMessage({ type: 'select', id }).then(undefined, () => views.delete(view));
      } catch {
        views.delete(view);
      }
    }
  };
  const folders = vscode.workspace.workspaceFolders ?? [];
  let workspaceRoot: string | undefined;
  let config = vscode.workspace.getConfiguration('scrubline', folders[0]?.uri);
  let timeline: Timeline | undefined;
  let restore: Restore | undefined;
  let runner: PreviewRunner | undefined;
  let selected: string | undefined;
  let pages: import('./pages').PageInfo[] = [];
  let activePage: string | undefined;
  let pageDeps = new Map<string, Set<string>>();
  let allPageFiles = new Set<string>();
  let previewQueue = Promise.resolve();
  const discoverPages = async (root: string) => {
    if (!runner) return;
    const discovered = await listPages(root);
    const merged = [...discovered];
    for (const extra of context.workspaceState.get<string[]>('scrubline.extraPages', [])) {
      try {
        specification({ ...runner.config, route: extra });
        if (!merged.some((p) => p.route === extra))
          merged.push({ route: extra, document: routeToDocument(extra) });
      } catch {
        diagnostics.appendLine(`Ignoring invalid saved page route: ${extra}`);
      }
    }
    const configuredRoute = runner.config.route ?? '/';
    if (!merged.some((p) => p.route === configuredRoute))
      merged.push({ route: configuredRoute, document: routeToDocument(configuredRoute) });
    pages = merged;
    pageDeps = new Map();
    for (const page of merged) pageDeps.set(page.route, await pageFiles(root, page.document));
    allPageFiles = new Set([...pageDeps.values()].flatMap((files) => [...files]));
  };

  /** Rows that belong on the active page; rows mapped only to other pages stay hidden. */
  const visibleRows = (rows: TimelineState['rows']) =>
    rows.filter((row) =>
      rowRelevantToPage(row.changedPaths, pageDeps.get(activePage ?? '') ?? new Set(), allPageFiles)
    );

  /** Checkpoint changed-paths for relevance checks outside publish. */
  const checkpointChanges = (id: string) => {
    const checkpoint = timeline?.store.checkpoints.find((c) => c.id === id);
    if (!checkpoint) return [];
    const parent = timeline?.store.checkpoints.find((c) => c.id === checkpoint.parentId);
    return changedPaths(parent?.files ?? [], checkpoint.files);
  };
  /**
   * File-level cherry-pick fallback for pages without a pickable static HTML
   * document (framework/server-rendered routes) or refused element picks.
   * Uses the same reviewed, conflict-guarded selective apply as Changed paths.
   */
  const reviewFilesFallback = async (
    target: import('./bridge/timeline').Checkpoint,
    reason: string
  ) => {
    if (!timeline || !restore || !alternatives) return;
    const base = target.branch
      ? alternatives.base(target)
      : mainlineBase(target, timeline.store.checkpoints);
    if (!base) {
      void vscode.window.showInformationMessage(`${reason} No base checkpoint to compare against.`);
      return;
    }
    const changes = changedPaths(base.files, target.files);
    if (!changes.length) {
      void vscode.window.showInformationMessage(`${reason} No changed files to cherry-pick.`);
      return;
    }
    const picked = await vscode.window.showQuickPick(changes, {
      canPickMany: true,
      placeHolder: `${reason} Select exact files to cherry-pick.`
    });
    if (!picked?.length) return;
    const current = timeline.store.checkpoints.filter((c) => !c.branch).at(-1)!;
    review = undefined;
    selectiveTarget = undefined;
    multiConflicts = [];
    multiAttribution = undefined;
    const merged = mergeFiles(base, current, target, picked);
    if (merged.conflicts.length) throw new Error('Both sides changed. Selective apply blocked.');
    selectiveTarget = merged.target;
    selected = target.id;
    review = await timeline.exclusive(() =>
      restore!.review(selectiveTarget!, current, state.unsaved)
    );
    if (review)
      review.note = `${reason} Whole files only; element-level picking needs static HTML.`;
    publish(state);
  };
  const start = async () => {
    if (timeline || !folders.length) return;
    if (folders.length !== 1) {
      publish({ ...state, status: 'error', message: 'Open one workspace folder.' });
      return;
    }
    if (!vscode.workspace.isTrusted) {
      publish({ ...state, status: 'error', message: 'Trust this folder to capture.' });
      return;
    }
    if (folders[0].uri.scheme !== 'file') {
      publish({ ...state, status: 'error', message: 'Local folders only.' });
      return;
    }
    const root = folders[0].uri.fsPath;
    workspaceRoot = root;
    diagnostics.appendLine(
      `Scrubline ${context.extension.packageJSON.version}: starting writer in PID ${process.pid}.`
    );
    const storeRoot = await scopedStore(
      context.storageUri?.fsPath ?? context.globalStorageUri.fsPath,
      workspaceRoot
    );
    timeline = new Timeline(
      root,
      new HistoryStore(storeRoot, config.get<number>('quotaMB', 512) * 1024 * 1024, {
        identity: vscode.env.sessionId,
        diagnostic: (message) => diagnostics.appendLine(message),
        waiting: () =>
          publish({
            ...state,
            status: 'loading',
            message: 'Finishing the previous Scrubline instance. History will open automatically.'
          }),
        close
      }),
      publish,
      {
        maxFiles: config.get<number>('maxFiles', 10000),
        maxFileBytes: config.get<number>('maxFileMB', 10) * 1024 * 1024,
        maxTotalBytes: config.get<number>('maxTotalMB', 100) * 1024 * 1024,
        ignoreAdditions: config.get<string[]>('ignoreAdditions', [])
      },
      config.get<string>('hookLog') || undefined
    );
    restore = new Restore(root, timeline.store, timeline.limits);
    runner = new PreviewRunner(
      {
        command: config.get<string>('previewCommand', ''),
        port: config.get<number>('previewPort', 4100),
        timeoutMs: config.get<number>('previewTimeoutSeconds', 15) * 1000,
        browserPath: config.get<string>('chromiumPath') || undefined,
        width: config.get<number>('previewWidth', 960),
        height: config.get<number>('previewHeight', 600),
        route: config.get<string>('previewRoute', '/'),
        readySelector: config.get<string>('previewReadySelector', ''),
        backendCapture: config.get<boolean>('backendCapture', true),
        backendFilter: config.get<string>('backendCaptureFilter', ''),
        backendMaxRequests: config.get<number>('backendMaxRequests', 200)
      },
      timeline.store,
      (message) => {
        preview = { status: 'error', message };
        publish(state);
      },
      (message) => diagnostics.appendLine(message),
      workspaceRoot
    );
    Object.assign(runner.config, await identifyBrowser(runner.config));
    cache = new RenderCache(storeRoot, renderKey(runner.config));
    await discoverPages(root);
    const rememberedPage = context.workspaceState.get<string>('scrubline.activePage');
    if (rememberedPage && pages.some((p) => p.route === rememberedPage)) {
      activePage = rememberedPage;
      runner.config.route = rememberedPage;
      cache = new RenderCache(storeRoot, renderKey(runner.config));
    } else {
      activePage = runner.config.route ?? '/';
    }
    publish({ status: 'loading', rows: [], unsaved: false });
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folders[0], '**/*')
    );
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate((uri) => {
        timeline?.event('watcher');
        if (uri.fsPath.endsWith('.html'))
          void discoverPages(folders[0].uri.fsPath).then(() => publish(state));
      }),
      watcher.onDidChange(() => timeline?.event('watcher')),
      watcher.onDidDelete((uri) => {
        timeline?.event('watcher');
        if (uri.fsPath.endsWith('.html'))
          void discoverPages(folders[0].uri.fsPath).then(() => publish(state));
      })
    );
    const dirty = () =>
      timeline?.dirty(
        vscode.workspace.textDocuments.some(
          (d) =>
            d.isDirty &&
            vscode.workspace.getWorkspaceFolder(d.uri)?.uri.toString() === folders[0].uri.toString()
        )
      );
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(() => {
        dirty();
        timeline?.event('save');
      }),
      vscode.workspace.onDidChangeTextDocument(dirty),
      vscode.workspace.onDidCloseTextDocument(dirty),
      {
        dispose: () => {
          shutdownPreview = true;
          cancelRender = true;
          void timeline?.dispose();
          void Promise.all([renderJob?.catch(() => {}), previewQueue.catch(() => {})]).then(
            async () => {
              await timeline?.dispose();
              await targetSession?.stop();
              await runner?.stop();
            }
          );
        }
      }
    );
    try {
      await timeline.store.acquireWriter();
      await timeline.store.open();
      await restore.recover();
    } catch (e) {
      publish({
        ...state,
        status: 'error',
        message: e instanceof Error ? e.message : 'Restore recovery failed.'
      });
      return;
    }
    if (
      await fs
        .access(
          path.join(context.storageUri?.fsPath ?? context.globalStorageUri.fsPath, 'manifests')
        )
        .then(
          () => true,
          () => false
        )
    ) {
      diagnostics.appendLine(
        'Legacy unbound history preserved at previous storage location. New folder-bound history started; no automatic migration.'
      );
      void vscode.window.showInformationMessage(
        'Older unbound Scrubline history is preserved. New folder-bound history starts here. See Scrubline Output.'
      );
    }
    await timeline.start();
    rendered = await cache!.available(timeline.store.checkpoints);
    alternatives = new Alternatives(timeline.store, timeline.limits);
    lockRegistry = new LockRegistry(timeline.store.root);
    await lockRegistry.open();
    // Share lock context with the Antigravity agent automatically.
    void startMcpServer(false);
    lockDrift = undefined;
    lastNewestRowId = undefined;
    const advisorBackend = config.get<string>('advisorBackend') ?? 'auto';
    let advisorService: DesignAdvisorService;
    {
      const cliAdvisor = new AgyCliAdvisorProvider({
        agyPath: config.get<string>('agyPath') || undefined,
        timeoutMs: config.get<number>('advisorTimeoutMs') || undefined,
        model: config.get<string>('advisorModel') || undefined
      });
      const ideAdvisor = new AntigravityLmAdvisorProvider(
        vscode.lm,
        (text) => vscode.LanguageModelChatMessage.User(text),
        {
          timeoutMs: config.get<number>('advisorTimeoutMs') || undefined,
          model: config.get<string>('advisorModel') || undefined
        }
      );
      const primary =
        advisorBackend === 'agy'
          ? cliAdvisor
          : advisorBackend === 'ide'
            ? ideAdvisor
            : new ChainedAdvisorProvider([cliAdvisor, ideAdvisor]);
      // No offline fallback: when every model backend fails, the real error is
      // shown in the chat. Scrubline never answers from hardcoded content.
      advisorService = new DesignAdvisorService(primary);
    }
    chatbotController = new ChatbotController(
      timeline.store,
      () => cache,
      secrets,
      (cState) => {
        publish({ ...state, chatbot: cState });
      },
      advisorService,
      () => lockRegistry?.list() ?? []
    );
    publish(state);
    dirty();
  };
  const secrets = async () => {
    const values: string[] = [];
    if (!timeline) return values;
    for (const name of (await fs.readdir(timeline.workspace)).filter((n) => n.startsWith('.env'))) {
      try {
        const file = path.join(timeline.workspace, name);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) continue;
        values.push(...envValues(await fs.readFile(file, 'utf8')));
      } catch {
        /* Optional env redaction. */
      }
    }
    return values;
  };
  const beginRender = () => {
    if (renderJob || layoutJob || !cache || !runner || !timeline || shutdownPreview || refreshing)
      return;
    cancelRender = false;
    const parents = new Map(timeline!.store.checkpoints.map((c) => [c.id, c]));
    const checkpoints = timeline!.store.checkpoints.filter(
      (c) =>
        !c.branch &&
        rowRelevantToPage(
          changedPaths(parents.get(c.parentId ?? '')?.files ?? [], c.files),
          pageDeps.get(activePage ?? '') ?? new Set(),
          allPageFiles
        )
    );
    const activeCache = cache!;
    const background = new PreviewRunner(
      { ...runner!.config, port: runner!.config.port + 3 },
      timeline!.store,
      undefined,
      (message) => diagnostics.appendLine(message),
      workspaceRoot
    );
    renderJob = (async () => {
      try {
        await prepareHistory(
          checkpoints,
          activeCache,
          async (c) => {
            const r = await background.historical(c, true, 'prerender-screenshots');
            if (!r.screenshot || !r.url) throw new Error(r.error ?? 'Screenshot unavailable.');
            // Promote the sanitized backend artifact out of the quarantined
            // prerender directory before it is wiped; the canonical location
            // matches interactive renders and the backend view reader.
            try {
              const artifact = await fs.readFile(`${r.screenshot}.backend.json`, 'utf8');
              await atomicWrite(
                path.join(
                  timeline!.store.root,
                  'screenshots',
                  renderKey(runner!.config),
                  `${c.id}.backend.json`
                ),
                artifact
              );
            } catch {
              /* Capture disabled or unavailable for this render. */
            }
            return r.screenshot;
          },
          () => cancelRender || shutdownPreview,
          (p) => {
            rendering = p;
            publish(state);
          },
          (id, message) => diagnostics.appendLine(`[checkpoint ${id}] Render failed: ${message}`)
        );
        rendered = await activeCache.available(timeline!.store.checkpoints);
        publish(state);
      } finally {
        await background.stop();
        await fs.rm(path.join(timeline!.store.root, 'prerender-screenshots'), {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100
        });
        renderJob = undefined;
      }
    })();
    void renderJob.catch((e) => {
      diagnostics.appendLine(String(e));
      rendering = {
        running: false,
        done: 0,
        total: checkpoints.length,
        failed: 1,
        message: String(e)
      };
      publish(state);
    });
  };
  /** Renders each alternative's head checkpoint into a per-branch webpage preview
   * for the Alternatives menu. Sequential, on demand; branches whose stored
   * preview already matches their head are skipped. */
  const renderBranchPreviews = async (view: vscode.Webview) => {
    if (!alternatives || !runner || previewingBranches) return;
    previewingBranches = true;
    const renderKey = specificationKey(runner.config);
    const previewRunner = new PreviewRunner(
      { ...runner.config, port: runner.config.port + 8 },
      timeline!.store,
      undefined,
      (line) => diagnostics.appendLine(line)
    );
    try {
      let rendered = 0;
      for (const branch of alternatives.list()) {
        if (branchPreviews.get(branch.id)?.checkpoint === branch.checkpoint) continue;
        const head = timeline!.store.checkpoints.find((c) => c.id === branch.checkpoint);
        if (!head) continue;
        if (rendered >= MAX_BRANCH_PREVIEWS) {
          branchPreviews.set(branch.id, {
            checkpoint: branch.checkpoint,
            renderKey,
            message: 'Preview not rendered (limit reached).'
          });
          continue;
        }
        rendered += 1;
        try {
          const result = await previewRunner.historical(head, true);
          // The branch head may have moved while this render was in flight;
          // never bind an image produced for the old head.
          const now = alternatives.list().find((b) => b.id === branch.id);
          if (!now || now.checkpoint !== branch.checkpoint) continue;
          // Only a fresh render of this exact head and render specification may be
          // shown; preserved-evidence fallbacks and failures are marked, never imaged.
          const fresh = result.screenshot && !result.error ? result.screenshot : undefined;
          branchPreviews.set(branch.id, {
            checkpoint: branch.checkpoint,
            renderKey,
            image: fresh ? view.asWebviewUri(vscode.Uri.file(fresh)).toString() : undefined,
            message: fresh ? undefined : 'Preview unavailable.'
          });
        } catch (error) {
          branchPreviews.set(branch.id, {
            checkpoint: branch.checkpoint,
            renderKey,
            message: 'Preview unavailable.'
          });
          diagnostics.appendLine(
            `[branch ${branch.id}] Preview failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
        publish(state);
      }
    } finally {
      await previewRunner.stop();
      previewingBranches = false;
    }
  };
  const attach = (view: vscode.Webview, fullscreen = false) => {
    views.add(view);
    view.options = {
      enableScripts: true,
      localResourceRoots: [
        context.extensionUri,
        context.globalStorageUri,
        ...(context.storageUri ? [context.storageUri] : [])
      ]
    };
    view.html = getWebviewHtml(view, context.extensionUri, hostInfo, fullscreen);
    const showPreview = async (id: string, interactive = false) => {
      const checkpoint = timeline?.store.checkpoints.find((c) => c.id === id);
      if (!checkpoint || !runner || !cache || shutdownPreview || refreshing || selected !== id)
        return;
      const token = generation;
      const activeRunner = runner;
      const activeCache = cache;
      await targetSession?.stop();
      targeting = { status: 'off' };
      const parent = checkpoint.parentId
        ? timeline?.store.checkpoints.find((c) => c.id === checkpoint.parentId)
        : undefined;
      const comparison =
        parent && (await activeCache.get(parent.id))
          ? { checkpoint: parent.id, regions: await activeCache.regions(parent.id) }
          : undefined;
      const hit = !interactive ? await activeCache.get(id) : undefined;
      if (hit) {
        await activeRunner.stop();
        if (selected === id && token === generation) {
          const cachedPreview: NonNullable<TimelineState['preview']> = {
            status: 'ready',
            checkpoint: id,
            image: view.asWebviewUri(vscode.Uri.file(hit)).toString(),
            label: (await activeCache.receipt(id))
              ? 'Cached evidence'
              : 'Legacy screenshot - unverified',
            receipt: await activeCache.receipt(id),
            regions: await activeCache.regions(id),
            comparison
          };
          const next =
            timeline?.store.checkpoints[
              timeline.store.checkpoints.findIndex((c) => c.id === id) + 1
            ];
          const nextImage = next ? await activeCache.get(next.id) : undefined;
          if (nextImage)
            cachedPreview.preload = view.asWebviewUri(vscode.Uri.file(nextImage)).toString();
          const before =
            timeline?.store.checkpoints[
              timeline.store.checkpoints.findIndex((c) => c.id === id) - 1
            ];
          const previousImage = before ? await activeCache.get(before.id) : undefined;
          if (previousImage)
            cachedPreview.preloadPrevious = view
              .asWebviewUri(vscode.Uri.file(previousImage))
              .toString();
          if (selected !== id || token !== generation) return;
          preview = cachedPreview;
          publish(state);
        }
        return;
      }
      if (selected === id) {
        preview = { status: 'loading', checkpoint: id };
        publish(state);
      }
      try {
        const result = await activeRunner.historical(checkpoint, vscode.workspace.isTrusted);
        let image = result.screenshot;
        if (token !== generation) {
          await activeRunner.stop();
          return;
        }
        if (image && result.url) {
          image = await activeCache.put(id, image);
          if (!rendered.includes(id)) rendered.push(id);
        }
        if (!interactive) await activeRunner.stop();
        if (selected !== id || token !== generation) return;
        preview = {
          status: image || (interactive && result.url) ? 'ready' : 'error',
          checkpoint: id,
          url: interactive ? result.url : undefined,
          label: !result.url
            ? 'Screenshot only - preview unavailable'
            : interactive
              ? result.label
              : 'Rendered evidence - not rechecked',
          receipt: result.receipt,
          image: image ? view.asWebviewUri(vscode.Uri.file(image)).toString() : undefined,
          regions: image
            ? result.url
              ? await activeCache.regions(id)
              : JSON.parse(await fs.readFile(`${image}.json`, 'utf8').catch(() => '[]'))
            : [],
          comparison,
          message: result.error
        };
        publish(state);
      } catch (e) {
        if (selected === id && token === generation) {
          preview = {
            status: 'error',
            checkpoint: id,
            message: e instanceof Error ? e.message : 'Preview failed.'
          };
          diagnostics.appendLine(`[checkpoint ${id}] Preview failed: ${preview.message!}`);
          publish(state);
        }
      }
    };
    const enqueuePreview = (id: string, interactive = false) => {
      if (layoutJob) {
        cancelLayout = true;
        cancelInvestigation = true;
      }
      const work = previewQueue.catch(() => {}).then(() => showPreview(id, interactive));
      previewQueue = work.then(
        () => {},
        () => {}
      );
      return work;
    };
    const listener = view.onDidReceiveMessage(async (message: TimelineInbound) => {
      try {
        if (refreshPromise) await refreshPromise;
        if (message.type === 'fullscreen') {
          if (!message.active) {
            fullscreenPanel?.dispose();
            return;
          }
          if (!timeline?.store.checkpoints.length) {
            const hint = 'Capture a checkpoint before opening fullscreen.';
            void vscode.window.showWarningMessage(hint);
            publish({ ...state, message: hint });
            return;
          }
          try {
            if (!fullscreenPanel) {
              const panel = vscode.window.createWebviewPanel(
                'scrubline.fullscreen',
                'Scrubline Fullscreen',
                vscode.ViewColumn.Active,
                { enableScripts: true, retainContextWhenHidden: true }
              );
              fullscreenPanel = panel;
              const panelView = panel.webview;
              panel.onDidDispose(() => {
                if (fullscreenPanel === panel) fullscreenPanel = undefined;
                views.delete(panelView);
              });
              await vscode.commands.executeCommand('workbench.action.maximizeEditorHideSidebar');
              await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
              attach(panelView, true);
            }
            fullscreenPanel.reveal(vscode.ViewColumn.Active);
            const id = selected ?? timeline.store.checkpoints.at(-1)?.id;
            if (id) {
              selected = id;
              publish(state);
              await enqueuePreview(id);
            }
          } catch (e) {
            const text = e instanceof Error ? e.message : 'Could not open fullscreen.';
            diagnostics.appendLine(`Fullscreen failed: ${text}`);
            void vscode.window.showErrorMessage(`Fullscreen unavailable: ${text}`);
          }
          return;
        }
        if (message.type === 'build-measured-packet') {
          if (!timeline || !investigation || !runner)
            throw new Error('Investigate before building measured context.');
          measured = await measuredPacket(
            timeline.store,
            investigation,
            runner.config,
            await secrets(),
            preview?.receipt,
            targeting?.status === 'ready' ? targeting.packet : undefined
          );
          publish(state);
          return;
        }
        if (message.type === 'copy-measured-packet') {
          if (
            !measured ||
            measured.identity !== message.identity ||
            !runner ||
            measured.specification !== specificationKey(runner.config) ||
            state.unsaved
          )
            throw new Error('Packet stale or workspace unsaved. Rebuild before copying.');
          if (
            targeting?.status === 'ready' &&
            (!targetSession || !(await targetSession.validate()))
          )
            throw new Error('Selected DOM stale. Select again before rebuilding.');
          // Immutable source blobs are verified again before clipboard disclosure.
          if (!timeline || !investigation) throw new Error('Investigation unavailable.');
          const current = await measuredPacket(
            timeline.store,
            investigation,
            runner.config,
            await secrets(),
            preview?.receipt,
            targeting?.status === 'ready' ? targeting.packet : undefined
          );
          if (current.identity !== measured.identity)
            throw new Error('Packet context changed. Review again.');
          await vscode.env.clipboard.writeText(measured.body);
          return;
        }
        if (message.type === 'review-css-rollback') {
          if (
            !vscode.workspace.isTrusted ||
            !timeline ||
            !runner ||
            layoutJob ||
            renderJob ||
            refreshing ||
            !investigation?.minimal ||
            !investigation.request ||
            investigation.running
          )
            throw new Error('Complete a verified investigation first.');
          rollbackCandidate = undefined;
          review = undefined;
          selectiveTarget = undefined;
          multiConflicts = [];
          multiAttribution = undefined;
          const active = timeline!;
          const result = investigation;
          const request = result.request!;
          const good = active.store.checkpoints.find((c) => c.id === result.transitions[0]?.good);
          const bad = active.store.checkpoints.find((c) => c.id === result.transitions[0]?.bad);
          if (!good || !bad) throw new Error('Investigation endpoints unavailable.');
          rollback = { message: 'Checking inverse candidate and keep guards twice.' };
          publish(state);
          const token = generation;
          cancelInvestigation = false;
          const config = { ...runner.config };
          const work = previewQueue
            .catch(() => {})
            .then(() =>
              active.exclusive(async () => {
                const current = active.store.checkpoints.filter((c) => !c.branch).at(-1)!;
                const candidate = await prepareRollback(
                  active.store,
                  current,
                  good,
                  bad,
                  result.units,
                  config,
                  request.guard,
                  message.keep,
                  () => cancelInvestigation || generation !== token || shutdownPreview
                );
                const reviewed = await restore!.review(candidate.target, current, state.unsaved);
                if (reviewed.conflicts.length)
                  throw new Error('Workspace drift. Review rollback again.');
                if (generation !== token || shutdownPreview || cancelInvestigation)
                  throw new Error('Rollback review cancelled or stale.');
                rollbackCandidate = candidate;
                selectiveTarget = candidate.target;
                multiConflicts = [];
                multiAttribution = undefined;
                multiConflicts = [];
                multiAttribution = undefined;
                review = reviewed;
                rollback = {
                  message:
                    'Repair and keep guards passed twice. Review exact inverse before confirming restore.',
                  changes: candidate.changes
                };
                publish(state);
              })
            );
          layoutJob = work;
          previewQueue = work.then(
            () => {},
            () => {}
          );
          try {
            await work;
          } finally {
            layoutJob = undefined;
          }
          return;
        }
        if (message.type === 'cancel-investigation') {
          cancelInvestigation = true;
          return;
        }
        if (message.type === 'investigate-css') {
          if (
            !vscode.workspace.isTrusted ||
            !timeline ||
            !runner ||
            layoutJob ||
            renderJob ||
            refreshing
          )
            throw new Error('Wait for evidence work.');
          measured = undefined;
          rollbackCandidate = undefined;
          rollback = undefined;
          cancelInvestigation = false;
          const token = generation;
          const active = timeline;
          const config = { ...runner.config };
          const work = previewQueue
            .catch(() => {})
            .then(() =>
              investigate(
                active.store,
                config,
                active.limits,
                message.request,
                () => cancelInvestigation || token !== generation || shutdownPreview,
                (next) => {
                  investigation = next;
                  publish(state);
                }
              )
            );
          layoutJob = work;
          previewQueue = work.then(
            () => {},
            () => {}
          );
          try {
            await work;
          } finally {
            layoutJob = undefined;
          }
          return;
        }
        if (message.type === 'cancel-layout') {
          cancelLayout = true;
          return;
        }
        if (message.type === 'layout-sweep') {
          if (
            !vscode.workspace.isTrusted ||
            !timeline ||
            !runner ||
            layoutJob ||
            renderJob ||
            refreshing
          )
            throw new Error('Wait for active evidence work.');
          validateGuard(message.guard);
          validateSweep(message.widths, message.checkpoints);
          const chosen = message.checkpoints.map((id) =>
            timeline!.store.checkpoints.find((c) => c.id === id && !c.branch)
          );
          if (chosen.some((c) => !c)) throw new Error('Choose known main checkpoints.');
          cancelLayout = false;
          const token = generation;
          const store = timeline.store;
          const config = { ...runner.config };
          const notify = (next: import('./layout/types').LayoutMatrix) => {
            layout = next;
            publish(state);
          };
          const work = previewQueue
            .catch(() => {})
            .then(() =>
              sweep(
                chosen as import('./bridge/timeline').Checkpoint[],
                message.widths,
                async (cp, width) => {
                  const probe = new PreviewRunner(
                    { ...config, width, guard: message.guard, port: config.port + 4 },
                    store,
                    undefined,
                    (text) => diagnostics.appendLine(text),
                    workspaceRoot
                  );
                  try {
                    const result = await probe.historical(
                      cp,
                      vscode.workspace.isTrusted,
                      'layout-probes'
                    );
                    if (!result.url || !result.screenshot || !result.receipt)
                      throw new Error('Fresh layout probe unavailable.');
                    const measured = JSON.parse(
                      await fs.readFile(`${result.screenshot}.layout.json`, 'utf8')
                    );
                    // Store bounded image/receipt/geometry in the existing quota-accounted cache.
                    const probeCache = new RenderCache(store.root, renderKey(probe.config));
                    const image = await probeCache.put(cp.id, result.screenshot);

                    return {
                      result: measured,
                      image: view.asWebviewUri(vscode.Uri.file(image)).toString()
                    };
                  } catch (e) {
                    return {
                      result: {
                        version: 1 as const,
                        checkpoint: cp.id,
                        specification: renderKey(probe.config),
                        guard: message.guard,
                        outcome: 'unknown' as const,
                        message: e instanceof Error ? e.message : 'Probe failed.'
                      }
                    };
                  } finally {
                    await probe.stop();
                  }
                },
                () => cancelLayout || token !== generation || shutdownPreview,
                notify
              )
            );
          layoutJob = work;
          previewQueue = work.then(
            () => {},
            () => {}
          );
          try {
            await work;
          } finally {
            layoutJob = undefined;
            await fs.rm(path.join(store.root, 'layout-probes'), { recursive: true, force: true });
          }
          return;
        }
        if (message.type === 'recheck-render') {
          if (!timeline || !runner || !cache || renderJob || layoutJob || refreshing)
            throw new Error('Wait for active rendering.');
          const cp = timeline.store.checkpoints.find((c) => c.id === message.id);
          if (!cp || selected !== cp.id) throw new Error('Select the checkpoint again.');
          const activeCache = cache;
          const activeRunner = runner;
          const token = generation;
          const job = previewQueue
            .catch(() => {})
            .then(async () => {
              preview = {
                status: 'loading',
                checkpoint: cp.id,
                message: 'Two fresh probes of the trusted preview command.'
              };
              publish(state);
              const probes: import('./evidence/types').RenderReceipt[] = [];
              let last: import('./preview/runner').PreviewResult | undefined;
              try {
                for (let i = 0; i < 2; i++) {
                  if (token !== generation || selected !== cp.id)
                    throw new Error('Recheck cancelled.');
                  last = await activeRunner.historical(cp, vscode.workspace.isTrusted);
                  if (!last.url || !last.screenshot || !last.receipt)
                    throw new Error(
                      'Fresh probe unavailable; screenshot fallback is not a recheck.'
                    );
                  probes.push(last.receipt);
                  await activeRunner.stop();
                }
                if (token !== generation || selected !== cp.id)
                  throw new Error('Recheck cancelled.');
                last!.receipt!.repeatability = repeatability(probes);
                last!.receipt!.probes = 2;
                await atomicWrite(
                  `${last!.screenshot!}.receipt.json`,
                  JSON.stringify(last!.receipt)
                );
                await activeCache.put(cp.id, last!.screenshot!);
              } finally {
                await activeRunner.stop();
              }
            });
          previewQueue = job.catch(() => {});
          await job;
          await enqueuePreview(cp.id);
          return;
        }
        if (message.type === 'set-ui-mode') {
          if (message.mode !== 'standard' && message.mode !== 'dev') return;
          uiMode = message.mode;
          void context.globalState.update('scrubline.uiMode', uiMode);
          publish(state);
          return;
        }
        if (message.type === 'request-timeline') {
          void view.postMessage({ type: 'timeline', data: state });
          if (review && selected && preview?.checkpoint !== selected) void enqueuePreview(selected);
          return;
        }
        if (message.type === 'retry-capture') {
          if (timeline && restore) {
            await timeline.exclusive(async () => {
              await timeline!.store.acquireWriter();
              await timeline!.store.open();
              await restore!.recover();
            });
            await timeline.capture('reconcile');
          } else await start();
          return;
        }
        if (message.type === 'set-page' && timeline && runner && cache) {
          const page = pages.find((p) => p.route === message.route);
          if (!page) throw new Error('Page not found in this workspace.');
          if (page.route === activePage) return;
          generation++;
          cancelRender = true;
          await previewQueue.catch(() => {});
          await elementPicker.stop();
          await elementRunner?.stop();
          await runner.stop();
          runner.config.route = page.route;
          specification(runner.config);
          cache = new RenderCache(timeline.store.root, renderKey(runner.config));
          rendered = [];
          preview = undefined;
          review = undefined;
          selectiveTarget = undefined;
          multiConflicts = [];
          multiAttribution = undefined;
          activePage = page.route;
          void context.workspaceState.update('scrubline.activePage', page.route);
          if (
            selected &&
            !rowRelevantToPage(
              checkpointChanges(selected),
              pageDeps.get(activePage) ?? new Set(),
              allPageFiles
            )
          )
            selected = undefined;
          publish(state);
          if (selected) await enqueuePreview(selected);
          return;
        }
        if (message.type === 'add-page' && timeline && runner && cache) {
          const input = await vscode.window.showInputBox({
            prompt: 'Local page route, for example /about.html or /dashboard',
            value: '/'
          });
          if (!input) return;
          let route: string;
          try {
            route = specification({ ...runner.config, route: input.trim() }).route;
          } catch {
            void vscode.window.showErrorMessage(
              'Page route must be a local path starting with / and without a fragment.'
            );
            return;
          }
          if (!pages.some((p) => p.route === route)) {
            pages = [...pages, { route, document: routeToDocument(route) }];
            const extras = context.workspaceState.get<string[]>('scrubline.extraPages', []);
            void context.workspaceState.update('scrubline.extraPages', [...extras, route]);
          }
          generation++;
          cancelRender = true;
          await previewQueue.catch(() => {});
          await elementPicker.stop();
          await elementRunner?.stop();
          await runner.stop();
          runner.config.route = route;
          cache = new RenderCache(timeline.store.root, renderKey(runner.config));
          rendered = [];
          preview = undefined;
          review = undefined;
          selectiveTarget = undefined;
          multiConflicts = [];
          multiAttribution = undefined;
          activePage = route;
          void context.workspaceState.update('scrubline.activePage', route);
          if (
            selected &&
            !rowRelevantToPage(
              checkpointChanges(selected),
              pageDeps.get(activePage) ?? new Set(),
              allPageFiles
            )
          )
            selected = undefined;
          publish(state);
          if (selected) await enqueuePreview(selected);
          return;
        }
        if (!timeline || !restore || !vscode.workspace.isTrusted) {
          // In Restricted Mode every action below is inert; say so in the
          // panel instead of letting buttons appear to do nothing.
          if (!vscode.workspace.isTrusted) {
            publish({
              ...state,
              message:
                'This workspace is in Restricted Mode. Trust the workspace to enable Scrubline actions.'
            });
          }
          return;
        }
        const target =
          'id' in message ? timeline.store.checkpoints.find((c) => c.id === message.id) : undefined;
        if (message.type === 'cancel-render') {
          cancelRender = true;
          return;
        }
        if (message.type === 'render-history') {
          beginRender();
          return;
        }
        if (message.type === 'request-backend') {
          if (!/^[a-f0-9]{64}$/.test(message.id)) return;
          const checkpoint = timeline?.store.checkpoints.find((c) => c.id === message.id);
          if (!checkpoint || !timeline || !runner) return;
          const cachedBackend = backendCache.get(message.id);
          if (cachedBackend) {
            backend = cachedBackend;
            publish(state);
            return;
          }
          backend = { status: 'loading', checkpoint: message.id };
          publish(state);
          try {
            const capturePath = path.join(
              timeline.store.root,
              'screenshots',
              renderKey(runner.config),
              `${message.id}.backend.json`
            );
            let capture: BackendCapture | undefined;
            try {
              const parsed = JSON.parse(await fs.readFile(capturePath, 'utf8')) as BackendCapture;
              if (parsed.version === 1 && parsed.checkpoint === message.id) capture = parsed;
            } catch {
              /* No capture recorded for this checkpoint. */
            }
            const diagramsOn = config.get<boolean>('backendDiagrams', true);
            let endpoints: import('./backend/types').EndpointMap | undefined;
            let graph: import('./backend/types').ModuleGraph | undefined;
            let matches: number[] | undefined;
            if (diagramsOn) {
              const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-backend-'));
              try {
                await timeline.store.materialize(checkpoint, temp);
                const codeFiles: { path: string; content: string }[] = [];
                const CODE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
                const SKIP = /(^|\/)(node_modules|\.git|dist|out)(\/|$)/;
                const walk = async (dir: string, prefix: string): Promise<void> => {
                  if (codeFiles.length >= 1000) return;
                  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
                    if (codeFiles.length >= 1000) return;
                    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
                    if (entry.isDirectory()) {
                      if (!SKIP.test(rel)) await walk(path.join(dir, entry.name), rel);
                    } else if (CODE.test(entry.name) && !SKIP.test(rel)) {
                      const full = path.join(dir, entry.name);
                      const stat = await fs.stat(full);
                      if (stat.size > 256 * 1024) continue;
                      codeFiles.push({ path: rel, content: await fs.readFile(full, 'utf8') });
                    }
                  }
                };
                await walk(temp, '');
                endpoints = scanEndpoints(codeFiles);
                graph = buildImportGraph(codeFiles);
                if (capture)
                  matches = capture.entries.map((e) => matchRoute(e.path, endpoints!.routes));
              } finally {
                await fs.rm(temp, { recursive: true, force: true });
              }
            }
            let diff: import('./backend/types').BackendDiffEntry[] | undefined;
            if (capture && checkpoint.parentId) {
              try {
                const parent = JSON.parse(
                  await fs.readFile(
                    path.join(
                      timeline.store.root,
                      'screenshots',
                      renderKey(runner.config),
                      `${checkpoint.parentId}.backend.json`
                    ),
                    'utf8'
                  )
                ) as BackendCapture;
                if (parent.version === 1) diff = diffCaptures(parent, capture);
              } catch {
                /* Parent render predates capture; diff stays absent. */
              }
            }
            backend = {
              status: capture || endpoints || graph ? 'ready' : 'empty',
              checkpoint: message.id,
              capture,
              matches,
              endpoints,
              graph,
              diff,
              message: capture
                ? undefined
                : 'No backend capture for this checkpoint. Re-render it to record traffic.'
            };
            backendCache.set(message.id, backend);
          } catch (e) {
            backend = {
              status: 'error',
              checkpoint: message.id,
              message: e instanceof Error ? e.message : 'Backend view failed.'
            };
          }
          publish(state);
          return;
        }
        if (message.type === 'refresh-renders' && cache) {
          if (renderJob || refreshing) return;
          generation++;
          await previewQueue.catch(() => {});
          await cache.clear();
          rendered = [];
          preview = undefined;
          publish(state);
          return;
        }
        if (message.type === 'select-checkpoint' && target) {
          selected = target.id;
          review = undefined;
          selectiveTarget = undefined;
          selectiveMeta = undefined;
          verificationReport = undefined;
          multiConflicts = [];
          multiAttribution = undefined;
          publish(state);
          await enqueuePreview(target.id);
        }
        if (message.type === 'lock-element') {
          if (!lockRegistry) return;
          if (!selectiveMeta?.targetSelector || !selectiveMeta.documentPath) {
            publish({
              ...state,
              message: 'Pick one specific element first; only a pinned element can be locked.'
            });
            return;
          }
          const lockSelector = selectiveMeta.targetSelector;
          const lockDocument = selectiveMeta.documentPath;
          // Pin the exact picked element HTML from the checkpoint it came
          // from, so the locked-elements preview can render it into the
          // current document and conflicts across alternatives are detectable.
          let pinnedHtml: string | undefined;
          if (selectiveTarget && timeline && selectiveMeta.indices?.length) {
            try {
              const picked = selectiveTarget.files.find((f) => f.path === lockDocument);
              if (picked) {
                const bytes = await timeline.store.readBlob(picked.hash);
                pinnedHtml = extractElementOuterHtml(bytes.toString('utf8'), selectiveMeta.indices);
              }
            } catch {
              pinnedHtml = undefined;
            }
          }
          try {
            await lockRegistry.add({
              selector: lockSelector,
              document: lockDocument,
              label: message.label,
              pinnedHtml,
              sourceCheckpointId: selectiveMeta.sourceCheckpointId,
              sourceBranch: selectiveMeta.sourceBranch
            });
          } catch (e) {
            const detail = e instanceof Error ? e.message : String(e);
            void vscode.window.showErrorMessage(`Lock failed: ${detail}`);
            publish({ ...state, message: detail });
            return;
          }
          publish({
            ...state,
            message: `Locked ${lockSelector} in ${lockDocument}. It must not be changed.`
          });
          locksPreviewRefresh?.();
        }
        if (message.type === 'open-locks-preview') {
          await openLocksPreview();
          return;
        }
        if (message.type === 'unlock-element') {
          if (!lockRegistry) return;
          await lockRegistry.remove(message.selector, message.document);
          publish({ ...state, message: `Unlocked ${message.selector} in ${message.document}.` });
          locksPreviewRefresh?.();
        }
        if (message.type === 'set-selection') {
          const cap = Math.min(50, config.get<number>('multiSelectLimit') ?? 20);
          const known = new Set(timeline?.store.checkpoints.map((c) => c.id) ?? []);
          const ids = message.ids.filter((id) => known.has(id));
          selection = {
            ids: [...new Set(ids)].slice(0, cap),
            mode: message.mode
          };
          publish(state);
        }
        if (message.type === 'review-multi' && timeline && restore) {
          const cap = Math.min(50, config.get<number>('multiSelectLimit') ?? 20);
          const current = timeline.store.checkpoints.filter((c) => !c.branch).at(-1)!;
          const composed = await composeCheckpoints(
            timeline.store.checkpoints,
            current,
            message.ids,
            message.mode,
            message.overrides ?? {},
            cap,
            timeline.store
          );
          review = undefined;
          selectiveTarget = undefined;
          multiConflicts = [];
          multiAttribution = undefined;
          multiConflicts = composed.conflicts;
          multiAttribution = {
            kind: 'composed',
            mode: message.mode,
            sources: message.ids
          };
          selection = { ids: message.ids, mode: message.mode };
          selectiveTarget = composed.target;
          const reviewed = await timeline.exclusive(() =>
            restore!.review(composed.target, current, state.unsaved)
          );
          reviewed.note = `${
            message.mode === 'combine'
              ? 'Combine changes'
              : message.mode === 'revert'
                ? 'Revert changes'
                : 'Pick per file'
          } from ${message.ids.length} checkpoint${
            message.ids.length === 1 ? '' : 's'
          } (${message.ids.map((id) => id.slice(0, 8)).join(', ')}), in this order. Changes only; single-checkpoint Restore (go to X) is unchanged.${
            composed.warnings.length ? ' ' + composed.warnings.join(' ') : ''
          }`;
          reviewed.multi = {
            mode: message.mode,
            sources: message.ids,
            decisions: composed.decisions,
            warnings: composed.warnings,
            hints: composed.hints,
            blocked: composed.conflicts,
            overrides: message.overrides,
            compositionId: composed.compositionId
          };
          review = reviewed;
          publish(state);
          await renderCombinedPreview(composed.target, message.ids.length, message.mode);
          publish(state);
        }
        if (message.type === 'fork-checkpoint' && target && alternatives) {
          const name = await vscode.window.showInputBox({
            prompt: 'Alternative name',
            value: 'Alternative'
          });
          if (!name) return;
          const branch = await timeline.exclusive(() => alternatives!.fork(target, name));
          publish(state);
          await vscode.commands.executeCommand(
            'vscode.openFolder',
            vscode.Uri.file(branch.directory),
            true
          );
        }
        if (message.type === 'capture-branch' && alternatives) {
          await timeline.exclusive(() => alternatives!.capture(message.branch));
          publish(state);
        }
        if (message.type === 'compare-branch' && alternatives && runner) {
          const branch = alternatives.list().find((b) => b.id === message.branch);
          if (!branch) throw new Error('Branch unavailable.');
          const right = timeline.store.checkpoints.find((c) => c.id === branch.checkpoint)!;
          const left = timeline.store.checkpoints.filter((c) => !c.branch).at(-1)!;
          const a = new PreviewRunner(
            { ...runner.config, port: runner.config.port + 1 },
            timeline.store,
            undefined,
            (message) => diagnostics.appendLine(message),
            workspaceRoot
          );
          const b = new PreviewRunner(
            { ...runner.config, port: runner.config.port + 2 },
            timeline.store,
            undefined,
            (message) => diagnostics.appendLine(message),
            workspaceRoot
          );
          try {
            const x = await a.historical(left, true);
            const y = await b.historical(right, true);
            comparison = {
              leftId: left.id,
              rightId: right.id,
              left: x.screenshot
                ? view.asWebviewUri(vscode.Uri.file(x.screenshot)).toString()
                : undefined,
              right: y.screenshot
                ? view.asWebviewUri(vscode.Uri.file(y.screenshot)).toString()
                : undefined,
              message:
                !x.screenshot || !y.screenshot ? 'Comparison screenshot unavailable.' : undefined
            };
            publish(state);
          } finally {
            await a.stop();
            await b.stop();
          }
        }
        if (message.type === 'preview-branches') {
          void renderBranchPreviews(view);
        }
        if (message.type === 'pick-element' && target) {
          if (!runner || !vscode.workspace.isTrusted) throw new Error('Trusted preview required.');
          await elementPicker.stop();
          await elementRunner?.stop();
          const pickedSource = target;
          const pickedRunner = new PreviewRunner(
            { ...runner.config, port: runner.config.port + 7 },
            timeline.store,
            undefined,
            undefined,
            workspaceRoot
          );
          elementRunner = pickedRunner;
          const result = await pickedRunner.historical(target, true, 'element-picker');
          if (!result.url || !runner.config.browserPath) {
            await pickedRunner.stop();
            throw new Error('Interactive source preview unavailable.');
          }
          const route = new URL(result.url).pathname;
          const document = route === '/' ? 'index.html' : route.replace(/^\//, '');
          await elementPicker.start(
            runner.config.browserPath,
            result.url,
            { width: runner.config.width ?? 960, height: runner.config.height ?? 600 },
            async (indices, info, framework) => {
              try {
                const current = timeline!.store.checkpoints.filter((c) => !c.branch).at(-1)!;
                let candidate;
                const notes: string[] = [];
                let htmlError: unknown;
                let fiberError: unknown;
                // 1. Static HTML documents use the exact parse5 path.
                if (
                  isPickableDocument(document, pickedSource.files) &&
                  current.files.some((f) => f.path === document)
                ) {
                  try {
                    candidate = await elementCandidate(
                      timeline!.store,
                      pickedSource,
                      current,
                      document,
                      '',
                      indices
                    );
                  } catch (e) {
                    htmlError = e;
                  }
                }
                // 2. React development builds: exact fiber debug metadata
                // resolved through source maps.
                if (!candidate && framework && framework.frames.length) {
                  try {
                    const frame = framework.frames[0];
                    let resolved;
                    if (!resolveTrackedSource(frame.fileName, pickedSource.files)) {
                      resolved = await resolveViaSourceMap(frame);
                      if (!resolved)
                        throw new Error(
                          'No source map or matching original source found for the picked element.'
                        );
                    }
                    const result = await frameworkElementCandidate(
                      timeline!.store,
                      pickedSource,
                      current,
                      { frame, tag: framework.tag, resolved }
                    );
                    candidate = result.checkpoint;
                    notes.push(
                      'JSX element subtree only (content, props, inline styles); external CSS and component internals stay current.'
                    );
                    if (result.referenced.length)
                      notes.push(
                        `References resolve to current code, not the historical versions: ${result.referenced.join(', ')}.`
                      );
                  } catch (e) {
                    fiberError = e;
                  }
                }
                // 3. Static-analysis framework matching (Vue/Svelte/Astro/JSX
                // sources, and any page whose HTML path refused).
                if (!candidate) {
                  try {
                    const result = await staticElementCandidate(
                      timeline!.store,
                      pickedSource,
                      current,
                      info
                    );
                    candidate = result.candidate;
                    notes.push(...result.notes);
                  } catch (staticError) {
                    throw htmlError ?? fiberError ?? staticError;
                  }
                }
                const pickBranchId = pickedSource.branch?.id;
                const pickBranchName = pickedSource.branch?.name ?? 'main';
                const sameElement =
                  !!selectivePick?.indices &&
                  ((selectivePick.indices.length === indices.length &&
                    selectivePick.indices.every((v, i) => v === indices[i])) ||
                    isIndexPrefix(selectivePick.indices, indices) ||
                    isIndexPrefix(indices, selectivePick.indices));
                if (
                  reportConflictingPick(
                    candidate,
                    document,
                    pickBranchId,
                    pickBranchName,
                    sameElement
                  )
                )
                  return;
                review = await timeline!.exclusive(() =>
                  restore!.review(candidate, current, state.unsaved)
                );
                review.note =
                  'Element content, inline styles and paired exclusive CSS only. Shared styles and unmatched rules stay current; this may differ from the historical appearance.' +
                  (notes.length ? ' ' + notes.join(' ') : '');
                selectiveTarget = candidate;
                const lockSelector = info.id
                  ? `#${info.id}`
                  : info.testId
                    ? `[data-testid="${info.testId.replace(/"/g, '')}"]`
                    : indices.reduce((sel, i) => `${sel} > :nth-child(${i + 1})`, 'body');
                selectiveMeta = {
                  targetSelector: lockSelector,
                  documentPath: document,
                  indices,
                  sourceCheckpointId: pickedSource.id,
                  sourceBranch: pickBranchName
                };
                multiConflicts = [];
                multiAttribution = undefined;
                selected = pickedSource.id;
                selectivePick = {
                  targetId: candidate.id,
                  branchId: pickBranchId,
                  branchName: pickBranchName,
                  document,
                  indices
                };
                try {
                  verificationReport = await DualVerificationEngine.verifyStaticDocuments({
                    store: timeline!.store,
                    current,
                    candidate,
                    targetSelector: '',
                    documentPath: document
                  });
                } catch {
                  verificationReport = undefined;
                }
                publish(state);
                void vscode.window.showInformationMessage(
                  'Element selected. Review exact files and confirm in Scrubline.'
                );
              } catch (e) {
                const reason = e instanceof Error ? e.message : 'Element selection failed.';
                const choice = await vscode.window.showErrorMessage(reason, 'Pick files instead');
                if (choice) await reviewFilesFallback(pickedSource, reason);
              }
            },
            () => pickedRunner.stop()
          );
          context.subscriptions.push({
            dispose: () => {
              void elementPicker.stop();
              void pickedRunner.stop();
            }
          });
          return;
        }
        if (message.type === 'review-element' && target) {
          const current = timeline.store.checkpoints.filter((c) => !c.branch).at(-1)!;
          const activeDocument = pages.find((p) => p.route === activePage)?.document;
          if (
            !message.document &&
            !(activeDocument && target.files.some((f) => f.path === activeDocument)) &&
            !target.files.some((f) => f.path.endsWith('.html') || isFrameworkDocument(f.path))
          ) {
            await reviewFilesFallback(target, 'No tracked HTML or framework source on this page.');
            return;
          }
          const document =
            message.document ||
            (activeDocument && target.files.some((f) => f.path === activeDocument)
              ? activeDocument
              : await vscode.window.showQuickPick(
                  target.files
                    .filter((f) => f.path.endsWith('.html') || isFrameworkDocument(f.path))
                    .map((f) => f.path),
                  { placeHolder: 'HTML document or framework component file' }
                ));
          if (!document) return;
          const element =
            message.element ||
            (await vscode.window.showInputBox({
              prompt:
                'Unique element id (without #). Includes content, inline styles and exclusive #id CSS.',
              placeHolder: 'hero'
            }));
          if (!element) return;
          let candidate;
          let frameworkNotes: string[] = [];
          if (isFrameworkDocument(document)) {
            const result = await staticElementCandidate(
              timeline.store,
              target,
              current,
              { id: element },
              { document }
            );
            candidate = result.candidate;
            frameworkNotes = result.notes;
          } else {
            candidate = await elementCandidate(timeline.store, target, current, document, element);
          }
          const byIdMatches = !!selectivePick?.elementId && selectivePick.elementId === element;
          if (
            reportConflictingPick(
              candidate,
              document,
              target.branch?.id,
              target.branch?.name ?? 'main',
              byIdMatches
            )
          )
            return;
          review = await timeline.exclusive(() =>
            restore!.review(candidate, current, state.unsaved)
          );
          review.note =
            'Element content, inline styles and paired exclusive CSS only. Shared styles and unmatched rules stay current; this may differ from the historical appearance.' +
            (frameworkNotes.length ? ' ' + frameworkNotes.join(' ') : '');
          selectiveTarget = candidate;
          selectiveMeta = {
            targetSelector: `#${element}`,
            documentPath: document,
            sourceCheckpointId: target.id,
            sourceBranch: target.branch?.name ?? 'main'
          };
          selectivePick = {
            targetId: candidate.id,
            branchId: target.branch?.id,
            branchName: target.branch?.name ?? 'main',
            document,
            elementId: element
          };
          multiConflicts = [];
          multiAttribution = undefined;
          selected = target.id;
          try {
            verificationReport = await DualVerificationEngine.verifyStaticDocuments({
              store: timeline.store,
              current,
              candidate,
              targetSelector: `#${element}`,
              documentPath: document
            });
          } catch {
            verificationReport = undefined;
          }
          publish(state);
          return;
        }
        if (
          (message.type === 'review-selective' ||
            message.type === 'review-navbar' ||
            message.type === 'review-section') &&
          target &&
          alternatives
        ) {
          const isSection = message.type === 'review-navbar' || message.type === 'review-section';
          let document = isSection ? message.document : '';
          if (isSection && !document) {
            const picked = await vscode.window.showQuickPick(
              target.files.filter((f) => f.path.endsWith('.html')).map((f) => f.path),
              { placeHolder: 'Standalone section document' }
            );
            if (!picked) return;
            document = picked;
          }
          let paths = isSection
            ? await staticSectionPaths(timeline.store, target, document)
            : message.paths;
          if (message.type === 'review-selective' && !paths.length) {
            const base = alternatives.base(target);
            const changes = changedPaths(base.files, target.files);
            const picked = await vscode.window.showQuickPick(changes, {
              canPickMany: true,
              placeHolder: 'Select exact files to review'
            });
            if (!picked?.length) return;
            paths = picked;
          }
          const current = timeline.store.checkpoints.filter((c) => !c.branch).at(-1)!;
          if (isSection) {
            await staticSectionPaths(timeline.store, alternatives.base(target), document);
            await staticSectionPaths(timeline.store, current, document);
          }
          review = undefined;
          selectiveTarget = undefined;
          multiConflicts = [];
          multiAttribution = undefined;
          const merged = mergeFiles(alternatives.base(target), current, target, paths);
          if (merged.conflicts.length)
            throw new Error('Both sides changed. Selective apply blocked.');
          selectiveTarget = merged.target;
          multiConflicts = [];
          multiAttribution = undefined;
          review = await timeline.exclusive(() =>
            restore!.review(selectiveTarget!, current, state.unsaved)
          );
          publish(state);
        }
        if (message.type === 'review-multi-element' && alternatives) {
          if (!message.selections || message.selections.length === 0) {
            throw new Error('No elements selected.');
          }
          const current = timeline.store.checkpoints.filter((c) => !c.branch).at(-1)!;
          const elementSelections: ElementSelection[] = [];
          for (const s of message.selections) {
            const targetCp = timeline.store.checkpoints.find((c) => c.id === s.checkpointId);
            if (!targetCp) throw new Error(`Checkpoint ${s.checkpointId} not found.`);
            const baseCp = alternatives.base(targetCp);
            elementSelections.push({
              checkpoint: targetCp,
              base: baseCp,
              document: s.document,
              selector: s.selector,
              fingerprint: s.fingerprint
            });
          }

          const resolved = await resolveElementFiles(timeline.store, elementSelections);

          const multiItems = resolved.map((r) => ({
            base: r.selection.base,
            selected: r.selection.checkpoint,
            paths: r.paths,
            document: r.document,
            selector: r.selection.selector
          }));
          const merged = await mergeMultiElements(current, multiItems, timeline.store);
          if (merged.conflicts.length) {
            throw new Error(
              `Both sides changed in ${merged.conflicts.join(', ')}. Multi-element apply blocked.`
            );
          }

          review = undefined;
          selectiveTarget = merged.target;
          const rev = await timeline.exclusive(() =>
            restore!.review(selectiveTarget!, current, state.unsaved)
          );
          review = {
            ...rev,
            elements: merged.elements
          };
          publish(state);
        }
        if (message.type === 'clear-target-selections') {
          await targetSession?.clear();
          if (targeting) {
            targeting = {
              status: 'on',
              packet: undefined,
              summary: undefined,
              crop: undefined,
              selection: undefined,
              selections: []
            };
            publish(state);
          }
        }
        if (message.type === 'start-targeting') {
          if (!preview?.url || !preview.checkpoint)
            throw new Error('Select a rendered checkpoint first.');
          const executable = config.get<string>('chromiumPath');
          if (!executable) throw new Error('Set Chromium path for targeting.');
          const cp = timeline.store.checkpoints.find((c) => c.id === preview!.checkpoint);
          if (!cp) throw new Error('Checkpoint unavailable.');
          const previous = timeline.store.checkpoints.find((c) => c.id === cp.parentId);
          const redactions = await secrets();
          await targetSession?.stop();
          targetSession = new TargetSession(
            executable,
            timeline.store.root,
            (selection, crop, all) => {
              if (!selection || !all || all.length === 0) {
                targeting = {
                  status: 'on',
                  packet: undefined,
                  summary: undefined,
                  crop: undefined,
                  selection: undefined,
                  selections: []
                };
                publish(state);
                return;
              }
              const packet = makePacket(cp, previous, selection, redactions);
              targeting = {
                status: 'ready',
                packet: packet.body,
                summary: packet.summary,
                crop: crop ? view.asWebviewUri(vscode.Uri.file(crop)).toString() : undefined,
                selection,
                selections: all
              };
              publish(state);
            },
            (message) => {
              targeting = { status: 'off', message };
              publish(state);
            }
          );
          await targetSession.start(preview.url, redactions, false, preview.receipt?.viewport);
          targeting = { status: 'on' };
          publish(state);
        }
        if (message.type === 'stop-targeting') {
          await targetSession?.stop();
          targeting = { status: 'off' };
          publish(state);
        }
        if (message.type === 'validate-target' || message.type === 'copy-packet') {
          if (!targetSession || !(await targetSession.validate())) {
            targeting = { ...targeting, status: 'stale', message: 'Target changed. Select again.' };
            publish(state);
            return;
          }
          if (message.type === 'copy-packet' && targeting?.packet) {
            await vscode.env.clipboard.writeText(targeting.packet);
            targeting = { ...targeting, message: 'Copied for manual paste.' };
            publish(state);
          }
        }
        if (message.type === 'start-preview' || message.type === 'open-preview') {
          const id = selected ?? timeline.store.checkpoints.filter((c) => !c.branch).at(-1)?.id;
          if (id) {
            selected = id;
            await enqueuePreview(id, true);
            if (preview?.url) await vscode.env.openExternal(vscode.Uri.parse(preview.url));
          }
        }
        if (message.type === 'review-checkpoint' && target) {
          selected = target.id;
          selectiveTarget = undefined;
          selectiveMeta = undefined;
          verificationReport = undefined;
          multiConflicts = [];
          multiAttribution = undefined;
          await timeline.exclusive(async () => {
            review = await restore!.review(
              target,
              timeline!.store.checkpoints.at(-1)!,
              state.unsaved
            );
          });
          publish(state);
          await enqueuePreview(target.id);
        }
        if (message.type === 'apply-reviewed' && (target || selectiveTarget?.id === message.id)) {
          const applying = selectiveTarget?.id === message.id ? selectiveTarget : target!;
          await timeline.exclusive(async () => {
            if (rollbackCandidate?.target.id === message.id) {
              if (!runner || !vscode.workspace.isTrusted)
                throw new Error('Trusted preview unavailable.');
              if (layoutJob || renderJob || refreshing)
                throw new Error('Wait for active evidence work.');
              await previewQueue.catch(() => {});
              const rollbackWork = applyRollback(
                restore!,
                rollbackCandidate,
                message.token,
                runner.config,
                () => state.unsaved,
                () => shutdownPreview || cancelInvestigation
              );
              layoutJob = rollbackWork;
              previewQueue = rollbackWork.then(
                () => {},
                () => {}
              );
              try {
                await rollbackWork;
              } finally {
                layoutJob = undefined;
              }
            } else if (selectiveTarget?.id === message.id) {
              if (multiConflicts.length)
                throw new Error(
                  'Composition conflicts. Untick a checkpoint, reorder, or pick winners first.'
                );
              if (multiAttribution?.kind === 'composed' && review?.multi) {
                const cap = Math.min(50, config.get<number>('multiSelectLimit') ?? 20);
                const head = timeline!.store.checkpoints.filter((c) => !c.branch).at(-1)!;
                const recheck = await composeCheckpoints(
                  timeline!.store.checkpoints,
                  head,
                  selection?.ids ?? [],
                  multiAttribution.mode,
                  (review.multi.overrides ?? {}) as import('./branches/multi').MosaicOverrides,
                  cap,
                  timeline!.store
                );
                if (recheck.compositionId !== review.multi.compositionId)
                  throw new Error('Selection changed since review. Review again.');
              }
              const current = timeline!.store.checkpoints.filter((c) => !c.branch).at(-1)!;
              const historical = timeline!.store.checkpoints.find((c) => c.id === selected);
              await applySelective(
                restore!,
                applying,
                message.token,
                state.unsaved,
                config.get<string>('postApplyCommand') ?? '',
                () => state.unsaved,
                {
                  verify: {
                    previewConfig: runner?.config,
                    historical,
                    current,
                    targetSelector: selectiveMeta?.targetSelector || '',
                    documentPath: selectiveMeta?.documentPath || 'index.html',
                    protectAllElements: Boolean(selectiveMeta?.targetSelector)
                  }
                },
                multiAttribution
              );
            } else await restore!.apply(message.token, applying, state.unsaved);
          });
          review = undefined;
          selectiveTarget = undefined;
          selectiveMeta = undefined;
          verificationReport = undefined;
          multiConflicts = [];
          multiAttribution = undefined;
          rollbackCandidate = undefined;
          rollback = undefined;
          canUndo = true;
          await timeline.capture('reconcile');
          if (selected) {
            await enqueuePreview(selected!);
          }
        }
        if (message.type === 'undo-restore') {
          await timeline.exclusive(() =>
            restore!.undo(timeline!.store.checkpoints.at(-1)!, state.unsaved)
          );
          canUndo = false;
          review = undefined;
          await timeline.capture('reconcile');
          if (selected) {
            await enqueuePreview(selected!);
          }
        }
        if (
          message.type === 'open-diff' &&
          (target || selectiveTarget?.id === message.id) &&
          safePath(message.path)
        ) {
          const target =
            selectiveTarget?.id === message.id
              ? selectiveTarget
              : timeline.store.checkpoints.find((c) => c.id === message.id)!;
          const current = timeline.store.checkpoints.at(-1)!;
          const changed = [
            ...new Set([
              ...(review?.paths ?? []),
              ...(review?.conflicts ?? []),
              ...target.files.map((f) => f.path)
            ])
          ];
          if (!changed.includes(message.path)) return;
          const diffRoot = path.join(timeline.store.root, 'diff', target.id, current.id);
          const uri = async (c: typeof target, side: string) => {
            const f = c.files.find((f) => f.path === message.path);
            const file = path.join(diffRoot, side, ...message.path.split('/'));
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.writeFile(file, f ? await timeline!.store.readBlob(f.hash) : Buffer.alloc(0));
            return vscode.Uri.file(file);
          };
          const disk = path.join(timeline.workspace, ...message.path.split('/'));
          const baseUri = await uri(current, 'base');
          const targetUri = await uri(target, 'selected');
          let diskUri: vscode.Uri;
          try {
            await fs.access(disk);
            diskUri = vscode.Uri.file(disk);
          } catch {
            const absent = path.join(diffRoot, 'absent');
            await fs.writeFile(absent, Buffer.alloc(0));
            diskUri = vscode.Uri.file(absent);
          }
          await vscode.commands.executeCommand(
            'vscode.diff',
            baseUri,
            diskUri,
            `${message.path}: base to disk`
          );
          await vscode.commands.executeCommand(
            'vscode.diff',
            baseUri,
            targetUri,
            `${message.path}: base to selected`
          );
        }
        if (message.type === 'ask-chatbot') {
          if (!chatbotController) throw new Error('Chatbot unavailable. Open a workspace first.');
          await chatbotController.handleQuery(
            message.query,
            message.checkpointId ?? selected,
            message.compareCheckpointId
          );
          return;
        }
        if (message.type === 'clear-chatbot-history') {
          chatbotController?.clearHistory();
          return;
        }
        if (message.type === 'request-chatbot-state') {
          if (chatbotController) {
            void view.postMessage({ type: 'chatbot-state', data: chatbotController.getState() });
          }
          return;
        }
      } catch (e) {
        if (message.type === 'apply-reviewed') {
          const vReport =
            e && typeof e === 'object' && 'verificationReport' in e
              ? (e as { verificationReport: TimelineState['verificationReport'] })
                  .verificationReport
              : undefined;
          if (vReport) {
            verificationReport = vReport;
            publish(state);
            void vscode.window.showWarningMessage(
              verificationReport?.failureReason ||
                'Selective restore blocked: Invariant violation detected.'
            );
            return;
          }
          review = undefined;
          selectiveTarget = undefined;
          selectiveMeta = undefined;
          verificationReport = undefined;
          multiConflicts = [];
          multiAttribution = undefined;
          rollbackCandidate = undefined;
          rollback = undefined;
          canUndo = true;
          await timeline?.capture('reconcile');
        }
        if (['start-targeting', 'copy-packet', 'validate-target'].includes(message.type)) {
          targeting = {
            status: 'error',
            message: e instanceof Error ? e.message : 'Targeting failed.'
          };
          publish(state);
          return;
        }
        previewQueue = Promise.resolve();
        const failureMessage = e instanceof Error ? e.message : 'Action failed.';
        if (['apply-reviewed', 'pick-element', 'pick-element-id'].includes(message.type))
          void vscode.window.showErrorMessage(
            `${message.type === 'apply-reviewed' ? 'Restore' : 'Element pick'} failed: ${failureMessage}`
          );
        publish({
          ...state,
          status: 'error',
          message: failureMessage
        });
      }
    });
    context.subscriptions.push(listener);
  };
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      'scrubline.historyView',
      {
        resolveWebviewView(view) {
          attach(view.webview);
          view.onDidDispose(() => views.delete(view.webview));
        }
      },
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );
  /**
   * Starts (or restarts) the Scrubline MCP bridge and registers it into
   * Antigravity's mcp_config.json so the IDE agent shares lock context.
   * The command also shows the raw config for other MCP clients.
   */
  const startMcpServer = async (showDocument: boolean): Promise<string> => {
    if (!timeline || !restore || !vscode.workspace.isTrusted)
      throw new Error('Open one trusted local workspace first.');
    await mcpBridge?.stop();
    mcpBridge = new McpBridge(timeline.store.root, {
      listLocked: async () => {
        if (!vscode.workspace.isTrusted) throw new Error('Workspace not trusted.');
        return {
          locks: (lockRegistry?.list() ?? []).map((l) => ({
            selector: l.selector,
            document: l.document,
            label: l.label,
            lockedAt: l.lockedAt
          })),
          message:
            'These elements are locked by the user. Do not modify them, their owning documents, or their scoped styles. Advise instead.'
        };
      },
      list: async () => {
        if (!vscode.workspace.isTrusted) throw new Error('Workspace not trusted.');
        const values = await secrets();
        return {
          checkpoints: state.rows.map((r) => ({
            id: r.id,
            createdAt: r.createdAt,
            changedPaths: r.changedPaths.map((p) => redact(p, values))
          }))
        };
      },
      review: async (id) => {
        if (!vscode.workspace.isTrusted) throw new Error('Workspace not trusted.');
        const redactions = await secrets();
        const target = timeline!.store.checkpoints.find((c) => c.id === id);
        if (!target) throw new Error('Unknown checkpoint.');
        const checked = await timeline!.exclusive(() =>
          restore!.review(target, timeline!.store.checkpoints.at(-1)!, state.unsaved)
        );
        selected = id;
        review = {
          token: checked.token,
          checkpoint: id,
          paths: checked.paths,
          conflicts: checked.conflicts
        };
        publish(state);
        publishSelection(id);
        await vscode.commands.executeCommand('scrubline.openPanel');
        return {
          status: 'pending_user_confirmation',
          checkpoint: id,
          changedPaths: checked.paths.map((p) => redact(p, redactions)),
          conflicts: checked.conflicts.map((p) => redact(p, redactions)),
          message: 'Review exact paths and confirm in the Scrubline panel. No files restored.'
        };
      },
      reviewMulti: async (ids, mode, overrides) => {
        if (!vscode.workspace.isTrusted) throw new Error('Workspace not trusted.');
        const redactions = await secrets();
        const cap = Math.min(50, config.get<number>('multiSelectLimit') ?? 20);
        const current = timeline!.store.checkpoints.filter((c) => !c.branch).at(-1)!;
        const composed = await composeCheckpoints(
          timeline!.store.checkpoints,
          current,
          ids,
          mode,
          overrides ?? {},
          cap,
          timeline!.store
        );
        review = undefined;
        selectiveTarget = undefined;
        multiConflicts = [];
        multiAttribution = undefined;
        multiConflicts = composed.conflicts;
        multiAttribution = { kind: 'composed', mode, sources: ids };
        selection = { ids, mode };
        selectiveTarget = composed.target;
        const checked = await timeline!.exclusive(() =>
          restore!.review(composed.target, current, state.unsaved)
        );
        checked.multi = {
          mode,
          sources: ids,
          decisions: composed.decisions,
          warnings: composed.warnings,
          hints: composed.hints,
          blocked: composed.conflicts,
          overrides,
          compositionId: composed.compositionId
        };
        review = checked;
        publish(state);
        await vscode.commands.executeCommand('scrubline.openPanel');
        await renderCombinedPreview(composed.target, ids.length, mode);
        publish(state);
        return {
          status: 'pending_user_confirmation',
          mode,
          sources: ids,
          changedPaths: checked.paths.map((p) => redact(p, redactions)),
          driftConflicts: checked.conflicts.map((p) => redact(p, redactions)),
          compositionConflicts: composed.conflicts.map((p) => redact(p, redactions)),
          decisions: composed.decisions.map((d) => ({
            ...d,
            path: redact(d.path, redactions)
          })),
          warnings: composed.warnings,
          message: 'Review exact paths and confirm in the Scrubline panel. No files restored.'
        };
      }
    });
    const connection = await mcpBridge.start();
    const serverEntry = {
      command: 'node',
      args: [mcpRuntime, '--connection', connection]
    };
    // Register with Antigravity's agent MCP config so the IDE agent sees
    // Scrubline's tools (locks, checkpoints, review) without a manual paste.
    try {
      const configPath = path.join(os.homedir(), '.gemini', 'antigravity', 'mcp_config.json');
      let existing: { mcpServers?: Record<string, unknown> } = {};
      try {
        const raw = await fs.readFile(configPath, 'utf8');
        if (raw.trim()) existing = JSON.parse(raw) as typeof existing;
      } catch {
        existing = {};
      }
      existing.mcpServers = { ...(existing.mcpServers ?? {}), scrubline: serverEntry };
      await fs.mkdir(path.dirname(configPath), { recursive: true });
      await atomicWrite(configPath, Buffer.from(JSON.stringify(existing, null, 2)));
    } catch (e) {
      diagnostics.appendLine(`MCP config registration failed: ${e}`);
    }
    if (showDocument) {
      const document = await vscode.workspace.openTextDocument({
        language: 'json',
        content: JSON.stringify({ mcpServers: { scrubline: serverEntry } }, null, 2)
      });
      await vscode.window.showTextDocument(document);
    }
    return connection;
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('scrubline.startMcp', () => startMcpServer(true)),
    vscode.commands.registerCommand('scrubline.pickAdvisorModel', async () => {
      const config = vscode.workspace.getConfiguration('scrubline');
      let models;
      try {
        models = await listAgyModels({
          agyPath: config.get<string>('agyPath') || undefined,
          log: (line) => diagnostics.appendLine(line)
        });
      } catch (e) {
        void vscode.window.showErrorMessage(
          `Could not list agy CLI models: ${e instanceof Error ? e.message : String(e)}`
        );
        return;
      }
      if (!models.length) {
        void vscode.window.showWarningMessage(
          'The agy CLI returned no models. Run `agy models` in a terminal to check your sign-in. Diagnostics are in the Scrubline output channel.'
        );
        return;
      }
      const pick = await vscode.window.showQuickPick(
        [
          {
            label: '$(sync) CLI default',
            description: 'Let the agy CLI choose the model',
            slug: ''
          },
          ...models.map((m) => ({ label: m.slug, description: m.name, slug: m.slug }))
        ],
        { placeHolder: 'Advisor model shared by the Scrubline chatbot and the agy CLI' }
      );
      if (!pick) return;
      await config.update(
        'advisorModel',
        pick.slug || undefined,
        vscode.ConfigurationTarget.Workspace
      );
      void vscode.window.showInformationMessage(
        pick.slug ? `Advisor model set to ${pick.slug}.` : 'Advisor model reset to the CLI default.'
      );
    }),

    vscode.commands.registerCommand('scrubline.compactHistory', async () => {
      if (!timeline) return;
      const bytes = await timeline.exclusive(() => timeline!.store.compact());
      await vscode.window.showInformationMessage(
        `Removed ${bytes} unused bytes. All checkpoints kept.`
      );
    }),
    vscode.commands.registerCommand('scrubline.deleteHistory', async () => {
      if (!timeline) return;
      const root = timeline.store.root;
      const answer = await vscode.window.showWarningMessage(
        'Delete all Scrubline history for this workspace? Source files stay unchanged. This cannot be undone.',
        { modal: true },
        'Delete history'
      );
      if (answer !== 'Delete history') return;
      shutdownPreview = true;
      cancelRender = true;
      await renderJob?.catch(() => {});
      await previewQueue.catch(() => {});
      await targetSession?.stop();
      await mcpBridge?.stop();
      await runner?.stop();
      await timeline.dispose();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      timeline = undefined;
      restore = undefined;
      alternatives = undefined;
      runner = undefined;
      publish({
        status: 'empty',
        rows: [],
        unsaved: false,
        message: 'History deleted. Reload to start again.'
      });
    }),
    vscode.commands.registerCommand('scrubline.openPanel', () => {
      const panel = vscode.window.createWebviewPanel(
        'scrubline.panel',
        'Scrubline',
        vscode.ViewColumn.Beside,
        { enableScripts: true, retainContextWhenHidden: true }
      );
      const panelView = panel.webview;
      attach(panelView);
      panel.onDidDispose(() => views.delete(panelView));
    }),
    vscode.commands.registerCommand('scrubline.openChatbot', () => {
      vscode.commands.executeCommand('scrubline.openPanel');
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (!event.affectsConfiguration('scrubline', folders[0]?.uri) || !runner || !timeline) return;
      if (refreshPromise) {
        // One settings write can fire this event for more than one scope; coalesce.
        refreshQueued = true;
        return;
      }
      refreshPromise = (async () => {
        do {
          refreshQueued = false;
          refreshing = true;
          cancelLayout = true;
          generation++;
          cancelRender = true;
          await renderJob?.catch(() => {});
          await previewQueue.catch(() => {});
          await runner.stop();
          await targetSession?.stop();
          config = vscode.workspace.getConfiguration('scrubline', folders[0]?.uri);
          runner = new PreviewRunner(
            {
              command: config.get<string>('previewCommand', ''),
              port: config.get<number>('previewPort', 4100),
              timeoutMs: config.get<number>('previewTimeoutSeconds', 15) * 1000,
              browserPath: config.get<string>('chromiumPath') || undefined,
              width: config.get<number>('previewWidth', 960),
              height: config.get<number>('previewHeight', 600),
              route: config.get<string>('previewRoute', '/'),
              readySelector: config.get<string>('previewReadySelector', ''),
              backendCapture: config.get<boolean>('backendCapture', true),
              backendFilter: config.get<string>('backendCaptureFilter', ''),
              backendMaxRequests: config.get<number>('backendMaxRequests', 200)
            },
            timeline.store,
            (message) => {
              preview = { status: 'error', message };
              publish(state);
            },
            (message) => diagnostics.appendLine(message),
            workspaceRoot
          );
          Object.assign(runner.config, await identifyBrowser(runner.config));
          await discoverPages(folders[0].uri.fsPath);
          if (activePage && pages.some((p) => p.route === activePage))
            runner.config.route = activePage;
          else activePage = runner.config.route ?? '/';
          cache = new RenderCache(timeline.store.root, renderKey(runner.config));
          rendered = await cache.available(timeline.store.checkpoints);
          preview = undefined;
          rendering = undefined;
          refreshing = false;
          targeting = { status: 'off' };
          publish(state);
          diagnostics.appendLine(
            'Preview configuration refreshed. History rendering uses the current folder settings.'
          );
        } while (refreshQueued);
        refreshPromise = undefined;
      })();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void start())
  );
  const cleanup = async () => {
    shutdownPreview = true;
    cancelRender = true;
    await timeline?.dispose();
    await renderJob?.catch(() => {});
    await previewQueue.catch(() => {});
    await targetSession?.stop();
    await elementPicker.stop();
    await elementRunner?.stop();
    await mcpBridge?.stop();
    await runner?.stop();
  };
  await start();
  return {
    getTimeline: () => state,
    getStoreRoot: () => timeline?.store.root,
    head: () => timeline?.store.checkpoints.filter((c) => !c.branch).at(-1)?.id,
    prepareRenders: async () => {
      beginRender();
      await renderJob;
    },
    cancelRenders: () => {
      cancelRender = true;
    },
    readCached: async (id: string) => cache?.get(id),
    fork: (id: string, name: string) =>
      timeline!.exclusive(() =>
        alternatives!.fork(
          timeline!.store.checkpoints.find((c) => c.id === id)!,
          name
        )
      ),
    captureBranch: (id: string) => timeline!.exclusive(() => alternatives!.capture(id)),
    previewBranches: async () => {
      const target = [...views][0];
      if (target) await renderBranchPreviews(target);
    },
    reviewFiles: (id: string, paths: string[]) =>
      timeline!.exclusive(async () => {
        const target = timeline!.store.checkpoints.find((c) => c.id === id)!;
        const current = timeline!.store.checkpoints.filter((c) => !c.branch).at(-1)!;
        const merged = mergeFiles(alternatives!.base(target), current, target, paths);
        if (merged.conflicts.length) throw new Error('Conflict');
        return {
          target: merged.target,
          review: await restore!.review(merged.target, current, state.unsaved)
        };
      }),

    capture: () => timeline?.capture('reconcile'),
    review: (id: string) =>
      timeline?.exclusive(() =>
        restore!.review(
          timeline!.store.checkpoints.find((c) => c.id === id)!,
          timeline!.store.checkpoints.at(-1)!,
          state.unsaved
        )
      ),
    apply: (id: string, token: string) =>
      timeline?.exclusive(() =>
        restore!.apply(
          token,
          timeline!.store.checkpoints.find((c) => c.id === id)!,
          state.unsaved
        )
      ),
    reviewMulti: (
      ids: string[],
      mode: 'combine' | 'revert' | 'mosaic',
      overrides: import('./branches/multi').MosaicOverrides = {}
    ) =>
      timeline!.exclusive(async () => {
        const current = timeline!.store.checkpoints.filter((c) => !c.branch).at(-1)!;
        const composed = await composeCheckpoints(
          timeline!.store.checkpoints,
          current,
          ids,
          mode,
          overrides,
          50,
          timeline!.store
        );
        if (composed.conflicts.length)
          return { conflicts: composed.conflicts, decisions: composed.decisions };
        const reviewed = await restore!.review(composed.target, current, state.unsaved);
        return {
          target: composed.target,
          review: reviewed,
          compositionId: composed.compositionId,
          decisions: composed.decisions
        };
      }),
    applyTarget: (
      target: import('./bridge/timeline').Checkpoint,
      token: string,
      attribution?: import('./bridge/timeline').Attribution
    ) =>
      timeline!.exclusive(() =>
        restore!.apply(token, target, state.unsaved, undefined, undefined, attribution)
      ),
    undo: () =>
      timeline?.exclusive(() => restore!.undo(timeline!.store.checkpoints.at(-1)!, state.unsaved)),
    getChatbot: () => chatbotController,
    askChatbot: (query: string, checkpointId?: string, compareId?: string) =>
      chatbotController?.handleQuery(query, checkpointId, compareId)
  };
}
let shutdown: (() => Promise<void>) | undefined;
export async function deactivate() {
  await shutdown?.();
}

function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  hostInfo: HostInfo,
  fullscreen = false
): string {
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.js'));
  const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview.css'));
  const nonce = randomBytes(16).toString('base64');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'nonce-${nonce}' ${webview.cspSource};">
  <link rel="stylesheet" href="${styleUri}">
  <title>Scrubline Panel</title>
  <style>
    body {
      padding: 0;
      margin: 0;
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif);
      color: var(--vscode-foreground, #cccccc);
      background-color: var(--vscode-sideBar-background, var(--vscode-editor-background, #1e1e1e));
      font-size: var(--vscode-font-size, 13px);
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.__SCRUBLINE_FULLSCREEN__ = ${fullscreen};
    window.__SCRUBLINE_HOST_INFO__ = ${JSON.stringify(hostInfo).replace(/</g, '\\u003c')};
  </script>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
// Release module boundary.
