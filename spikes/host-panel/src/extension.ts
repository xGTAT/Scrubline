import * as vscode from 'vscode';
import { randomBytes } from 'crypto';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { RenderCache, renderKey, prepareHistory } from './preview/cache';
import { scopedStore } from './store/identity';
import { Alternatives, mergeFiles } from './branches/alternatives';
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
  let selectiveTarget: import('./bridge/timeline').Checkpoint | undefined;
  let comparison: TimelineState['comparison'];
  let mcpBridge: McpBridge | undefined;
  let targetSession: TargetSession | undefined;
  let targeting: TimelineState['targeting'] = { status: 'off' };
  let cache: RenderCache | undefined;
  let rendered: string[] = [];
  let rendering: TimelineState['rendering'];
  let cancelRender = false;
  let renderJob: Promise<void> | undefined;
  let generation = 0;
  let refreshing = false;
  const diagnostics = vscode.window.createOutputChannel('Scrubline');
  context.subscriptions.push(diagnostics);
  let shutdownPreview = false;
  let fullscreenPanel: vscode.WebviewPanel | undefined;
  const publish = (next: TimelineState) => {
    state = {
      ...next,
      selected,
      rendered,
      rendering,
      preview,
      review,
      canUndo,
      targeting,
      branches: alternatives?.list(),
      comparison
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
  const folders = vscode.workspace.workspaceFolders ?? [];
  let config = vscode.workspace.getConfiguration('scrubline', folders[0]?.uri);
  let timeline: Timeline | undefined;
  let restore: Restore | undefined;
  let runner: PreviewRunner | undefined;
  let selected: string | undefined;
  let previewQueue = Promise.resolve();
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
    const storeRoot = await scopedStore(
      context.storageUri?.fsPath ?? context.globalStorageUri.fsPath,
      root
    );
    timeline = new Timeline(
      root,
      new HistoryStore(storeRoot, config.get<number>('quotaMB', 512) * 1024 * 1024),
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
        browserPath: config.get<string>('chromiumPath') || undefined
      },
      timeline.store,
      (message) => {
        preview = { status: 'error', message };
        publish(state);
      },
      (message) => diagnostics.appendLine(message)
    );
    cache = new RenderCache(storeRoot, renderKey(runner.config));
    publish({ status: 'loading', rows: [], unsaved: false });
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(folders[0], '**/*')
    );
    context.subscriptions.push(
      watcher,
      watcher.onDidCreate(() => timeline?.event('watcher')),
      watcher.onDidChange(() => timeline?.event('watcher')),
      watcher.onDidDelete(() => timeline?.event('watcher'))
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
    if (renderJob || !cache || !runner || !timeline || shutdownPreview || refreshing) return;
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
      const hit = !interactive ? await activeCache.get(id) : undefined;
      if (hit) {
        await activeRunner.stop();
        if (selected === id && token === generation) {
          preview = {
            status: 'ready',
            checkpoint: id,
            image: view.asWebviewUri(vscode.Uri.file(hit)).toString(),
            label: 'Cached screenshot',
            regions: await activeCache.regions(id)
          };
          const next =
            timeline?.store.checkpoints[
              timeline.store.checkpoints.findIndex((c) => c.id === id) + 1
            ];
          const nextImage = next ? await activeCache.get(next.id) : undefined;
          if (nextImage) preview.preload = view.asWebviewUri(vscode.Uri.file(nextImage)).toString();
          const before =
            timeline?.store.checkpoints[
              timeline.store.checkpoints.findIndex((c) => c.id === id) - 1
            ];
          const previousImage = before ? await activeCache.get(before.id) : undefined;
          if (previousImage)
            preview.preloadPrevious = view.asWebviewUri(vscode.Uri.file(previousImage)).toString();
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
        let image = result.url ? result.screenshot : undefined;
        if (token !== generation) {
          await activeRunner.stop();
          return;
        }
        if (image) {
          image = await activeCache.put(id, image);
          if (!rendered.includes(id)) rendered.push(id);
        }
        if (!interactive) await activeRunner.stop();
        if (selected !== id || token !== generation) return;
        preview = {
          status: image || (interactive && result.url) ? 'ready' : 'error',
          checkpoint: id,
          url: interactive ? result.url : undefined,
          label: interactive ? result.label : 'Cached screenshot',
          image: image ? view.asWebviewUri(vscode.Uri.file(image)).toString() : undefined,
          regions: image ? await activeCache.regions(id) : [],
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
      const work = previewQueue.catch(() => {}).then(() => showPreview(id, interactive));
      previewQueue = work.catch(() => {});
      return work;
    };
    const listener = view.onDidReceiveMessage(async (message: TimelineInbound) => {
      try {
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
        if (message.type === 'request-timeline') {
          void view.postMessage({ type: 'timeline', data: state });
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
          await targetSession.start(preview.url, redactions);
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
          selectiveTarget = undefined;
          await timeline.exclusive(async () => {
            review = await restore!.review(
              target,
              timeline!.store.checkpoints.at(-1)!,
              state.unsaved
            );
          });
          publish(state);
        }
        if (message.type === 'apply-reviewed' && (target || selectiveTarget?.id === message.id)) {
          const applying = selectiveTarget?.id === message.id ? selectiveTarget : target!;
          await timeline.exclusive(async () => {
            if (selectiveTarget?.id === message.id)
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
        if (message.type === 'open-diff' && target && safePath(message.path)) {
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
          review = {
            token: checked.token,
            checkpoint: id,
            paths: checked.paths,
            conflicts: checked.conflicts
          };
          publish(state);
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
                args: [
                  path.join(context.extensionPath, 'dist', 'mcp.js'),
                  '--connection',
                  connection
                ]
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
    vscode.workspace.onDidChangeConfiguration(async (event) => {
      if (!event.affectsConfiguration('scrubline', folders[0]?.uri) || !runner || !timeline) return;
      refreshing = true;
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
          browserPath: config.get<string>('chromiumPath') || undefined
        },
        timeline.store,
        undefined,
        (message) => diagnostics.appendLine(message)
      );
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
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => void start())
  );
  await start();
  shutdown = async () => {
    shutdownPreview = true;
    cancelRender = true;
    await timeline?.dispose();
    await renderJob?.catch(() => {});
    await previewQueue.catch(() => {});
    await targetSession?.stop();
    await mcpBridge?.stop();
    await runner?.stop();
  };
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
