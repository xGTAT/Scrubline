import { checkGeometry } from '../layout/collect';
import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Checkpoint } from '../bridge/timeline';
import { specification, specificationKey } from './spec';
import { readReceipt } from './receipt';
import type { RenderReceipt } from '../evidence/types';
import { hashBytes, HistoryStore, atomicWrite } from '../store/store';
import { createCapture } from '../backend/capture';
export interface PreviewConfig {
  command: string;
  port: number;
  timeoutMs: number;
  browserPath?: string;
  browserIdentity?: string;
  width?: number;
  height?: number;
  route?: string;
  readySelector?: string;
  guard?: import('../layout/types').LayoutGuard;
  /** Metadata-only backend capture during renders; default on. */
  backendCapture?: boolean;
  /** Optional glob limiting captured request URLs, e.g. star-star/api/star-star. */
  backendFilter?: string;
  backendMaxRequests?: number;
}
export interface PreviewResult {
  checkpoint: string;
  url?: string;
  screenshot?: string;
  label: 'Isolated preview' | 'Screenshot';
  error?: string;
  receipt?: RenderReceipt;
}
async function portAvailable(port: number) {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error('Preview port busy. Choose another port.')));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve()));
  });
}
export class PreviewRunner {
  private process?: ChildProcess;
  private temp?: string;
  private stopped = false;
  private live = false;
  private origin?: string;
  private lastExit?: string;
  constructor(
    readonly config: PreviewConfig,
    readonly store: HistoryStore,
    readonly onExit?: (message: string) => void,
    readonly diagnostic?: (message: string) => void,
    readonly workspaceRoot?: string
  ) {}
  async start(workspace: string, trusted: boolean) {
    specification(this.config);
    if (!trusted) throw new Error('Trust workspace before preview.');
    if (!this.config.command.trim()) throw new Error('Set a preview command in Settings.');
    if (!Number.isInteger(this.config.port) || this.config.port < 1024 || this.config.port > 65535)
      throw new Error('Choose a preview port from 1024 to 65535.');
    await this.stop();
    await fs.access(workspace);
    this.stopped = false;
    await portAvailable(this.config.port);
    const command = this.config.command.replaceAll('{port}', String(this.config.port));
    this.lastExit = undefined;
    this.process = spawn(command, {
      cwd: workspace,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PORT: String(this.config.port) }
    });
    let exited = false;
    let stderr = '';
    let lastProbeError = '';
    // Dev servers may ignore the injected port when the npm script hardcodes
    // its own (e.g. "ng serve --port 4200"). Watch stdout for the actual
    // listening URL so we probe the right port.
    let detectedPort: number | undefined;
    const portPattern =
      /(?:Local|local|localhost|listening|Listening|running|Running|started|Started)\s*(?:at|on|At|On)?\s*[: ]*\s*https?:\/\/(?:localhost|127\.0\.0\.1|\[?::1\]?):(\d+)/;
    const detectPort = (data: Buffer) => {
      if (detectedPort) return;
      const match = data.toString().match(portPattern);
      if (match) {
        const p = parseInt(match[1], 10);
        if (p >= 1024 && p <= 65535) detectedPort = p;
      }
    };
    this.process.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2048);
      detectPort(data);
    });
    this.process.stdout?.on('data', (data: Buffer) => {
      stderr = (stderr + '[out] ' + data.toString()).slice(-2048);
      detectPort(data);
    });
    this.process.once('exit', (code, signal) => {
      exited = true;
      this.live = false;
      this.lastExit = `Preview process exited (${code ?? signal ?? 'unknown'}). Check command and Scrubline output.`;
      if (!this.stopped) this.diagnostic?.(`${this.lastExit}\n${stderr.trim()}`);
      if (!this.stopped) this.onExit?.(this.lastExit);
    });
    this.process.once('error', (e) => {
      this.lastExit = 'Preview launch failed. Check command and Scrubline output.';
      this.diagnostic?.(`${this.lastExit} ${e.message}; cwd length ${workspace.length}`);
      exited = true;
    });
    // Dev servers may bind only IPv6 (::1) or only IPv4 (127.0.0.1) for
    // "localhost"; probe both stacks and keep the one that answers. When the
    // server reports a different port than configured (hardcoded in the npm
    // script), probe the detected port too.
    const probePort = () => detectedPort ?? this.config.port;
    const candidates = () => [`http://127.0.0.1:${probePort()}`, `http://[::1]:${probePort()}`];
    const deadline = Date.now() + this.config.timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (this.stopped || exited)
          throw new Error(this.lastExit ?? 'Preview process exited. Check command.');
        for (const candidate of candidates()) {
          try {
            const response = await fetch(candidate, { signal: AbortSignal.timeout(500) });
            if (response.ok) {
              this.live = true;
              this.origin = candidate;
              return candidate;
            }
          } catch (probeError) {
            lastProbeError =
              probeError instanceof Error
                ? `${probeError.message} ${(probeError.cause as Error)?.message ?? ''}`.trim()
                : String(probeError);
          }
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(
        `Preview startup timed out. Check command. Debug: ${stderr.trim().slice(-400)} | probe: ${lastProbeError}`
      );
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  /** Find the directory containing package.json within a snapshot, checking
   * the root first, then one level of subdirectories (monorepo/workspace
   * layouts where VS Code opens the parent of the project). Returns the
   * absolute path to the project root, or the snapshot root if no
   * package.json exists anywhere. */
  private async findProjectRoot(snapshotRoot: string): Promise<string> {
    try {
      await fs.access(path.join(snapshotRoot, 'package.json'));
      return snapshotRoot;
    } catch {
      // Not at root; check one level down.
    }
    try {
      const entries = await fs.readdir(snapshotRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const candidate = path.join(snapshotRoot, entry.name, 'package.json');
        try {
          await fs.access(candidate);
          return path.join(snapshotRoot, entry.name);
        } catch {
          // Not this subdirectory.
        }
      }
    } catch {
      // Cannot read snapshot root.
    }
    return snapshotRoot;
  }

  async historical(
    c: Checkpoint,
    trusted: boolean,
    screenshotDirectory = 'screenshots'
  ): Promise<PreviewResult> {
    if (!trusted) throw new Error('Trust workspace before preview.');
    const spec = specification(this.config);
    const key = specificationKey(this.config);
    const screenshots = path.join(this.store.root, screenshotDirectory, key);
    await fs.mkdir(screenshots, { recursive: true });
    const image = path.join(screenshots, `${c.id}.png`);
    await this.stop();
    // Windows child processes cannot reliably start in deep VS Code storage paths.
    // Snapshot/cache stay bound; disposable working copies use a short private temp root.
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-preview-'));
    try {
      await this.store.materialize(c, temp);
      const projectRoot = await this.findProjectRoot(temp);
      // The snapshot mirrors the workspace layout: if the project is in a
      // subdirectory, the same relative path applies to the workspace.
      const relProject = path.relative(temp, projectRoot);
      const wsProjectRoot = relProject
        ? path.join(this.workspaceRoot ?? '', relProject)
        : this.workspaceRoot;
      await this.linkWorkspaceDeps(projectRoot, wsProjectRoot);
      const origin = await this.start(projectRoot, trusted);
      const url = new URL(spec.route, origin).toString();
      this.temp = temp;
      let screenshot: string | undefined;
      let screenshotError: string | undefined;
      try {
        await this.screenshot(url, image, c);
        screenshot = image;
      } catch (error) {
        screenshotError = error instanceof Error ? error.message : String(error);
        this.diagnostic?.(`[checkpoint ${c.id}] Screenshot failed: ${screenshotError}`);
      }
      return {
        checkpoint: c.id,
        url,
        screenshot,
        label: 'Isolated preview',
        receipt: screenshot ? await readReceipt(image, c.id, key) : undefined,
        ...(!screenshot
          ? { error: `Screenshot unavailable: ${screenshotError ?? 'Configure Chromium.'}` }
          : {})
      };
    } catch (e) {
      await fs.rm(temp, { recursive: true, force: true });
      const root = path.join(this.store.root, screenshotDirectory);
      const candidates = [image, path.join(root, `${c.id}.png`)];
      for (const directory of await fs.readdir(root).catch(() => [])) {
        if (/^[a-f0-9]{64}$/.test(directory))
          candidates.push(path.join(root, directory, `${c.id}.png`));
      }
      for (const candidate of candidates) {
        try {
          await fs.access(candidate);
          return {
            checkpoint: c.id,
            screenshot: candidate,
            label: 'Screenshot',
            receipt: await readReceipt(candidate, c.id),
            error:
              'Historical command unavailable. Screenshot only; original render specification may differ.'
          } as PreviewResult;
        } catch {
          /* Try preserved evidence, never claim a new render. */
        }
      }
      throw e;
    }
  }
  /**
   * Framework previews: a snapshot carries package.json but never node_modules
   * (the scanner excludes it), so dev-server commands cannot run in it. Link the
   * live workspace's node_modules into the snapshot when both exist. Static
   * snapshots (no package.json) and missing workspace installs are skipped.
   * Caveat: linked dependencies are the workspace's current install, not the
   * checkpoint's lockfile; the preview is visually, not byte, faithful there.
   */
  private async linkWorkspaceDeps(projectRoot: string, workspaceProjectRoot?: string) {
    const wsRoot = workspaceProjectRoot ?? this.workspaceRoot;
    if (!wsRoot) return;
    try {
      await fs.access(path.join(projectRoot, 'package.json'));
    } catch {
      return;
    }
    const source = path.join(wsRoot, 'node_modules');
    const target = path.join(projectRoot, 'node_modules');
    try {
      await fs.access(source);
      await fs.symlink(source, target, process.platform === 'win32' ? 'junction' : 'dir');
      this.diagnostic?.('Linked workspace dependencies into the snapshot.');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (msg.includes('ENOENT')) {
        this.diagnostic?.(
          `Dependencies not installed in ${wsRoot}. Run npm install (or npm ci) there, then retry the preview.`
        );
      } else {
        this.diagnostic?.(`No workspace dependency link: ${msg}`);
      }
    }
  }
  async screenshot(url: string, destination: string, checkpoint?: Checkpoint) {
    const spec = specification(this.config);
    if (!this.config.browserPath) throw new Error('Set a Chromium path for screenshots.');
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath: this.config.browserPath,
      headless: true,
      args: ['--disable-gpu']
    });
    try {
      const page = await browser.newPage({ viewport: { width: spec.width, height: spec.height } });
      const collector =
        this.config.backendCapture === false
          ? undefined
          : createCapture({
              filter: this.config.backendFilter,
              maxEntries: this.config.backendMaxRequests
            });
      collector?.attach(page);
      // Server startup and browser rendering have separate budgets.
      const renderTimeout = Math.max(this.config.timeoutMs, 15000);
      const renderStart = Date.now();
      await page.goto(url, { waitUntil: 'networkidle', timeout: renderTimeout });
      if (new URL(page.url()).origin !== new URL(url).origin)
        throw new Error('Preview redirected off origin.');
      if (spec.readySelector && (await page.locator(spec.readySelector).count()) > 1)
        throw new Error('Readiness selector is ambiguous.');
      if (spec.readySelector)
        await page
          .locator(spec.readySelector)
          .waitFor({ state: 'visible', timeout: renderTimeout });
      await page.evaluate(() => document.fonts.ready);
      const regions = await page.evaluate(({ width, height }) => {
        const selector = 'h1,h2,h3,h4,h5,h6,p,button,a,img,input,li,label,svg,canvas,video';
        const nodes = [...document.body.querySelectorAll(selector)].slice(0, 1000);
        const ids = new Map<string, number>();
        for (const node of document.querySelectorAll('[id]'))
          ids.set(node.id, (ids.get(node.id) ?? 0) + 1);
        const identity = (e: Element) => {
          if (e.id && ids.get(e.id) === 1) return e.id;
          const label = e.getAttribute('aria-label');
          if (
            label &&
            nodes.filter((n) => n.tagName === e.tagName && n.getAttribute('aria-label') === label)
              .length === 1
          )
            return `${e.tagName}:label:${label.split('').reduce((hash, ch) => ((hash << 5) - hash + ch.charCodeAt(0)) | 0, 0)}`;
          const parts: string[] = [];
          let node: Element | null = e;
          while (node && node !== document.body) {
            const siblings = node.parentElement
              ? [...node.parentElement.children].filter((n) => n.tagName === node!.tagName)
              : [node];
            parts.unshift(`${node.tagName.toLowerCase()}:${siblings.indexOf(node)}`);
            node = node.parentElement;
          }
          return parts.join('/');
        };
        return nodes
          .map((e) => {
            const rect = e.getBoundingClientRect();
            const style = getComputedStyle(e);
            if (
              style.visibility === 'hidden' ||
              style.display === 'none' ||
              Number(style.opacity) === 0
            )
              return null;
            // Hash appearance and markup. Never store text, input values, URLs or markup.
            const text = `${e.innerHTML}|${style.color}|${style.backgroundColor}|${style.fontSize}|${style.borderColor}`;
            let hash = 0;
            for (let i = 0; i < text.length; i++)
              hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
            const x = Math.max(0, rect.x),
              y = Math.max(0, rect.y);
            return {
              key: identity(e),
              signature: String(hash),
              x,
              y,
              width: Math.min(rect.right, width) - x,
              height: Math.min(rect.bottom, height) - y
            };
          })
          .filter((r) => r && r.width > 0 && r.height > 0);
      }, spec);
      if (this.config.guard && checkpoint) {
        const result = await checkGeometry(page, this.config.guard);
        await atomicWrite(
          `${destination}.layout.json`,
          JSON.stringify({
            version: 1,
            checkpoint: checkpoint.id,
            specification: specificationKey(this.config),
            guard: this.config.guard,
            ...result
          })
        );
      }
      const renderMs = Date.now() - renderStart;
      const image = await page.screenshot({ timeout: renderTimeout });
      const geometry = JSON.stringify(regions);
      await atomicWrite(destination, image);
      await atomicWrite(`${destination}.json`, geometry);
      if (collector && checkpoint) {
        await collector.finish();
        await atomicWrite(
          `${destination}.backend.json`,
          JSON.stringify(collector.build(checkpoint.id, specificationKey(this.config), url))
        );
      }
      if (checkpoint) {
        const receipt: RenderReceipt = {
          version: 1,
          checkpoint: checkpoint.id,
          specification: specificationKey(this.config),
          source: hashBytes(JSON.stringify(checkpoint.files)),
          lockfiles: checkpoint.files
            .filter((f) =>
              /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?)$/.test(f.path)
            )
            .map((f) => ({ path: f.path, hash: f.hash })),
          browserVersion: browser.version(),
          browserIdentity: this.config.browserIdentity ?? 'unverified',
          runtime: process.version,
          platform: process.platform,
          viewport: { width: spec.width, height: spec.height },
          routeIdentity: hashBytes(spec.route),
          commandIdentity: hashBytes(this.config.command),
          capturedAt: new Date().toISOString(),
          imageHash: hashBytes(image),
          geometryHash: hashBytes(geometry),
          dependencies: 'tracked-source-only',
          repeatability: 'not-rechecked'
        };
        await atomicWrite(`${destination}.receipt.json`, JSON.stringify(receipt));
        // Render time is measured, not content-derived, so it lives in a
        // sidecar (render-timings.json), never in the immutable manifest.
        await this.store.recordRenderTiming(checkpoint.id, renderMs);
      }
    } finally {
      await browser.close();
    }
  }
  status() {
    return this.lastExit;
  }
  async checkpointScreenshot(c: Checkpoint) {
    if (!this.live) return;
    await this.screenshot(
      new URL(
        specification(this.config).route,
        this.origin ?? `http://127.0.0.1:${this.config.port}`
      ).toString(),
      path.join(this.store.root, 'screenshots', specificationKey(this.config), `${c.id}.png`),
      c
    );
  }
  async stop() {
    this.stopped = true;
    this.live = false;
    const child = this.process;
    this.process = undefined;
    const exited =
      child && child.exitCode === null && child.signalCode === null
        ? new Promise<void>((resolve) => {
            child.once('close', () => resolve());
          })
        : Promise.resolve();
    if (child?.pid) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          const kill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore'
          });
          kill.once('exit', () => resolve());
          kill.once('error', () => resolve());
        });
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          /* Already stopped. */
        }
        await new Promise((r) => setTimeout(r, 100));
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          /* Already stopped. */
        }
      }
    }
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000);
        timer.unref();
      })
    ]);
    if (this.temp) {
      // Windows may release descendant cwd handles after taskkill itself exits.
      // Bounded retry handles that OS cleanup lag; a persistent lock is still surfaced.
      await fs.rm(this.temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      this.temp = undefined;
    }
  }
}
// Preview lifecycle ends only after bounded process and directory cleanup.
