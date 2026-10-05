import { spawn, type ChildProcess } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
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
    readonly onExit?: (message: string) => void
  ) {}
  async start(workspace: string, trusted: boolean) {
    if (!trusted) throw new Error('Trust workspace before preview.');
    if (!this.config.command.trim()) throw new Error('Set a preview command in Settings.');
    if (!Number.isInteger(this.config.port) || this.config.port < 1024 || this.config.port > 65535)
      throw new Error('Choose a preview port from 1024 to 65535.');
    await this.stop();
    this.stopped = false;
    await portAvailable(this.config.port);
    const command = this.config.command.replaceAll('{port}', String(this.config.port));
    this.lastExit = undefined;
    this.process = spawn(command, {
      cwd: workspace,
      shell: true,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: 'ignore',
      env: { ...process.env, PORT: String(this.config.port) }
    });
    let exited = false;
    this.process.once('exit', () => {
      exited = true;
      this.live = false;
      this.lastExit = 'Preview process exited.';
      if (!this.stopped) this.onExit?.(this.lastExit);
    });
    this.process.once('error', () => {
      exited = true;
    });
    const url = `http://127.0.0.1:${this.config.port}`;
    const deadline = Date.now() + this.config.timeoutMs;
    try {
      while (Date.now() < deadline) {
        if (this.stopped || exited) throw new Error('Preview process exited. Check command.');
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
  async historical(c: Checkpoint, trusted: boolean): Promise<PreviewResult> {
    if (!trusted) throw new Error('Trust workspace before preview.');
    const screenshots = path.join(this.store.root, 'screenshots');
    const image = path.join(screenshots, `${c.id}.png`);
    const temp = path.join(this.store.root, 'previews', randomUUID());
    await this.stop();
    await this.store.materialize(c, temp);
    try {
      const url = await this.start(temp, trusted);
      this.temp = temp;
      let screenshot: string | undefined;
      try {
        await this.screenshot(url, image);
        screenshot = image;
      } catch {
        /* Rendering works even if optional browser is unavailable. */
      }
      return {
        checkpoint: c.id,
        url,
        screenshot,
        label: 'Isolated preview',
        ...(!screenshot ? { error: 'Screenshot unavailable. Configure Chromium.' } : {})
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
      await page.goto(url, { waitUntil: 'networkidle', timeout: this.config.timeoutMs });
      await atomicWrite(destination, await page.screenshot());
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
    if (this.temp) {
      await fs.rm(this.temp, { recursive: true, force: true });
      this.temp = undefined;
    }
  }
}
