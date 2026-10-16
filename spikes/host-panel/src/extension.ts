import { replaceActivation } from './lifecycle';
import { ElementPicker } from './branches/picker';
import { elementCandidate } from './branches/element';
import {
  frameworkElementCandidate,
  resolveTrackedSource,
  resolveViaSourceMap
} from './branches/framework';
import { installMcpRuntime } from './mcp/install';
import { measuredPacket } from './targeting/measured';
import { specification, specificationKey } from './preview/spec';
import { listPages, routeToDocument, isPickableDocument } from './pages';
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
import * as fs from 'node:fs/promises';
import { RenderCache, renderKey, prepareHistory } from './preview/cache';
import { scopedStore } from './store/identity';
import { Alternatives, mainlineBase, mergeFiles } from './branches/alternatives';
import { changedPaths } from './capture/scanner';
import { applySelective } from './branches/apply';
import { staticNavbarPaths } from './branches/static-mapping';
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
  let state: TimelineState = {
    status: 'empty',
    rows: [],
    unsaved: false,
    message: 'Open a folder to begin.'
  };
  let preview: TimelineState['preview'];
  let review: TimelineState['review'];
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
  let comparison: TimelineState['comparison'];
  let mcpBridge: McpBridge | undefined;
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
    state = {
      ...next,
      rows: [
        ...next.rows.filter(
          (row) => !timeline?.store.checkpoints.some((c) => c.id === row.id && c.branch)
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
      canUndo,
      targeting,
      branches: alternatives?.list(),
      comparison,
      pages,
      activePage
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
  let config = vscode.workspace.getConfiguration('scrubline', folders[0]?.uri);
  let timeline: Timeline | undefined;
  let restore: Restore | undefined;
  let runner: PreviewRunner | undefined;
  let selected: string | undefined;
  let pages: import('./pages').PageInfo[] = [];
  let activePage: string | undefined;
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
    diagnostics.appendLine(
      `Scrubline ${context.extension.packageJSON.version}: starting writer in PID ${process.pid}.`
    );
    const storeRoot = await scopedStore(
      context.storageUri?.fsPath ?? context.globalStorageUri.fsPath,
      root
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
        readySelector: config.get<string>('previewReadySelector', '')
      },
      timeline.store,
      (message) => {
        preview = { status: 'error', message };
        publish(state);
      },
      (message) => diagnostics.appendLine(message)
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
    const checkpoints = timeline!.store.checkpoints.filter((c) => !c.branch);
    const activeCache = cache!;
    const background = new PreviewRunner(
      { ...runner!.config, port: runner!.config.port + 3 },
      timeline!.store,
      undefined,
      (message) => diagnostics.appendLine(message)
    );
    renderJob = (async () => {
      try {
        await prepareHistory(
          checkpoints,
          activeCache,
          async (c) => {
            const r = await background.historical(c, true, 'prerender-screenshots');
            if (!r.screenshot || !r.url) throw new Error(r.error ?? 'Screenshot unavailable.');
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
            void vscode.window.showWarningMessage(
              'Capture a checkpoint before opening fullscreen.'
            );
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
                    (text) => diagnostics.appendLine(text)
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
          activePage = page.route;
          void context.workspaceState.update('scrubline.activePage', page.route);
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
          activePage = route;
          void context.workspaceState.update('scrubline.activePage', route);
          publish(state);
          if (selected) await enqueuePreview(selected);
          return;
        }
        if (!timeline || !restore || !vscode.workspace.isTrusted) return;
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
          publish(state);
          await enqueuePreview(target.id);
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
            (message) => diagnostics.appendLine(message)
          );
          const b = new PreviewRunner(
            { ...runner.config, port: runner.config.port + 2 },
            timeline.store,
            undefined,
            (message) => diagnostics.appendLine(message)
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
        if (message.type === 'pick-element' && target) {
          if (!runner || !vscode.workspace.isTrusted) throw new Error('Trusted preview required.');
          await elementPicker.stop();
          await elementRunner?.stop();
          const pickedSource = target;
          const pickedRunner = new PreviewRunner(
            { ...runner.config, port: runner.config.port + 7 },
            timeline.store
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
            async (indices, framework) => {
              try {
                const current = timeline!.store.checkpoints.filter((c) => !c.branch).at(-1)!;
                let candidate;
                let note: string;
                if (isPickableDocument(document, pickedSource.files)) {
                  candidate = await elementCandidate(
                    timeline!.store,
                    pickedSource,
                    current,
                    document,
                    '',
                    indices
                  );
                  note =
                    'Element content, inline styles and paired exclusive CSS only. Shared styles and unmatched rules stay current; this may differ from the historical appearance.';
                } else {
                  if (!framework || framework.frames.length === 0)
                    throw new Error(
                      'This page has no tracked static HTML source and exposes no React development source metadata (production build or non-React framework).'
                    );
                  const frame = framework.frames[0];
                  let resolved;
                  if (!resolveTrackedSource(frame.fileName, pickedSource.files)) {
                    resolved = await resolveViaSourceMap(frame);
                    if (!resolved)
                      throw new Error(
                        'No source map or matching original source found for the picked element.'
                      );
                  }
                  candidate = await frameworkElementCandidate(
                    timeline!.store,
                    pickedSource,
                    current,
                    { frame, tag: framework.tag, resolved }
                  );
                  note =
                    'JSX element subtree only (content, props, inline styles). External CSS and component internals stay current.';
                }
                review = await timeline!.exclusive(() =>
                  restore!.review(candidate, current, state.unsaved)
                );
                review.note = note;
                selectiveTarget = candidate;
                selected = pickedSource.id;
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
            !target.files.some((f) => f.path.endsWith('.html'))
          ) {
            await reviewFilesFallback(target, 'No tracked HTML document on this page.');
            return;
          }
          const document =
            message.document ||
            (activeDocument && target.files.some((f) => f.path === activeDocument)
              ? activeDocument
              : await vscode.window.showQuickPick(
                  target.files.filter((f) => f.path.endsWith('.html')).map((f) => f.path),
                  { placeHolder: 'Plain HTML document' }
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
          const candidate = await elementCandidate(
            timeline.store,
            target,
            current,
            document,
            element
          );
          review = await timeline.exclusive(() =>
            restore!.review(candidate, current, state.unsaved)
          );
          review.note =
            'Element content, inline styles and paired exclusive CSS only. Shared styles and unmatched rules stay current; this may differ from the historical appearance.';
          selectiveTarget = candidate;
          selected = target.id;
          publish(state);
          return;
        }
        if (
          (message.type === 'review-selective' || message.type === 'review-navbar') &&
          target &&
          alternatives
        ) {
          let document = message.type === 'review-navbar' ? message.document : '';
          if (message.type === 'review-navbar' && !document) {
            const picked = await vscode.window.showQuickPick(
              target.files.filter((f) => f.path.endsWith('.html')).map((f) => f.path),
              { placeHolder: 'Standalone navbar document' }
            );
            if (!picked) return;
            document = picked;
          }
          let paths =
            message.type === 'review-navbar'
              ? await staticNavbarPaths(timeline.store, target, document)
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
          if (message.type === 'review-navbar') {
            await staticNavbarPaths(timeline.store, alternatives.base(target), document);
            await staticNavbarPaths(timeline.store, current, document);
          }
          review = undefined;
          selectiveTarget = undefined;
          const merged = mergeFiles(alternatives.base(target), current, target, paths);
          if (merged.conflicts.length)
            throw new Error('Both sides changed. Selective apply blocked.');
          selectiveTarget = merged.target;
          review = await timeline.exclusive(() =>
            restore!.review(selectiveTarget!, current, state.unsaved)
          );
          publish(state);
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
            (selection, crop) => {
              const packet = makePacket(cp, previous, selection, redactions);
              targeting = {
                status: 'ready',
                packet: packet.body,
                summary: packet.summary,
                crop: crop ? view.asWebviewUri(vscode.Uri.file(crop)).toString() : undefined
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
            } else if (selectiveTarget?.id === message.id)
              await applySelective(
                restore!,
                applying,
                message.token,
                state.unsaved,
                config.get<string>('postApplyCommand') ?? '',
                () => state.unsaved
              );
            else await restore!.apply(message.token, applying, state.unsaved);
          });
          review = undefined;
          selectiveTarget = undefined;
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
      } catch (e) {
        if (message.type === 'apply-reviewed') {
          review = undefined;
          selectiveTarget = undefined;
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
        publish({
          ...state,
          status: 'error',
          message: e instanceof Error ? e.message : 'Action failed.'
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
  context.subscriptions.push(
    vscode.commands.registerCommand('scrubline.startMcp', async () => {
      if (!timeline || !restore || !vscode.workspace.isTrusted)
        throw new Error('Open one trusted local workspace first.');
      await mcpBridge?.stop();
      mcpBridge = new McpBridge(timeline.store.root, {
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
        }
      });
      const connection = await mcpBridge.start();
      const document = await vscode.workspace.openTextDocument({
        language: 'json',
        content: JSON.stringify(
          {
            mcpServers: {
              scrubline: {
                command: 'node',
                args: [mcpRuntime, '--connection', connection]
              }
            }
          },
          null,
          2
        )
      });
      await vscode.window.showTextDocument(document);
      return connection;
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
              readySelector: config.get<string>('previewReadySelector', '')
            },
            timeline.store,
            (message) => {
              preview = { status: 'error', message };
              publish(state);
            },
            (message) => diagnostics.appendLine(message)
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
    undo: () =>
      timeline?.exclusive(() => restore!.undo(timeline!.store.checkpoints.at(-1)!, state.unsaved))
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
