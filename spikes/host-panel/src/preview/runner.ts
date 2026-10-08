import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { Checkpoint } from '../bridge/timeline';
import { HistoryStore, atomicWrite } from '../store/store';
export interface PreviewConfig {
  command: string;
  port: number;
  timeoutMs: number;
  browserPath?: string;
}
export interface PreviewResult {
  checkpoint: string;
  url?: string;
  screenshot?: string;
  label: 'Isolated preview' | 'Screenshot';
  error?: string;
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
  private lastExit?: string;
  constructor(
    readonly config: PreviewConfig,
    readonly store: HistoryStore,
    readonly onExit?: (message: string) => void,
    readonly diagnostic?: (message: string) => void
  ) {}
  async start(workspace: string, trusted: boolean) {
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
      stdio: ['ignore', 'ignore', 'pipe'],
      env: { ...process.env, PORT: String(this.config.port) }
    });
    let exited = false;
    let stderr = '';
    this.process.stderr?.on('data', (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2048);
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
    const url = `http://127.0.0.1:${this.config.port}`;
    const deadline = Date.now() + this.config.timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (this.stopped || exited)
          throw new Error(this.lastExit ?? 'Preview process exited. Check command.');
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(500) });
          if (response.ok) {
            this.live = true;
            return url;
          }
        } catch {
          /* Startup not ready. */
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error('Preview startup timed out. Check command.');
    } catch (e) {
      await this.stop();
      throw e;
    }
  }
  async historical(
    c: Checkpoint,
    trusted: boolean,
    screenshotDirectory = 'screenshots'
  ): Promise<PreviewResult> {
    if (!trusted) throw new Error('Trust workspace before preview.');
    const screenshots = path.join(this.store.root, screenshotDirectory);
    await fs.mkdir(screenshots, { recursive: true });
    const image = path.join(screenshots, `${c.id}.png`);
    await this.stop();
    // Windows child processes cannot reliably start in deep VS Code storage paths.
    // Snapshot/cache stay bound; disposable working copies use a short private temp root.
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'scrubline-preview-'));
    try {
      await this.store.materialize(c, temp);
      const url = await this.start(temp, trusted);
      this.temp = temp;
      let screenshot: string | undefined;
      let screenshotError: string | undefined;
      try {
        await this.screenshot(url, image);
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
        ...(!screenshot
          ? { error: `Screenshot unavailable: ${screenshotError ?? 'Configure Chromium.'}` }
          : {})
      };
    } catch (e) {
      await fs.rm(temp, { recursive: true, force: true });
      try {
        await fs.access(image);
        return {
          checkpoint: c.id,
          screenshot: image,
          label: 'Screenshot',
          error: 'Historical command unavailable. Screenshot only.'
        };
      } catch {
        throw e;
      }
    }
  }
  async screenshot(url: string, destination: string) {
    if (!this.config.browserPath) throw new Error('Set a Chromium path for screenshots.');
    const { chromium } = await import('playwright-core');
    const browser = await chromium.launch({
      executablePath: this.config.browserPath,
      headless: true,
      args: ['--disable-gpu']
    });
    try {
      const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
      // Server startup and browser rendering have separate budgets.
      const renderTimeout = Math.max(this.config.timeoutMs, 15000);
      await page.goto(url, { waitUntil: 'networkidle', timeout: renderTimeout });
      await page.evaluate(() => document.fonts.ready);
      const regions = await page.evaluate(() => {
        const nodes = [...document.body.querySelectorAll('*')]
          .filter((e) =>
            ['H1', 'H2', 'H3', 'P', 'BUTTON', 'IMG', 'INPUT', 'LI', 'LABEL'].includes(e.tagName)
          )
          .slice(0, 300);
        return nodes
          .map((e, index) => {
            const rect = e.getBoundingClientRect();
            const style = getComputedStyle(e);
            // Store only a signature, never page text or input values in motion metadata.
            const text = `${e.textContent}|${style.color}|${style.backgroundColor}|${style.fontSize}`;
            let hash = 0;
            for (let i = 0; i < text.length; i++)
              hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
            const x = Math.max(0, rect.x),
              y = Math.max(0, rect.y);
            return {
              key: e.id || `${e.tagName}:${index}`,
              signature: String(hash),
              x,
              y,
              width: Math.min(rect.right, 960) - x,
              height: Math.min(rect.bottom, 600) - y
            };
          })
          .filter((r) => r.width > 0 && r.height > 0);
      });
      await atomicWrite(destination, await page.screenshot({ timeout: renderTimeout }));
      await atomicWrite(`${destination}.json`, Buffer.from(JSON.stringify(regions)));
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
      `http://127.0.0.1:${this.config.port}`,
      path.join(this.store.root, 'screenshots', `${c.id}.png`)
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
